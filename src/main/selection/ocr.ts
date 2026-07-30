import { nativeImage } from 'electron'
import { createWorker, type Worker } from 'tesseract.js'
import type { AnyLanguage, Rect, Word } from '@shared/types'
import { getOcrLangCode } from '@shared/languages'
import { HOVER_WORD_ATOM_PATTERN } from '@shared/wordTokenize'
import { segmentChineseWords } from '../nlp/chinese'
import { segmentJapaneseWords } from '../nlp/japanese'
import { detectLayoutBlocks, filterBlocksByRegion, type LayoutBlock, mergeIntoColumns, padRect } from './layoutDetect'
import {
  clusterHorizontalLinesIntoColumns,
  detectLinesWithPaddle,
  isVerticalByLineShape,
  recognizeLinesWithPaddle,
  recognizeVerticalColumnWithPaddle,
} from './ocrPaddle'
import { recognizeLinesWithNdlocr, recognizeVerticalColumnWithNdlocr } from './ocrNdlocr'
import { detectLinesWithYomitoku } from './ocrYomitoku'
import { BODY_LABELS, getCachedDetection } from './regionSelection'
import { TESSDATA_CACHE_PATH } from './tessdataCache'

// YOLO 블록 bbox 를 Tesseract crop 사각형으로 쓸 때 더하는 여유(padRect 주석 참고) —
// 실측 결과 가로는 줄 끝 단어가 통째로 깨지지 않으려면 50px은 필요했고(10~30px 는
// 부족), 세로는 크게 주면 메뉴바/툴바 문구가 딸려 들어와서 작게 유지한다.
const BLOCK_PADDING_X = 50
// 담당 A — 12→20 로 상향(2026-07-30, 사용자 제보 — 다단 영역에서 열의 첫 줄이 "잘린
// 단어"(isWordClippedByRegion)로 오판돼 클릭 박스가 안 뜨는데 팝업 본문엔 텍스트가
// 있음, tesswords 덤프로 해당 단어의 bbox 자체가 null 로 제외됨을 확인). DocLayout이
// 잡은 열 bbox 상단이 실제 첫 줄보다 살짝 타이트하게 잡히는 경우가 있어 12px 여유로는
// 부족했던 것으로 보임 — 다만 이 값을 예전에 작게 유지했던 이유(메뉴바/툴바 문구가
// 딸려 들어옴)도 여전히 유효하므로 과하게 늘리지 않고 절반 정도만 올림. 재발하면(메뉴바
// 등 비본문 텍스트가 다시 섞이면) 값을 조정하거나 다른 접근(열별 재측정 등) 검토할 것.
const BLOCK_PADDING_Y = 20

// 담당 A — OCR 엔진 래퍼 (PLAN.md §5.1 / §8 / §10)
// 범용 엔진: Tesseract.js 채택 확정(오프라인, 언어팩 교체로 다국어 대응). 언어별 특화
// 엔진(예: 중국어 PaddleOCR)은 나중에 벤치마킹 후 라우팅 추가 — 지금은 Tesseract 단일 경로.

// zh-Hans/zh-Hant: langDetect.ts 가 OCR 이전에 스크립트까지 판정해 넘겨주므로, 여기서는
// 판정된 스크립트에 맞는 언어팩 하나만 로드한다(간체/번체 결합 로드는 스크립트를 미리
// 모를 때의 임시방편이었는데, 사전 판별 단계가 생기면서 더 이상 필요 없어짐 — 결합 로드
// 대비 다운로드/메모리도 줄고, Tesseract 가 두 사전 사이에서 헷갈릴 여지도 없어짐).
// Tesseract 언어팩 코드는 language 레지스트리(shared/languages.ts getOcrLangCode)의
// 단일 소스를 그대로 쓴다 — tier1/tier2 언어별 코드를 여기서 따로 들고 있지 않는다(예전엔
// tier1 4개만 하드코딩한 맵이 있었는데, tier2 55개까지 똑같이 하드코딩하면 레지스트리와
// 두 곳에서 따로 관리하게 돼 어긋날 위험이 있었음).

// 언어별 워커를 재사용한다 — 언어팩 로드 비용이 커서(수 MB 다운로드/초기화) 매 호출마다
// 새로 만들지 않는다. 언어가 바뀌면 이전 워커를 정리하고 새로 만든다.
let worker: Worker | null = null
let workerLang: AnyLanguage | null = null

async function getWorker(language: AnyLanguage): Promise<Worker> {
  if (worker && workerLang === language) return worker
  if (worker) await worker.terminate()
  worker = await createWorker(getOcrLangCode(language), undefined, { cachePath: TESSDATA_CACHE_PATH })
  workerLang = language
  return worker
}

// region 이 없을 때(전체 창을 대상으로 함) "이미지 전체"를 나타내는 Rect 가 여러
// 군데에서 필요해서(clampBounds, 판별용 폴백 등) 헬퍼로 뽑았다.
function fullImageRect(image: Buffer): Rect {
  const { width, height } = nativeImage.createFromBuffer(image).getSize()
  return { x: 0, y: 0, width, height }
}

// 개발 전용 디버그(사용자 요청, 2026-07-29) — 가장 최근 runOcr() 호출이 실제로 인식에
// 넘긴 블록/열 경계. extractionCache.ts 가 이걸 읽어 오버레이에 반투명 사각형으로
// 보여준다(캡처 이미지 기준 물리 픽셀 좌표 — words 와 마찬가지로 오버레이에 보내기
// 전 DIP 보정이 필요하다). 크로스플랫폼 — 이 값 자체는 순수 JS 라 플랫폼과 무관하다.
let lastExtractionBlocks: Rect[] = []

/** 개발 전용 디버그 시각화(extractionCache.ts)에서만 쓴다 — 실제 인식 로직과 무관. */
export function getLastExtractionBlocks(): Rect[] {
  return lastExtractionBlocks
}


interface LayoutInfo {
  blocks: LayoutBlock[]
  vertical: boolean
  /** DocLayout 이 블록을 못 찾아서(blocks=0) 대신 찾아둔 PaddleOCR 줄 — 캐시에서 왔을
   * 수도, 여기 없을 수도 있다(캐시 자체가 없으면 항상 null). */
  fallbackLines: Rect[] | null
}

/**
 * DocLayout 검출 결과를 얻는다 — 모드 진입 시 영역 자동 감지(regionSelection.ts:
 * autoDetectRegion)가 이미 이 캡처 내용으로 DocLayout(+실패 시 PaddleOCR 줄 검출)을
 * 한 번 돌려놨으므로, 그 결과가 캐시돼 있으면 재사용하고 없을 때만(수동 드래그로 영역을
 * 지정한 경우 등) 새로 검출한다. 캐시 재사용 시 blocks 는 이미지 전체 기준으로 검출된
 * 것이라 region 이 있으면 그 안에 겹치는 것만 걸러낸다(layoutDetect.ts: filterBlocksByRegion
 * — Python 쪽 detect() 가 region 인자로 하던 필터링을 캐시 재사용 시엔 JS 에서 대신함).
 */
async function resolveLayout(image: Buffer, region: Rect | undefined): Promise<LayoutInfo> {
  const cached = getCachedDetection()
  if (cached) {
    const blocks = region ? filterBlocksByRegion(cached.blocks, region) : cached.blocks
    console.log(`[timing] layout detect: 캐시 재사용 (blocks=${blocks.length}, vertical=${cached.vertical})`)
    return { blocks, vertical: cached.vertical, fallbackLines: cached.fallbackLines }
  }
  const layoutStart = Date.now()
  const detected = await detectLayoutBlocks(image, region)
  console.log(
    `[timing] layout detect: ${Date.now() - layoutStart}ms (blocks=${detected?.blocks.length ?? 'null'}, vertical=${detected?.vertical ?? 'n/a'})`,
  )
  return { blocks: detected?.blocks ?? [], vertical: detected?.vertical ?? false, fallbackLines: null }
}

/**
 * 담당 A — 실험용 브랜치(experiment/doclayout-yolo). Tesseract 는 다단(2단 등)
 * 레이아웃을 한 번에 인식시키면 열을 뒤섞어 읽는 경우가 있다(왼쪽 열 중간까지
 * 읽다가 오른쪽 열로 넘어갔다가 다시 왼쪽으로 돌아오는 식). DocLayout-YOLO(python/
 * layout_detect.py)로 블록(+열 인덱스)을 먼저 찾고, 같은 열의 블록은 하나로 합친
 * 뒤(mergeIntoColumns) 열이 2개 이상이면(=진짜 다단으로 판단) 열마다 따로 Tesseract
 * 를 돌려 순서대로 이어붙인다 — **모델이 검출한 블록 개수가 아니라 "합친 뒤 열 개수"**
 * 로 판단하는 게 중요하다: 단일 열이라도 문단이 여러 블록으로 검출되는 경우가 흔한데,
 * (합치기 전) 블록 단위로 나눠 인식하면 그 블록 경계가 실제 문장 중간을 가로질러
 * 글자가 잘리는 문제가 있었다(실사용 중 "선택 영역 중간에도 클릭 안 되는 단어 + 팝업
 * 에서 첫 글자 잘림"으로 재현) — 열이 1개면(=다단 아님) 굳이 나눌 이유가 없어서 기존
 * 단일 패스로 처리한다. 열이 1개 이하거나 레이아웃 검출 자체가 실패하면(Python 환경
 * 미설치 등) 기존 단일 패스로 폴백한다.
 */
export interface Extracted {
  /** 추출된 전체 텍스트 — ExtractedSelection.text/anchor 계산의 기준 문자열 */
  text: string
  language: AnyLanguage
  words: Word[]
}

export async function runOcr(image: Buffer, language: AnyLanguage, region?: Rect): Promise<Extracted> {
  const { blocks: rawBlocks, vertical: shapeVertical, fallbackLines } = await resolveLayout(image, region)
  // regionSelection.ts(autoDetectRegion)는 본문 영역 경계를 계산할 때 본문 라벨
  // (BODY_LABELS: doc_title/paragraph_title/text)만 남기고 header/image/aside_text/
  // number 등은 거르는데, 정작 여기(실제 인식 단계)서는 그 필터가 전혀 적용 안 되고
  // 있었다(실사용 중 확인: 비본문 블록까지 "열"로 취급돼 순서가 뒤섞이고 그 텍스트까지
  // 인식 대상이 됨) — 같은 기준으로 여기서도 걸러낸다.
  let blocks = rawBlocks.filter((b) => BODY_LABELS.has(b.label))
  let columns = mergeIntoColumns(blocks)
  // 담당 A — "선택 영역 일부만 인식됨" 수정(2026-07-30, 사용자 제보 + 재현 이미지로 확인
  // — 큰 폰트 제목 + 그 아래 구분선을 DocLayout이 표(table) 헤더/테두리로 오분류해서,
  // BODY_LABELS 가 그 거대한 table 블록을 걸러내고 나면 본문 중 극히 일부(우연히 별도로
  // 잡힌 작은 text 블록들)만 남는 사례를 실측 확인함 — 선택 영역 916px 높이 중 231px만
  // 인식 대상이 됨). 세로쓰기는 이미 "DocLayout 블록 경계를 못 믿는다"는 원칙으로 실제
  // 열 구분을 자체 로직에 맡기도록 고쳐뒀는데, 가로쓰기는 이 안전장치가 없어서 본문
  // 라벨 블록의 합계 면적이 선택 영역에 비해 너무 작으면 그대로 그 좁은 영역만 인식하고
  // 나머지는 조용히 스킵했다. 합계 면적이 선택 영역의 절반에도 못 미치면 이 블록들을
  // 아예 못 찾은 것(blocks=0)과 동일하게 취급해, 아래 blocksFound=false 폴백 경로(영역
  // 전체를 직접 줄 단위로 스캔)를 타게 한다 — English Tesseract 경로(열이 1개면 이미
  // region 전체를 그대로 씀, columns.length > 1 일 때만 블록으로 좁힘)와도 일관된 동작이 됨.
  const MIN_BODY_COVERAGE_RATIO = 0.5
  const targetRect = region ?? fullImageRect(image)
  const targetArea = targetRect.width * targetRect.height
  const columnsArea = columns.reduce((sum, c) => sum + c.bbox.width * c.bbox.height, 0)
  if (targetArea > 0 && columnsArea / targetArea < MIN_BODY_COVERAGE_RATIO) {
    console.log(
      `[layoutDetect] 본문 블록 커버리지 부족(${((columnsArea / targetArea) * 100).toFixed(1)}% < ${MIN_BODY_COVERAGE_RATIO * 100}%) — 블록 무시하고 영역 전체 스캔으로 폴백`,
    )
    blocks = []
    columns = []
  }
  // 개발 전용 디버그(사용자 요청) — 실제로 OCR 인식에 넘긴 블록/열 경계를 기억해뒀다가
  // extractionCache.ts 가 오버레이에 반투명 사각형으로 보여줄 수 있게 한다. 열이
  // 여러 개면 열마다, 하나도 안 나뉘면(다단 아님) 영역 전체를 "블록 하나"로 기록한다.
  lastExtractionBlocks = columns.length > 0 ? columns.map((c) => c.bbox) : [region ?? fullImageRect(image)]
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    // 담당 A — 가로쓰기 "선택 영역 일부만 인식됨" 진단용(2026-07-30, 사용자 제보). 기존
    // 덤프는 BODY_LABELS 필터를 통과한(=실제 인식 대상이 된) blocks만 남겨서, 필터에서
    // 걸러진 블록이 애초에 뭐였는지(진짜 비본문이었는지, DocLayout이 본문을 다른 라벨로
    // 오분류했는지) 알 수 없었다 — rawBlocks(필터 전 전체, 라벨 포함)와 region 을 같이 남긴다.
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `blocks-${Date.now()}.json`),
      JSON.stringify({ region, rawBlocks, blocks, columns }, null, 2),
    )
  }

  // 중국어/일본어는 PaddleOCR을 먼저 시도한다(세로쓰기면 recognizeVerticalColumnWithPaddle,
  // 가로쓰기면 recognizeLinesWithPaddle) — 일본어 스캔 파일에서
  // Tesseract 인식률이 낮았던 문제(실사용 확인)로 도입. 실패하면(Python 환경 없음 등)
  // null 이 와서 그대로 아래 Tesseract 경로로 흘러간다.
  if (language === 'zh-Hans' || language === 'zh-Hant' || language === 'ja') {
    // DocLayout 이 블록을 하나도 못 찾으면(blocks=0) `vertical` 판정 자체가 근거가
    // 없어 기본값 false 로 떨어지는데, 그러면 전체 영역이 통째로 "블록 1개" 취급돼
    // 열/줄 분리 없이 페이지 전체를 PaddleOCR 한 번에 통으로 넘기게 된다(실측: 200자대
    // 세로쓰기 페이지에서 38초) — 이러면 열/줄 병렬화 이득이 전혀 없는 최악의 경로다.
    // 예전엔 "언어가 ja/zh 면 무조건 세로쓰기로 가정"하는 블라인드 폴백을 썼는데, 대신
    // PaddleOCR 로 줄을 직접 찾아(어차피 다음 단계에서도 필요한 호출) 그 모양(h/w 비율)
    // 으로 실측 판별한다(isVerticalByLineShape) — 진짜로 보고 판단하는 쪽이 더 정확하다.
    const blocksFound = blocks.length > 0
    let vertical = shapeVertical
    let precomputedLines: Rect[] | undefined
    if (!blocksFound) {
      // fallbackLines 가 이미 있으면(캐시에서 왔음) 재검출 안 하고 그대로 쓴다 — 없으면
      // (캐시 자체가 없는 경우, 예: 수동 드래그 영역) 지금 새로 찾는다.
      const lines = fallbackLines ?? (await detectLinesWithPaddle(image, region ?? fullImageRect(image)))
      vertical = lines ? isVerticalByLineShape(lines) : false
      precomputedLines = lines ?? undefined
      console.log(
        `[timing] 세로/가로 실측 판별${fallbackLines ? '(캐시 재사용)' : '(새로 검출)'}: vertical=${vertical} (lines=${lines?.length ?? 'null'})`,
      )
    }
    const nonTessStart = Date.now()
    const result = vertical
      ? await runVerticalOcr(image, language, region, precomputedLines)
      : await runNonTesseractOcr(image, language, region, columns, precomputedLines)
    console.log(
      `[timing] non-tesseract ocr (${vertical ? '세로쓰기, 전체 영역' : `columns=${columns.length || 1}`}): ${Date.now() - nonTessStart}ms (${result ? 'success' : 'failed, falling back to tesseract'})`,
    )
    if (result) return result
  }

  const w = await getWorker(language)
  if (columns.length > 1) {
    const clampBounds = region ?? fullImageRect(image)
    const texts: string[] = []
    const words: Word[] = []
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]!
      // 담당 A — 열 사이 패딩이 옆 열을 침범하지 않게 제한(2026-07-30, 사용자 제보 —
      // 영어 2단에서 각 줄 끝에 옆 열의 글자 일부/노이즈가 섞여 나옴, "두 단 사이 간격이
      // 약간 좁은 편"). `padRect`는 선택 영역 전체(clampBounds) 안에서만 잘라낼 뿐 옆
      // 열까지는 모르므로, `BLOCK_PADDING_X=50px`가 열 사이 간격보다 넓으면(흔함 — 50px
      // 는 폭이 좁은 다단 레이아웃에서 실제 거터보다 클 수 있음) 그 패딩이 옆 열 영역까지
      // 그대로 뻗어 들어가 Tesseract 크롭에 옆 열 글자가 섞였다. 각 열의 크롭 경계를
      // 이웃 열과의 중간 지점까지로 제한해, 패딩이 절대 옆 열 쪽 중간선을 넘지 않게 한다
      // (거터가 아주 좁으면 그만큼 패딩 자체가 줄어들 뿐 — padRect 가 이미 폭 0 미만은
      // 방지함).
      const prevRight = i > 0 ? columns[i - 1]!.bbox.x + columns[i - 1]!.bbox.width : null
      const nextLeft = i < columns.length - 1 ? columns[i + 1]!.bbox.x : null
      const clampRight = clampBounds.x + clampBounds.width
      const leftBound = prevRight !== null ? Math.max(clampBounds.x, (prevRight + column.bbox.x) / 2) : clampBounds.x
      const rightBound = nextLeft !== null ? Math.min(clampRight, (column.bbox.x + column.bbox.width + nextLeft) / 2) : clampRight
      const columnBounds: Rect = { x: leftBound, y: clampBounds.y, width: rightBound - leftBound, height: clampBounds.height }
      const paddedBbox = padRect(column.bbox, BLOCK_PADDING_X, BLOCK_PADDING_Y, columnBounds)
      const result = await recognizeRegion(w, image, language, paddedBbox)
      // 담당 A — text/words 불변조건 위반 수정(2026-07-30, 사용자 제보 — "어느 지점부터
      // 클릭 박스와 팝업 본문이 안 맞음", 2단 기준 첫 열 경계부터 정확히 재현). 아래
      // text 는 열 사이에 '\n\n' 을 끼워 넣는데(texts.join('\n\n')), words 배열엔 그
      // 구분자에 해당하는 항목이 없어서 `text = words.map(w=>w.text).join('')` 불변조건
      // (선택 오프셋 계산이 이 등가성에 의존, 이번 세션 내내 지켜온 규칙)이 열 경계마다
      // 깨졌다 — 열 하나 끝날 때마다 text 가 words 보다 2글자씩 밀림. texts.join('\n\n')
      // 과 정확히 같은 지점에만(텍스트가 실제로 있던 열들 "사이"에만) 구분자를 넣어야
      // 하므로, 텍스트가 빈 열은 건너뛰고 "이미 텍스트가 있던 열 뒤"에만 끼워 넣는다.
      if (result.text) {
        if (texts.length > 0) words.push({ text: '\n\n' })
        texts.push(result.text)
      }
      words.push(...result.words)
    }
    return { text: texts.join('\n\n'), language, words }
  }

  const result = await recognizeRegion(w, image, language, region)
  return { text: result.text, language, words: result.words }
}

/**
 * 세로쓰기 전용 — DocLayout(PP-DocLayout_plus-L)이 블록을 몇 개로 나누든, 그 블록 단위
 * 열 분할을 아예 안 믿는다. 실측 확인: 실제 페이지에서 PP-DocLayout이 같은 자리에 폭이
 * 다른(여러 열을 뭉친 것/열 하나짜리) 박스를 중복으로 내놓는 경우가 있어서, 이 블록
 * 단위 분할(mergeIntoColumns)에 기대면 열이 뒤섞이거나 특정 열 위치에 인식이 아예
 * 안 되는 문제가 있었다("우측 열에 텍스트 박스 자체가 안 뜸"으로 확인). 그래서 DocLayout
 * 은 "본문이 대략 어디 있는지"(= region, 이미 body 라벨 기준으로 계산된 값)만 신뢰하고,
 * 실제 열 구분·읽기 순서는 이미 검증된 줄 단위 로직(recognizeVerticalColumnWithPaddle
 * 내부의 clusterVerticalLinesIntoColumns — PaddleOCR로 찾은 줄을 x좌표로 재군집화)에
 * 전부 맡긴다. 이러면 DocLayout이 블록을 몇 개로/어떻게 쪼개든 결과가 항상 같은 경로를
 * 타서 일관되게 정확하다 — 대가는 속도(좁은 열 크롭 여러 개 대신 넓은 영역 하나를
 * 통째로 줄 검출해야 함)인데, 이건 별도로(병렬 분할/축소 등) 다뤄야 할 문제로 분리한다.
 */
async function runVerticalOcr(
  image: Buffer,
  language: 'zh-Hans' | 'zh-Hant' | 'ja',
  region: Rect | undefined,
  precomputedLines: Rect[] | undefined,
): Promise<Extracted | null> {
  const target = region ?? fullImageRect(image)
  const start = Date.now()
  // 담당 A — 실험용 브랜치(experiment/ndlocr-lite). 일본어는 원래 Yomitoku 를 먼저
  // 시도했는데(dev 브랜치), 이 브랜치에서는 NDLOCR-Lite 로 바꿔서 실험한다 — 이유/
  // 실측 결과는 ocrNdlocr.ts 상단 주석 참고. NDLOCR-Lite 도 일본어 특화(정확히는
  // 고문서 특화) 모델이라 zh-Hans/zh-Hant 는 대상이 아니고, 실패하면(Python 환경
  // 없음 등) null 이 와서 기존 PaddleOCR 경로로 그대로 폴백한다.
  const words =
    language === 'ja'
      ? (await recognizeVerticalColumnWithNdlocr(image, target)) ??
        (await recognizeVerticalColumnWithPaddle(image, language, target, precomputedLines))
      : await recognizeVerticalColumnWithPaddle(image, language, target, precomputedLines)
  console.log(`[timing]   세로쓰기(전체 영역): ${Date.now() - start}ms (words=${words?.length ?? 'null'})`)
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(join(process.env.DEBUG_OCR_DUMP, `words-${Date.now()}.json`), JSON.stringify(words, null, 2))
  }
  if (!words) return null
  // zh/ja 는 띄어쓰기 없는 문자 체계라 단어 사이를 공백 없이 그냥 이어붙인다.
  const text = words.map((w) => w.text).join('')
  return { text, language, words }
}

/**
 * 가로쓰기 전용 — PaddleOCR(en 은 이 함수 자체를 안 씀, 항상 Tesseract)로 열 단위 인식을
 * 시도한다. 열 구분이 있든(다단 성공) 없든(다단 아님/레이아웃 검출 실패) 항상
 * recognizeLinesWithPaddle 로 줄 단위 병렬 인식한다 — DocLayout 이 나눈 "열" 하나가
 * 항상 작다는 보장이 없어서(실측 확인: 다단으로 나뉜 블록 중 하나가 그 자체로 본문
 * 전체만큼 클 수 있음, NHK "やさしいことば" 뉴스 페이지에서 250단어+ 블록 하나가
 * 57~74초 걸림) 열 개수와 무관하게 항상 줄 단위로 쪼개 병렬화한다(그 크롭이 페이지
 * 전체 크기라 한 번에 넘기면 느림 — 실측 38초, 다단 큰 블록도 마찬가지). 이 경로는
 * 후리가나도 걸러낸다(excludeFuriganaHorizontal). 열 하나라도 실패하면 전체를 null 로
 * 반환해 호출부가 통째로 Tesseract 로 폴백하게 한다 — 열마다 다른 엔진이 섞이는 것보다
 * 일관된 폴백이 안전하다.
 */
async function runNonTesseractOcr(
  image: Buffer,
  language: 'zh-Hans' | 'zh-Hant' | 'ja',
  region: Rect | undefined,
  columns: LayoutBlock[],
  precomputedLines?: Rect[],
): Promise<Extracted | null> {
  const clampBounds = region ?? fullImageRect(image)
  const targets = columns.length > 0 ? columns.map((c) => c.bbox) : [region ?? clampBounds]
  // precomputedLines 는 "블록 0개 → 대상 전체를 통짜 크롭 1개로 처리" 케이스에서만
  // 채워져 오고, 그 크롭은 항상 이 targets 배열의 유일한 원소(위 fallback 대입)와 같은
  // region/clampBounds 기준이라 targets.length===1 일 때만 안전하게 재사용할 수 있다.

  // 열마다 순차로(for...await) 호출하면 ocrPaddle.ts 에 만들어둔 워커 풀(POOL_SIZE=3)을
  // 쓰는 의미가 없다 — 한 열이 끝나야 다음 열을 보내니 워커 하나만 쓰는 것과 같다
  // (실사용 중 "다단/세로쓰기 페이지 인식이 오래 걸림"으로 확인). 전부 한꺼번에 보내야
  // 여러 워커에 나뉘어 실제로 동시에 처리된다 — Promise.all 은 입력 순서(=열 순서)를
  // 그대로 보존해서 반환하므로 완료 순서와 무관하게 결과가 올바르게 이어붙는다.
  //
  // 실측 확인(사용자 보고, 2026-07-29): 열이 여러 개(다단)일 때 "이미 적당히 작은
  // 크롭이니 recognizeWithPaddle 한 번으로 충분하다"고 가정했었는데, DocLayout이 다단
  // 으로 나눈 블록 중 하나가 그 자체로 본문 전체(252~343단어)만큼 클 수도 있어서
  // 이 가정이 항상 맞지는 않았다 — 그런 큰 블록을 recognizeWithPaddle 로 통째로 넘기면
  // 줄 단위 병렬화가 전혀 안 먹어 57~74초까지 걸렸다(NHK "やさしいことば" 뉴스 페이지로
  // 실측). recognizeLinesWithPaddle 은 크롭 크기와 무관하게 항상 줄 단위로 쪼개
  // 워커 풀에 병렬로 돌리고 후리가나도 걸러내므로(excludeFuriganaHorizontal), 열 개수와
  // 상관없이 항상 이쪽을 쓴다 — precomputedLines 재사용은 여전히 열이 1개일 때만
  // 안전하다(위 주석 참고).
  const perColumn = await Promise.all(
    targets.map(async (bbox, i) => {
      // 담당 A — 열 사이 패딩이 옆 열을 침범하지 않게 제한(2026-07-30, English 다단
      // 경로에서 발견한 것과 동일한 문제 — ocr.ts 위쪽 columns.length > 1 분기 주석
      // 참고). targets 가 여러 개(다단 DocLayout 블록)일 때만 이웃이 존재하므로 그때만
      // 계산하고, 폴백(통짜 영역 1개)일 땐 clampBounds 그대로 쓴다.
      const clampRight = clampBounds.x + clampBounds.width
      const prevRight = i > 0 ? targets[i - 1]!.x + targets[i - 1]!.width : null
      const nextLeft = i < targets.length - 1 ? targets[i + 1]!.x : null
      const leftBound = prevRight !== null ? Math.max(clampBounds.x, (prevRight + bbox.x) / 2) : clampBounds.x
      const rightBound = nextLeft !== null ? Math.min(clampRight, (bbox.x + bbox.width + nextLeft) / 2) : clampRight
      const columnBounds: Rect = { x: leftBound, y: clampBounds.y, width: rightBound - leftBound, height: clampBounds.height }
      const padded = padRect(bbox, BLOCK_PADDING_X, BLOCK_PADDING_Y, columnBounds)
      const start = Date.now()
      let lines = targets.length === 1 ? precomputedLines : undefined
      // 담당 A — 가로쓰기 후리가나 노이즈 대응(2026-07-29, ocrYomitoku.ts 상단 주석
      // 참고). 일본어는 줄 검출을 Yomitoku 로 먼저 시도한다 — PaddleOCR 가로쓰기 검출이
      // 후리가나를 본문과 한 박스로 합쳐버리는 페이지가 있어(rect 필터로 못 잡음) 검출
      // 모델 자체가 다른 Yomitoku 로 회피를 시도. 실제 텍스트 인식은 그대로 PaddleOCR
      // (아래 recognizeLinesWithPaddle, 워커 풀 병렬화)에 맡긴다 — Yomitoku 자체 인식은
      // 워커 풀이 없어 느리다(실측: 검출 4.7초 vs 인식 44.8초, ocrYomitoku.ts 주석 참고).
      // 검출 실패하면(Python 환경 없음 등) null 이 와서 기존 줄(precomputedLines 또는
      // undefined→PaddleOCR 자체 검출)로 그대로 폴백한다. zh 는 대상 아님(일본어 전용).
      // 담당 A — Yomitoku 검출 + NDLOCR-lite 인식 조합 실험(2026-07-29, 사용자 제안).
      // Yomitoku 로 이미 줄을 찾았으면(yomiLines) 그 줄들을 NDLOCR-lite 인식기로 먼저
      // 읽어본다 — 원래 세로쓰기 고문서용으로 학습된 모델이라 현대 인쇄 후리가나
      // 텍스트에서 정확도가 어떨지 검증 중(recognizeLinesWithNdlocr 주석 참고). 실패하면
      // (null) PaddleOCR 인식으로 폴백 — 검출(Yomitoku) 자체가 실패했으면 애초에
      // NDLOCR-lite 를 시도할 줄 목록이 없으므로 바로 PaddleOCR 전체 경로(자체 검출+인식)로 간다.
      let words: Word[] | null = null
      if (language === 'ja') {
        const yomiLines = await detectLinesWithYomitoku(image, padded)
        if (yomiLines) {
          // 담당 A — 열 재군집화(2026-07-30, clusterHorizontalLinesIntoColumns 주석
          // 참고) — 이 크롭(padded)이 다단 영역 전체일 수 있어(DocLayout 폴백 등),
          // Yomitoku 가 준 원시 검출 순서를 그대로 안 믿고 왼쪽 열부터 정렬한다.
          const orderedYomiLines = clusterHorizontalLinesIntoColumns(yomiLines)
          lines = orderedYomiLines
          words = await recognizeLinesWithNdlocr(image, orderedYomiLines)
        }
      }
      words ??= await recognizeLinesWithPaddle(image, language, padded, lines)
      console.log(`[timing]   column ${i}: ${Date.now() - start}ms (words=${words?.length ?? 'null'})`)
      return words
    }),
  )
  if (perColumn.some((columnWords) => !columnWords)) return null // 열 하나라도 실패하면 통째로 Tesseract 폴백
  const words = perColumn.flatMap((columnWords) => columnWords!)
  // 이 함수는 zh/ja 전용이라(en 은 항상 Tesseract) 원래 띄어쓰기 없는 문자 체계다 —
  // 단어 사이를 공백 없이 그냥 이어붙인다.
  const text = words.map((w) => w.text).join('')
  return { text, language, words }
}

/** 이미지 한 장(전체 또는 region 으로 제한된 한 블록)을 인식해 텍스트+단어 bbox 를 뽑는다. */
async function recognizeRegion(
  w: Worker,
  image: Buffer,
  language: AnyLanguage,
  region?: Rect,
): Promise<{ text: string; words: Word[] }> {
  // blocks 출력은 기본 꺼져 있음 — 단어별 bbox 를 얻으려면 명시적으로 켜야 한다.
  // 담당 A — 크롭 후 업스케일(2026-07-30, 사용자 제보 — 축소된 화면에서 멀쩡한 단어들도
  // Tesseract confidence 가 44~59로 낮게 나와 MIN_WORD_CONFIDENCE(60) 문턱을 못 넘고
  // "잘린 단어"로 오판돼 클릭 박스가 사라짐, tesswords 덤프로 `clippedByRegion=false,
  // truncated=true`임을 확인 — 경계 문제가 아니라 순수 신뢰도 문제였음). 예전엔
  // SetRectangle 로 원본 전체 이미지에 사각형만 지정해서 해상도 자체는 원본 그대로였는데,
  // Tesseract는 해상도가 낮을수록 confidence 도 체계적으로 낮게 나오는 경향이 있어(잘
  // 알려진 특성) — region 을 실제로 잘라내 확대한 뒤 그 위에서 인식하면 confidence 가
  // 올라갈 것으로 기대. 반환된 bbox 는 확대된 크롭 좌표계라 원본 이미지 절대좌표로
  // 즉시 되돌린다(rescaleTesseractBlocks) — 그 이후 하류 로직(잘린 단어 판정 등)은
  // 원래 계약(원본 절대좌표) 그대로라 안 건드려도 된다. region 이 없는 경로(단일 열
  // 전체 인식)는 크기가 임의로 클 수 있어 우선 그대로 둔다(관찰된 문제가 다단 경로에서만
  // 나왔음).
  const UPSCALE_FACTOR = 2
  let recognizeTarget = image
  let scale = 1
  let offsetX = 0
  let offsetY = 0
  if (region) {
    offsetX = Math.max(0, Math.round(region.x))
    offsetY = Math.max(0, Math.round(region.y))
    const cropWidth = Math.max(1, Math.round(region.width))
    const cropHeight = Math.max(1, Math.round(region.height))
    const cropped = nativeImage
      .createFromBuffer(image)
      .crop({ x: offsetX, y: offsetY, width: cropWidth, height: cropHeight })
    const size = cropped.getSize()
    // 담당 A — quality:'good' 명시(2026-07-30, 사용자 제보 — 다른 영어 가로쓰기 파일에서
    // em-dash("—")가 거의 인식이 안 됨). Electron `resize()` 기본값이 이미 'best'(가장
    // 매끄러운 보간)인데, em-dash 처럼 아주 얇은 가로 획은 부드러운 보간으로 확대하면
    // 대비가 흐려져(주변 배경색과 섞임) Tesseract가 아예 못 보게 될 수 있다 — 굵은
    // 글자 획엔 도움이 되는 보간이 얇은 단일 획엔 역효과일 수 있다는 가설. 'good'(가장
    // 거친/덜 매끄러운 보간)으로 낮춰 얇은 획의 대비가 덜 흐려지는지 시도.
    recognizeTarget = cropped
      .resize({
        width: Math.round(size.width * UPSCALE_FACTOR),
        height: Math.round(size.height * UPSCALE_FACTOR),
        quality: 'good',
      })
      .toPNG()
    scale = UPSCALE_FACTOR
  }
  const { data } = await w.recognize(recognizeTarget, {}, { blocks: true })
  if (region && scale !== 1) {
    // 확대된 크롭 좌표계 → 원본 이미지 절대좌표로 되돌린다(block/paragraph/line/word/
    // symbol 전 계층의 bbox 를 제자리에서 변환) — 이후 코드는 전부 이 좌표계를 가정한다.
    const fix = (bbox: { x0: number; y0: number; x1: number; y1: number } | null | undefined) => {
      if (!bbox) return
      bbox.x0 = offsetX + bbox.x0 / scale
      bbox.y0 = offsetY + bbox.y0 / scale
      bbox.x1 = offsetX + bbox.x1 / scale
      bbox.y1 = offsetY + bbox.y1 / scale
    }
    for (const block of data.blocks ?? []) {
      fix(block.bbox)
      for (const paragraph of block.paragraphs) {
        fix(paragraph.bbox)
        for (const line of paragraph.lines) {
          fix(line.bbox)
          for (const word of line.words) {
            fix(word.bbox)
            for (const symbol of word.symbols ?? []) fix(symbol.bbox)
          }
        }
      }
    }
  }

  // 담당 A — text/words 불일치 버그 수정(2026-07-30, 사용자 제보 — "팝업 본문에서
  // 단어 반만 선택됨" + "영역 가장자리 단어는 팝업 본문엔 나오는데 텍스트 박스가 없음").
  // 예전엔 여기서 `text: normalizeOcrText(data.text)` 로 Tesseract 가 조립한 원문을
  // 그대로 썼는데, 이건 아래에서 필터링(잘린 단어 제외 등)해 만드는 `words` 배열과
  // 완전히 독립된 별도의 문자열이다 — CJK 경로(ocrPaddle.ts/ocrNdlocr.ts)는 전부
  // `text = words.map(w => w.text).join('')` 불변조건을 지키는데(클릭 지점 ↔ 오프셋
  // 매핑이 이 등가성에 의존, selection/index.ts: findWordSpan 주석 참고) 이 함수만
  // 예외였다. 그 결과 (1) 잘려서 `words`엔 안 들어간 가장자리 단어가 Tesseract 원문
  // (`data.text`)엔 그대로 남아있어 팝업 본문엔 보이는데 겹치는 bbox 가 없어 텍스트
  // 박스는 안 생기고, (2) 그보다 더 심각하게 `words` 배열이 `text`보다 문자 수가
  // 적어져서(제외된 단어만큼) 클릭 위치 이후 모든 오프셋 계산이 어긋나 팝업에서 엉뚱한
  // 위치(단어 중간 등)가 선택됐다. `words` 를 만들면서 그 사이사이에 구분자(공백/문단
  // 구분)도 bbox 없는 Word 로 같이 끼워 넣어, text 를 `words` 자체에서 그대로 뽑아내도록
  // 바꿨다 — 이제 두 값이 애초에 같은 데이터에서 나와 어긋날 수가 없다.
  const lines = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => ({ ...line, paragraph }))),
  )
  // 영역의 맨 위/아래 줄이 다른 줄보다 확연히 낮으면, 위/아래 경계가 그 줄 중간을
  // 가로질러서 글자 위쪽/아래쪽 절반만 보이는 것으로 본다(findEdgeClippedLines) — 이
  // 경우 그 줄 전체를 통째로 제외한다.
  const clippedLines = region ? findEdgeClippedLines(lines) : new Set<(typeof lines)[number]>()

  const words: Word[] = []
  let lastParagraph: (typeof lines)[number]['paragraph'] | null = null
  for (const line of lines) {
    if (clippedLines.has(line)) continue

    let lineWords: Word[]
    // 단어 단위가 아니라 줄 단위로 hover/선택하기로 한 결정(2026-07-28)은 가로쓰기
    // 영어(아래 else 분기)에는 되돌렸다(2026-07-29 재요청) — Tesseract 단어 bbox 가 이미
    // 충분히 정확해서 줄 단위로 묶을 이유가 없고, 오히려 문장부호까지 뭉뚱그려 보이는
    // 부작용만 있었다. lineId 를 안 붙이면 wordMapping.ts findLineWordsAtPoint 가 알아서
    // 단어 단위(그 단어 하나만)로 폴백한다.
    // ja/zh 는 반대로 줄 단위를 유지한다 — buildCjkLineWords(아래)가 이 파일과 별개로
    // ocrPaddle.ts(PaddleOCR, 실제 기본 경로)의 groupCjkCharsGrid 처럼 줄마다 lineId 를
    // 붙인다. 예전엔 여기(Tesseract 폴백)만 lineId 를 안 붙여서, PaddleOCR/NDLOCR 가
    // 실패했을 때만(Python 환경 없음 등) hover 가 줄 단위 → 단어 단위로 조용히 바뀌는
    // 불일치가 있었다(2026-07-30, 사용자 지적 — "어느 엔진이 실제로 인식했는지에 따라
    // hover 단위가 갈리면 안 된다") — 이제 어느 경로로 인식되든 ja/zh hover 단위가 항상
    // 같다.
    if (language === 'ja' || language === 'zh-Hans' || language === 'zh-Hant') {
      // 일/중은 공백으로 단어가 안 나뉘어 Tesseract 자체 단어 경계가 의미 단위와 잘 안
      // 맞는다 — 줄 전체를 형태소 분석기(일: JA_ENGINE 설정값, 중: ZH_HANT_ENGINE 설정값/jieba)로 다시 분리한다.
      lineWords = await buildCjkLineWords(line, language, region)
    } else if (language === 'th' || language === 'lo') {
      // 태국어/라오어는 형태소 분석기가 없어(2026-07-30 결정, tier2는 OCR만 지원) Tesseract
      // 단어 경계를 신뢰할 수 없다 — 대신 ocrNdlocr.ts(세로쓰기 일본어)와 동일한 방식으로
      // 줄마다 하나의 lineId 를 만들어 그 줄의 모든 단어에 붙인다. wordMapping.ts
      // findLineWordsAtPoint 가 lineId 로 자동으로 묶어 hover/클릭이 줄 단위가 되고, 팝업
      // 내부 선택은(popup/selection.ts NO_WORD_BOUNDARY_LANGUAGES) 그대로 글자 단위다.
      const lineId = Math.random().toString(36).slice(2)
      lineWords = []
      for (const word of line.words) {
        if (lineWords.length > 0) lineWords.push({ text: ' ' })
        if (region && (isWordClippedByRegion(word.bbox, region) || looksTruncated(word))) {
          // 담당 A — 잘린 단어를 텍스트에서도 통째로 빼버리면(2026-07-30, 재수정) 그
          // 자리의 글자가 아예 사라져버린다(사용자 재확인 — "클릭만 안 되던 단어가
          // 누락됨") — bbox 만 빼서 hover/클릭 대상에서만 제외하고, 텍스트 자체는
          // 그대로 문맥에 남긴다(원래 동작).
          lineWords.push({ text: word.text })
          continue
        }
        lineWords.push(...splitWordBySymbols(word, line.bbox).map((wd) => ({ ...wd, lineId })))
      }
    } else {
      lineWords = []
      for (const word of line.words) {
        if (lineWords.length > 0) lineWords.push({ text: ' ' })
        // 잘린 단어는 hover/클릭 대상(bbox)에서만 제외한다 — 두 가지 다른 원인을 각각
        // 다른 방법으로 잡는다.
        //  1) 우리가 지정한 영역 경계 자체가 단어 중간을 가로지르는 경우: Tesseract 는
        //     rectangle 옵션으로 크롭된 픽셀만 보므로 bbox 가 그 경계에 거의 딱 붙어서
        //     나온다(isWordClippedByRegion). 하지만 사용자가 영역을 넉넉하게(글자 주변에
        //     여백을 두고) 잡았다면, 실제 잘림은 영역 안쪽 — 원본 화면 자체에서 이미 잘려
        //     보이는 경우(예: 스크롤 패널 경계에 걸친 줄)일 수 있고, 이때 bbox 는 영역
        //     경계와 거리가 있어서 위 방식으로는 못 잡는다.
        //  2) 그래서 인식 신뢰도(confidence)도 같이 본다: 글자 획 일부만 보이는 상태로
        //     인식되면 Tesseract 도 확신을 못 해서 대체로 confidence 가 낮게 나온다
        //     (looksTruncated) — 위치와 무관하게 "제대로 안 보인 글자"를 잡아낸다.
        // 담당 A — 텍스트는 그대로 유지, bbox 만 뺀다(2026-07-30 재수정) — 통째로 빼면
        // (이전 시도) 그 자리 글자가 팝업 본문에서도 사라져버렸다(사용자 재확인).
        if (region && (isWordClippedByRegion(word.bbox, region) || looksTruncated(word))) {
          if (process.env.DEBUG_OCR_DUMP) {
            console.log(
              `[ocr] 잘린 단어로 bbox 제외: "${word.text}" clippedByRegion=${isWordClippedByRegion(word.bbox, region)}` +
                ` truncated=${looksTruncated(word)} confidence=${word.confidence} bbox=${JSON.stringify(word.bbox)} region=${JSON.stringify(region)}`,
            )
          }
          lineWords.push({ text: word.text })
          continue
        }
        // 높이는 단어 자체 bbox 대신 줄(line) bbox 를 쓴다 — 단어 bbox 는 그 단어를
        // 구성하는 글자의 실제 잉크 범위만 딱 맞춰서 나와서, 어센더/디센더(g/y/p 등)가
        // 없는 단어는 자연히 낮게 나오고 같은 줄에서도 단어마다 높이가 들쭉날쭉해진다.
        // 줄 bbox 는 그 줄 전체 기준이라 같은 줄의 단어들이 통일된 높이로 보인다.
        lineWords.push(...splitWordBySymbols(word, line.bbox))
      }
    }
    if (lineWords.length === 0) continue

    // 구분자도 bbox 없는 Word 로 같이 끼워 넣는다(hover/클릭 대상 아님) — 문단이 바뀌면
    // Tesseract 관례(문단 사이 빈 줄)를 그대로 살려 '\n\n', 같은 문단 안에서 줄이 바뀐
    // 것뿐이면(창 폭 기준으로 어쩌다 끊긴 자리라 의미 없음, 예전 normalizeOcrText와 동일
    // 판단) 공백 하나로 합친다.
    if (words.length > 0) {
      words.push({ text: line.paragraph === lastParagraph ? ' ' : '\n\n' })
    }
    lastParagraph = line.paragraph
    words.push(...lineWords)
  }

  const text = words.map((word) => word.text).join('')
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    // 담당 A — text/words 오프셋 어긋남 진단용(2026-07-30, 사용자 제보 — 클릭이 다른
    // 단어에 매핑됨). 각 word 의 누적 오프셋을 같이 남겨서, 어느 word 부터 실제 화면
    // 텍스트와 어긋나는지 눈으로 바로 짚을 수 있게 한다.
    let acc = 0
    const dump = words.map((word) => {
      const entry = { text: word.text, bbox: word.bbox ?? null, start: acc, end: acc + word.text.length }
      acc += word.text.length
      return entry
    })
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `tesswords-${Date.now()}.json`),
      JSON.stringify({ text, words: dump }, null, 2),
    )
  }

  return { text, words }
}

/**
 * 한 줄(line) 안의 Tesseract 단어들을 글자(symbol) 단위로 이어붙인 뒤, 형태소 분석기로
 * 의미 단위 단어 경계를 다시 잡아 Word[] 를 만든다. 잘린 단어(isWordClippedByRegion/
 * looksTruncated)는 기존과 동일하게 제외하되, 제외된 자리는 분석기가 단어를 이어붙이지
 * 못하게 끊어준다(연속 구간=run 단위로 분석기를 돌린다).
 *
 * 이 경로는 PaddleOCR/NDLOCR 이 실패했을 때만 타는 Tesseract 폴백이다(runOcr 참고) —
 * 단어 경계 자체는 원래도 이 파일과 ocrPaddle.ts(groupCjkCharsGrid)가 똑같이
 * segmentJapaneseWords/segmentChineseWords 하나만 호출해 이미 단일 소스였지만, hover
 * 단위를 줄로 묶을지(lineId)는 ocrPaddle.ts 만 하고 있어서 어느 엔진이 실제로 인식했는지에
 * 따라 CJK hover 가 줄 단위(PaddleOCR 성공) ↔ 단어 단위(Tesseract 폴백)로 갈리는 불일치가
 * 있었다(2026-07-30, 사용자 지적) — PaddleOCR 경로와 동일하게 이 줄의 모든 단어에 같은
 * lineId 를 붙여 hover granularity 도 엔진과 무관하게 통일한다(ocrPaddle.ts:
 * recognizeOrderedLines 주석 참고 — "잉크 튜닝이 끝나면 lineId 부여만 빼면 단어 단위로
 * 복귀 가능"이므로, 그 결정이 바뀌면 여기도 같이 바꿔야 한다).
 */
async function buildCjkLineWords(
  line: { words: { text: string; bbox: OcrBbox; symbols?: OcrSymbol[]; confidence: number }[]; bbox: OcrBbox },
  language: 'ja' | 'zh-Hans' | 'zh-Hant',
  region: Rect | undefined,
): Promise<Word[]> {
  const runs: OcrSymbol[][] = []
  let current: OcrSymbol[] = []
  for (const word of line.words) {
    if (region && (isWordClippedByRegion(word.bbox, region) || looksTruncated(word))) {
      if (current.length > 0) {
        runs.push(current)
        current = []
      }
      continue
    }
    current.push(...(word.symbols ?? []))
  }
  if (current.length > 0) runs.push(current)

  const words: Word[] = []
  for (const run of runs) {
    const text = run.map((s) => s.text).join('')
    const boundaries =
      language === 'ja' ? await segmentJapaneseWords(text) : await segmentChineseWords(text, language)
    for (const b of boundaries) {
      const syms = run.slice(b.start, b.end)
      if (syms.length === 0) continue
      const x0 = Math.min(...syms.map((s) => s.bbox.x0))
      const x1 = Math.max(...syms.map((s) => s.bbox.x1))
      words.push({
        text: b.text,
        bbox: {
          x: x0,
          y: line.bbox.y0,
          width: Math.max(0, x1 - x0),
          height: line.bbox.y1 - line.bbox.y0,
        },
      })
    }
  }
  const lineId = Math.random().toString(36).slice(2)
  return words.map((w) => ({ ...w, lineId }))
}

// 맨 위/아래 줄의 높이가 다른 줄들의 중앙값보다 이 비율 미만이면 "세로로 잘린 줄"로 본다.
const EDGE_LINE_HEIGHT_RATIO = 0.95

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 영역의 맨 위 줄/맨 아래 줄만 따로 확인한다 — 영역 경계가 줄 중간을 가로지르면(위쪽
 * 절반만 보이는 첫 줄, 아래쪽 절반만 보이는 마지막 줄) 그 줄의 bbox 높이가 다른 줄보다
 * 뚜렷하게 작게 나온다. "다른 줄"이 최소 2개는 있어야 비교 기준(중앙값)을 믿을 수
 * 있어서, 전체 줄이 3개 미만이면(비교 대상이 부족) 이 판정 자체를 건너뛴다.
 */
function findEdgeClippedLines<L extends { bbox: OcrBbox }>(lines: L[]): Set<L> {
  const clipped = new Set<L>()
  if (lines.length < 3) return clipped

  let top = lines[0]!
  let bottom = lines[0]!
  for (const line of lines) {
    if (line.bbox.y0 < top.bbox.y0) top = line
    if (line.bbox.y1 > bottom.bbox.y1) bottom = line
  }

  const heightOf = (l: L) => l.bbox.y1 - l.bbox.y0
  const checkEdge = (edge: L) => {
    const others = lines.filter((l) => l !== edge).map(heightOf)
    if (others.length < 2) return
    if (heightOf(edge) < median(others) * EDGE_LINE_HEIGHT_RATIO) clipped.add(edge)
  }
  checkEdge(top)
  if (bottom !== top) checkEdge(bottom)
  return clipped
}

interface OcrBbox { x0: number; y0: number; x1: number; y1: number }
interface OcrSymbol { text: string; bbox: OcrBbox; confidence: number }

// 영역 경계와의 여유(px) — Tesseract 가 잘린 단어의 보이는 부분만으로 잡는 bbox 가
// 경계와 정확히 0px 로 안 맞고 1~2px 정도 오차가 있는 걸 감안한 허용치.
const REGION_EDGE_TOLERANCE = 3

/**
 * 단어 bbox 가 지정 영역의 경계에 거의 닿아있으면 "잘린 단어"로 본다. Tesseract 는
 * rectangle 옵션으로 크롭된 픽셀만 보고 인식하므로, 실제로는 더 이어지는 글자가 있는데
 * 영역 밖이라 안 보이는 단어는 보이는 부분의 bbox 가 그 잘린 경계선에 딱 붙어서 나온다
 * (완전히 포함된 단어는 보통 옆 단어/줄과의 여백 때문에 경계에서 몇 px 이상 떨어져 있음).
 */
function isWordClippedByRegion(bbox: OcrBbox, region: Rect): boolean {
  const left = region.x
  const top = region.y
  const right = region.x + region.width
  const bottom = region.y + region.height
  return (
    bbox.x0 <= left + REGION_EDGE_TOLERANCE ||
    bbox.y0 <= top + REGION_EDGE_TOLERANCE ||
    bbox.x1 >= right - REGION_EDGE_TOLERANCE ||
    bbox.y1 >= bottom - REGION_EDGE_TOLERANCE
  )
}

// Tesseract 의 단어 confidence 는 심볼 평균이 아니라 자체 언어모델/사전 매칭까지 반영한
//값이라, 아포스트로피가 낀 단어("isn't"=88, "I'll"=88, "soon."=86 등, 실측)는 글자
// 하나하나는 98~99%로 다 정확히 읽었는데도 단어 전체 confidence 는 90 밑으로 곧잘
// 떨어진다 — 예전에 90까지 올렸을 때 이런 케이스가 전부 오탐으로 잘려나갔다("아포스트
// 로피/세미콜론 낀 단어, 줄 끝 단어 클릭 안 됨"으로 확인). 반면 실제로 잘리거나 깨진
// 단어는 확 낮은 값(같은 실측에서 크롭 경계에 걸려 깨진 단어가 46)이 나와서, 60 정도면
// 정상 단어의 최저치(86)와 충분한 여유를 두면서도 진짜 깨진 단어는 잡아낸다.
const MIN_WORD_CONFIDENCE = 60
// 단어 전체 평균은 넘겨도, 특정 글자 하나만 유독 신뢰도가 낮으면(예: 마지막 글자만
// 반쯤 잘림) 그 한 글자 때문에 단어 전체가 부정확해지므로 별도로 확인한다.
const MIN_SYMBOL_CONFIDENCE = 75

// 끝에 붙는 문장부호(마침표·쉼표·닫는 인용부호/괄호 등, 한/영/일 공통) — looksTruncated
// 의 신뢰도 검사에서 제외할 심볼을 가릴 때만 쓴다(이런 획이 가는 글자는 멀쩡해도 원래
// confidence 가 낮게 나오는 경향이 있어서, 잘림 신호로 오인하면 안 된다). 티어2 언어
// 전용 문장부호(스페인어 ¡/¿, 아랍어 ،/؛/؟, 힌디어 계열 단다 ।/॥, 아르메니아어
// ։/՜/՛/՞/՟)도 같은 이유로 추가한다(2026-07-30, 사용자 지적 — 예전엔 영어/한중일만
// 있어서 이 언어들 단어가 끝 문장부호 때문에 통째로 잘림 오판될 위험이 있었다).
const TRAILING_PUNCT_RE =
  /^[.,!?;:'")\]}»›」』、。！？；：¡¿،؛؟।॥։՜՛՞՟]$/
// em dash(—)/en dash(–) — 마찬가지로 looksTruncated 의 신뢰도 검사 제외 대상 판정용.
const DASH_CHARS = new Set(['—', '–'])
// 영어/라틴 등 비-CJK hover 박스 단어 경계 — 확장 프로그램(extension/src/domWords.ts:
// WORD_ATOM_RE)과 같은 소스(@shared/wordTokenize)를 써서, 문장부호를 제외하고 하이픈으로
// 이어진 구간은 한 단어로 묶는 기준을 통일한다(2026-07-30, "OCR 호버박스에 문장부호도
// 잡힌다" 사용자 지적 — 자체 정규식(TRAILING_PUNCT_RE/DASH_CHARS) 로 끝쪽만 잘라내던
// 방식이라 "순수 문장부호로만 된 단어"가 통째로 hover 대상에 남는 예외가 있었다).
const HOVER_WORD_ATOM_RE = new RegExp(HOVER_WORD_ATOM_PATTERN, 'gu')

/**
 * 위치(isWordClippedByRegion)가 아니라 "제대로 안 보이는 글자"를 인식 신뢰도로 판정한다.
 * 사용자가 영역을 넉넉하게 잡아서 잘린 지점이 영역 경계와 멀리 떨어져 있어도(예: 원본
 * 화면 자체의 스크롤 패널 경계에 걸쳐 반만 보이는 줄), 글자 획 일부만 보이면 Tesseract
 * 도 확신을 못 해 confidence 가 낮게 나오는 경향을 이용한다 — 위치 기반 판정을 못
 * 빠져나가는 잘림까지 잡기 위한 보완 규칙.
 *
 * 문장부호/대시 심볼은 신뢰도 검사에서 제외한다 — 아포스트로피(')·세미콜론(;)·
 * em/en dash 처럼 획이 가늘고 작은 글자는 완전히 멀쩡하게 보여도 Tesseract 가 원래
 * 낮은 confidence 를 주는 경향이 있어서, 이걸 그대로 "잘림" 신호로 쓰면 그런 문장
 * 부호가 낀 단어(줄 끝 단어는 흔히 문장부호로 끝남, 대시로 이어진 단어는 대시 자체가
 * 심볼로 포함됨)가 실제로는 안 잘렸는데도 통째로 걸러지는 오탐이 생겼다(실사용 중
 * "아포스트로피/세미콜론 낀 단어, 줄 끝 단어, em/en dash 단어가 클릭 안 됨"으로 확인).
 * 실제 글자(알파벳/숫자/한글 등)의 신뢰도만 본다.
 */
function looksTruncated(word: { confidence: number; symbols?: OcrSymbol[] }): boolean {
  if (word.confidence < MIN_WORD_CONFIDENCE) return true
  return (word.symbols ?? []).some(
    (s) => !TRAILING_PUNCT_RE.test(s.text) && !DASH_CHARS.has(s.text) && s.confidence < MIN_SYMBOL_CONFIDENCE,
  )
}

/**
 * Tesseract 단어 1개를 글자(symbol) 단위로 훑어, 확장 프로그램의 hover 박스 단어 판정
 * (HOVER_WORD_ATOM_RE, @shared/wordTokenize)과 동일한 기준으로 실제 "단어" 구간만 골라
 * 각각 별도 박스를 만든다 — 그 사이(앞/뒤 문장부호, em/en dash 등 경계 문자)는 bbox 없는
 * Word 로 남겨 텍스트는 보존하되 hover/클릭 대상에서는 뺀다. 이전에는 끝쪽 문장부호만
 * 잘라내는 자체 정규식(TRAILING_PUNCT_RE)과 em/en dash 전용 분리(DASH_CHARS)를 따로
 * 구현해서, "순수 문장부호로만 된 단어"가 걸러지지 않고 그대로 hover 대상에 남는 예외가
 * 있었다(2026-07-30, 사용자 지적) — 이제 확장 프로그램과 같은 패턴을 쓰므로 그런 예외가
 * 없고, 하이픈으로 이어진 단어(well-known)를 한 덩어리로 묶는 것도 동일하게 적용된다.
 *
 * 각 단어 atom 의 박스는 그 atom 을 이루는 심볼들의 bbox 를 합쳐서(min x0 ~ max x1)
 * 만든다 — "글자 개수 비율"로 원본 단어 폭을 나누면 글자 폭이 균일하지 않아(좁은 i/l 과
 * 넓은 o/w 가 섞여있음) 실제 잉크 경계와 최대 15px 이상 어긋났던 문제(officials—will 류,
 * 실측 확인)가 있어 심볼 bbox 를 직접 합치는 방식을 그대로 유지한다.
 */
function splitWordBySymbols(
  word: { text: string; bbox: OcrBbox; symbols?: OcrSymbol[] },
  lineBbox: OcrBbox,
): Word[] {
  const mk = (text: string, x0: number, x1: number): Word => ({
    text,
    bbox: { x: x0, y: lineBbox.y0, width: Math.max(0, x1 - x0), height: lineBbox.y1 - lineBbox.y0 },
  })

  const symbols = word.symbols
  if (!symbols || symbols.length === 0) return [mk(word.text, word.bbox.x0, word.bbox.x1)]

  const text = symbols.map((s) => s.text).join('')
  const results: Word[] = []
  let pos = 0
  HOVER_WORD_ATOM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HOVER_WORD_ATOM_RE.exec(text))) {
    if (m.index > pos) results.push({ text: text.slice(pos, m.index) })
    const atomSymbols = symbols.slice(m.index, m.index + m[0].length)
    const x0 = Math.min(...atomSymbols.map((s) => s.bbox.x0))
    const x1 = Math.max(...atomSymbols.map((s) => s.bbox.x1))
    results.push(mk(m[0], x0, x1))
    pos = m.index + m[0].length
  }
  if (pos < text.length) results.push({ text: text.slice(pos) })
  return results
}
