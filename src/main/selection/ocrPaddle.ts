import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Language, Rect, Word } from '@shared/types'
import { segmentChineseWords } from '../nlp/chinese'
import { segmentJapaneseWords } from '../nlp/japanese'
import { createPythonServerPool, defaultPoolSize, TINY_PNG } from './pythonServer'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). PaddleOCR(python/ocr_paddle.py)
// 로 en/zh/ja(가로쓰기) 텍스트를 검출+인식한다 — 일본어 스캔 파일에서 Tesseract
// 인식률이 낮아서(실사용 확인) 도입. Tesseract 의 `rectangle` 옵션 같은 크롭 restrict
// 가 PaddleOCR 엔 없어서, 여기서 직접 크롭한 이미지를 Python 에 넘긴다 — 그래서
// 응답 bbox 는 크롭 기준 상대좌표이고, cropBbox 원점을 더해 절대좌표로 되돌린다.
//
// 워커를 여러 개 띄운다 — 다단 레이아웃은 열마다(세로쓰기는 줄마다) 따로 인식을
// 돌려야 해서(ocr.ts) 워커가 적으면 여러 줄/열이 몇 라운드씩 나눠서 순서대로 기다린다
// (실사용 중 "세로쓰기 페이지 인식이 오래 걸림"으로 확인). 예전엔 3 → 6으로 고정값을
// 올려서 튜닝했는데(세로쓰기 한 페이지 줄이 14~15개인 경우가 흔해서, 3개면 5라운드,
// 6개면 3라운드로 줄어듦), 그 6이라는 숫자는 이 개발 컴퓨터(물리 4코어)에 맞춘 값이라
// 다른 사용자 환경(코어 수가 다름)엔 안 맞을 수 있다 — `defaultPoolSize()`(pythonServer.ts)
// 로 실행 중인 기기의 실제 코어 수에 맞게 동적으로 정한다. 워커마다 모델을 독립적으로
// 메모리에 올려서(공유 안 됨) 메모리 사용량이 그만큼 늘어나는 트레이드오프가 있다
// (실측: 워커 하나당 ~700~800MB).
const POOL_SIZE = defaultPoolSize()
const server = createPythonServerPool('ocr_paddle.py', POOL_SIZE)

interface RawWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

interface RawLine {
  x0: number
  y0: number
  x1: number
  y1: number
}

async function writeCrop(image: Buffer, cropBbox: Rect): Promise<string> {
  const cropped = nativeImage
    .createFromBuffer(image)
    .crop({
      x: Math.max(0, Math.round(cropBbox.x)),
      y: Math.max(0, Math.round(cropBbox.y)),
      width: Math.max(1, Math.round(cropBbox.width)),
      height: Math.max(1, Math.round(cropBbox.height)),
    })
    .toPNG()
  const tmpPath = join(tmpdir(), `nuance-paddle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await writeFile(tmpPath, cropped)
  return tmpPath
}

/**
 * cropBbox 로 잘라낸 이미지를 PaddleOCR 로 인식해 글자/단어 단위 실제 bbox 를 그대로
 * 받는다(`return_word_box=True`) — Tesseract 때처럼 "글자 개수 비율로 폭 추정" 할
 * 필요가 없다(실측 확인: 그 추정 방식은 라틴 단어에서 최대 15px 어긋났었음). 실패하면
 * (Python 환경 없음 등) null 을 반환해 호출부가 Tesseract 로 폴백하게 한다.
 */
export async function recognizeWithPaddle(
  image: Buffer,
  language: Language,
  cropBbox: Rect,
): Promise<Word[] | null> {
  const tmpPath = await writeCrop(image, cropBbox)
  try {
    const { words } = await server.request<
      { image_path: string; language: string },
      { words: RawWord[] }
    >({ image_path: tmpPath, language })
    return words.map((w) => ({
      text: w.text,
      bbox: {
        x: cropBbox.x + w.x0,
        y: cropBbox.y + w.y0,
        width: w.x1 - w.x0,
        height: w.y1 - w.y0,
      },
    }))
  } catch (err) {
    console.error('[ocrPaddle] 인식 실패 — Tesseract 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

// 줄 위치만 찾는 용도(detectLinesWithPaddle)는 텍스트를 안 믿고 버리므로 언어를
// 호출부마다 다르게 받을 이유가 없다 — 오히려 호출부마다 다른 언어를 넘기면 PaddleOCR
// 엔진이 언어별로 따로 생성되는데, 실측해보니 엔진 하나 새로 만들 때마다(가중치 파일이
// 이미 캐시돼 있어도) 예측기 구성에만 15~20초가 걸린다(실사용 중 "본문 영역 자동 감지
// 폴백에서 en 엔진 + 실제 인식에서 ja 엔진, 총 30초+"로 확인). 게다가 로그를 보면 검출/
// 인식 모델 이름 자체가 언어에 무관하게 동일(`PP-OCRv6_medium_det`/`_rec`)해서 — 최신
// PaddleOCR 는 모델을 언어별로 따로 두지 않고 `lang` 은 주로 후처리(문자 사전)에만
// 쓰는 것으로 보인다. 그래서 "위치만" 필요한 호출은 전부 이 고정 태그로 통일해 같은
// 캐시된 엔진을 재사용하고, 실제 인식(recognizeWithPaddle)에만 진짜 언어를 쓴다 —
// 한 번의 선택에서 최대 2개(위치 전용 1개 + 실제 인식 언어 1개)까지만 새로 생성되게.
const DETECTION_ONLY_LANGUAGE: Language = 'en'

/**
 * 줄 단위 박스만 얻는다(텍스트는 안 믿고 버림) — 세로쓰기 일본어를 manga-ocr 로
 * 인식할 때 "어느 크롭을 manga-ocr 에 넘길지"를 정하거나(ocrManga.ts), DocLayout 이
 * 아예 실패했을 때 본문 영역을 텍스트 위치로 직접 추정하는 데(regionSelection.ts)
 * 쓴다.
 *
 * 넓은 크롭을 조각내 워커 풀에 병렬로 돌리는 방식을 두 번 시도했다 — 처음엔(검출이
 * `PaddleOCR.predict()` 풀 파이프라인이라 줄 개수에 비례해 느려지던 시절) 아예 효과가
 * 없었고, 검출 전용 API(`TextDetection`)로 바꿔 정말로 폭에 비례해서 느려지는 걸
 * 확인한 뒤 다시 시도했을 땐 소요 시간은 줄었지만(13.1초→11.6초) 조각 경계 근처에서
 * 검출된 줄의 박스 경계가 조각마다 미세하게 달라져서, x좌표 기반 열 재정렬
 * (clusterVerticalLinesIntoColumns)의 순서가 실제로 뒤바뀌는 문제가 실측 확인됐다
 * (예: 두 문장의 순서가 통째로 바뀜) — 1~2초 아끼자고 읽기 순서가 틀리는 건 손해가 커서
 * 다시 뺐다. 크롭 하나를 통째로(워커 하나로) 검출해야 조각 경계로 인한 오차가 없다.
 */
export async function detectLinesWithPaddle(image: Buffer, cropBbox: Rect): Promise<Rect[] | null> {
  const tmpPath = await writeCrop(image, cropBbox)
  try {
    const { lines } = await server.request<
      { image_path: string; language: string; mode: 'detect_lines' },
      { lines: RawLine[] }
    >({ image_path: tmpPath, language: DETECTION_ONLY_LANGUAGE, mode: 'detect_lines' })
    return lines.map((l) => ({
      x: cropBbox.x + l.x0,
      y: cropBbox.y + l.y0,
      width: l.x1 - l.x0,
      height: l.y1 - l.y0,
    }))
  } catch (err) {
    console.error('[ocrPaddle] 줄 검출 실패:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

// python/layout_detect.py 의 is_vertical_layout() 과 같은 기준(비율 임계값 1.4, 과반수
// 조건) — 다만 DocLayout 의 "문단(여러 줄 뭉치)" 단위 대신 PaddleOCR 의 "줄 하나" 단위
// 박스에 적용한다. 문단 단위는 가로쓰기라도 줄바꿈이 많으면 세로로 길어져 오판할 수
// 있는데(좁은 다단 레이아웃 등), 줄 하나하나는 그 문제가 없다 — 실측 확인: 진짜
// 세로쓰기 줄은 h/w 비율이 14~15 로 임계값(1.4)을 압도적으로 넘고, 가로쓰기 줄은 원래
// 폭이 넓고 높이가 얕아 1 미만이라 명확히 갈린다.
const VERTICAL_LINE_RATIO_THRESHOLD = 1.4
const VERTICAL_LINE_MIN_FRACTION = 0.5

/**
 * DocLayout 이 블록을 하나도 못 찾았을 때(blocks=0, `vertical` 판정 근거 자체가 없는
 * 상황) — PaddleOCR 로 직접 찾은 줄 박스 모양을 재서 가로/세로를 실측 판별한다. 이전엔
 * "언어가 ja/zh 면 무조건 세로쓰기로 가정"하는 블라인드 폴백을 썼는데, 실제로 보고
 * 판단하는 쪽이 더 정확하다.
 */
export function isVerticalByLineShape(lines: Rect[]): boolean {
  if (lines.length === 0) return false
  const verticalCount = lines.filter(
    (l) => l.width > 0 && l.height / l.width >= VERTICAL_LINE_RATIO_THRESHOLD,
  ).length
  return verticalCount / lines.length >= VERTICAL_LINE_MIN_FRACTION
}

// 후리가나(루비 문자)는 본문 옆에 훨씬 좁은 폭으로, 그 본문 글자와 y 범위가 겹치게
// 붙어서 검출된다 — 이전엔 "중앙값 대비 폭 비율"만으로 후리가나를 걸렀는데, 실측 확인
// 결과 그 방식은 그냥 짧은 본문 줄까지 오탐으로 같이 잘라냈다(이웃이 없어도 좁으면
// 다 걸림). 그래서 여기서는 "이 줄보다 훨씬 넓고(FURIGANA_WIDTH_RATIO 배 이상) y 범위가
// 많이 겹치는(FURIGANA_Y_OVERLAP_MIN 이상) '부모' 줄이 바로 옆에 있는가"를 직접 확인한다
// — 후리가나의 기하학적 특징(좁고, 본문 옆에 딱 붙어서, 같은 세로 범위를 차지) 자체를
// 보는 것이라 오탐이 훨씬 적다. 부모가 없는 좁은 줄(예: 짧은 독립된 본문 줄)은 그대로
// 살아남는다. 실제 여러 열짜리 페이지에서 이 필터 없이 열 병합을 했더니 후리가나가
// 만든 잡음 줄들 때문에 열 간격 판정 자체가 흔들려 순서가 뒤섞이고 내용이 빠지는 문제가
// 있었다(실측 확인) — 그래서 열 병합보다 먼저 적용한다.
const FURIGANA_WIDTH_RATIO = 1.8
const FURIGANA_Y_OVERLAP_MIN = 0.5
// 후리가나는 본문 글자에 거의 맞닿아 있다 — 간격이 이 배율(자기 폭 기준)보다 멀면
// "옆에 붙은 주석"이 아니라 그냥 다른 열로 본다.
const FURIGANA_MAX_GAP_RATIO = 2

function yOverlapFraction(a: Rect, b: Rect): number {
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const overlap = Math.max(0, bottom - top)
  const minHeight = Math.min(a.height, b.height)
  return minHeight > 0 ? overlap / minHeight : 0
}

function xGap(a: Rect, b: Rect): number {
  return Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
}

export function excludeFurigana(lines: Rect[]): Rect[] {
  return lines.filter((line) => {
    const hasWiderNeighbor = lines.some((other) => {
      if (other === line) return false
      if (other.width < line.width * FURIGANA_WIDTH_RATIO) return false
      if (yOverlapFraction(line, other) < FURIGANA_Y_OVERLAP_MIN) return false
      return xGap(line, other) <= line.width * FURIGANA_MAX_GAP_RATIO
    })
    return !hasWiderNeighbor
  })
}

// 세로쓰기 열이 여러 개인 페이지에서 DocLayout 이 열을 못 나눠주면(blocks=0) 줄 검출
// 결과가 열 구분 없이 전부 섞여서 온다 — 이걸 그냥 y좌표로만 정렬하면 서로 다른 열의
// 줄이 뒤섞여 읽힌다(예: A열 3번째 줄 다음에 B열 1번째 줄이 오는 식). x좌표로 다시 열을
// 묶어서 세로쓰기 순서(오른쪽 열부터, 각 열 안에서는 위→아래)로 바로잡는다. 열 간격
// 판정 기준은 줄 폭의 중앙값 — 세로쓰기 줄 하나의 폭은 대략 글자 크기라 같은 열 안의
// 줄들은 폭이 비슷하고, 다른 열로 넘어가면 그보다 확연히(1.5배 이상) 떨어진 x에 나타난다.
// 정상적인 단일 열(DocLayout 이 이미 열을 나눠준 경우 등)에서는 이 클러스터링이 그냥
// 열 1개로 수렴하므로 무해하다 — recognizeVerticalColumnWithPaddle 에서 항상 적용한다.
// (후리가나를 미리 걸러내지 않으면 그 좁은 잡음 줄들이 중앙값 폭 자체를 왜곡시켜서
// 열 간격 판정이 흔들린다 — 실측 확인.)
const COLUMN_GAP_RATIO = 1.5

export function clusterVerticalLinesIntoColumns(lines: Rect[]): Rect[] {
  if (lines.length <= 1) return lines
  const widths = [...lines].map((l) => l.width).sort((a, b) => a - b)
  const medianWidth = widths[Math.floor(widths.length / 2)]!
  const gapThreshold = medianWidth * COLUMN_GAP_RATIO

  // 오른쪽 열부터 읽는다(세로쓰기 관례) — x 중심 기준 내림차순으로 훑으며 묶는다.
  const byX = [...lines].sort((a, b) => b.x + b.width / 2 - (a.x + a.width / 2))

  const columns: Rect[][] = []
  const columnCenterSum: number[] = []
  const columnCount: number[] = []
  for (const line of byX) {
    const center = line.x + line.width / 2
    const last = columns.length - 1
    if (last >= 0 && Math.abs(columnCenterSum[last]! / columnCount[last]! - center) <= gapThreshold) {
      columns[last]!.push(line)
      columnCenterSum[last]! += center
      columnCount[last]!++
    } else {
      columns.push([line])
      columnCenterSum.push(center)
      columnCount.push(1)
    }
  }

  for (const column of columns) column.sort((a, b) => a.y - b.y) // 열 안에서는 위→아래
  return columns.flat()
}

// 검출된 줄 bbox 를 여백 없이 그대로 크롭하면 글자 획이 경계에 살짝 걸려 잘리는 경우가
// 있다(실측 확인: 실제 페이지에서 폭 22~27px 짜리 좁은 줄 중 하나가 완전히 다른 글자로
// 오인식됐고, 특히 아주 짧은 줄 "だが。"(높이 56px, 글자 2개)는 "なっ"로 잘못 읽혔다).
// 가로 여백은 0으로 둔다 — 실측해보니 3px만 줘도 세로쓰기 열끼리 간격이 좁은 곳(몇 px
// 밖에 안 되는 경우도 있음)에서 옆 열 글자 일부가 크롭에 섞여 들어와 오히려 다른 오류를
// 만들었다(레이피아→레레이피아처럼 옆 글자 중복/탈락, 문장 앞부분 잘림). 세로는 그 위험이
// 적어서(열 위/아래는 보통 여백이 있음) 여백을 유지한다.
const LINE_PADDING_X = 0
const LINE_PADDING_Y = 6

function padLine(line: Rect): Rect {
  return {
    x: line.x - LINE_PADDING_X,
    y: line.y - LINE_PADDING_Y,
    width: line.width + LINE_PADDING_X * 2,
    height: line.height + LINE_PADDING_Y * 2,
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// PaddleOCR 의 `text_word`는 대체로 글자 하나 단위지만 항상 그렇지는 않다 — 실측 확인:
// 히라가나가 연속되는 구간에서 "まさか、こんな"(7글자)처럼 여러 글자가 원시 단위 하나로
// 뭉쳐서 오고, 그 bbox 는 그 7글자 전체를 감싸는 사각형 하나뿐이다(개별 글자 위치 정보가
// 없음). 이 경우 세로쓰기 줄 안에서 위→아래로 읽히므로 "높이"를 나눠 각 글자의 근사
// 위치를 만들어야 하는데, 글자 수로 그냥 균등 분할하면(마진 높이/글자수) 실측 확인 결과
// 여전히 박스가 실제 글자와 눈에 띄게 어긋났다 — 실제로는 한자(약 20~25px)와 조사/작은
// 가나(그보다 훨씬 얇게 검출되는 경우가 흔함, 예: が/を/で 가 3~4px로 검출된 사례 다수)의
// 실측 높이가 균일하지 않아서, 그냥 나눈 값은 어느 글자에도 잘 안 맞는 절충값이 된다.
// 대신 실측으로 얻은(다른 곳에서 글자 하나 단위로 잘 떼어진 원시 단위들의 실측 높이
// 중앙값 — typicalHeight) "전형적인 글자 높이"를 가운데 글자들에 그대로 적용한다.
//
// 남은 오차(전형값 합계와 실제 합쳐진 bbox 높이의 차이)를 처음엔 마지막 글자 하나에
// 전부 몰아줬는데, 실측 확인 결과 그러면 마지막 글자만 유독 심하게 어긋나 보였다(실사용
// 중 "밑테두리가 마지막 글자 중간에 있음"으로 확인, 반대로 첫 글자는 멀쩡해 보임 —
// 오차가 한쪽에만 쏠리니 그쪽만 도드라짐). 그래서 오차를 첫 글자와 마지막 글자 양쪽에
// 절반씩 나눠 흡수시킨다 — 가운데 글자들은 그대로 전형값을 쓰고, 양 끝만 조금씩(전체
// 오차의 절반씩만) 어긋나서 어느 한쪽만 크게 튀는 일이 줄어든다. 글자가 2개뿐이면
// "가운데"가 없어 양쪽이 곧 전체이므로 자연히 균등 분할과 같아진다.
//
// 전형값을 가운데 글자들에 다 채우면 합쳐진 bbox 범위를 넘어버리는 경우(단독 글자
// 참고 표본이 없어 전형값을 못 구했거나, 전형값이 이 구간엔 안 맞는 경우)엔 기존처럼
// 균등 분할로 안전하게 되돌아간다.
function splitCharBbox(bbox: Rect, charCount: number, typicalHeight: number | null): Rect[] {
  if (charCount <= 1) return [bbox]
  const middleCount = charCount - 2
  const fitsTypical = typicalHeight && typicalHeight * middleCount < bbox.height
  let heights: number[]
  if (fitsTypical) {
    const edgeHeight = (bbox.height - typicalHeight! * middleCount) / 2
    heights = [edgeHeight, ...Array(middleCount).fill(typicalHeight), edgeHeight]
  } else {
    heights = Array(charCount).fill(bbox.height / charCount)
  }
  const boxes: Rect[] = []
  let y = bbox.y
  for (const h of heights) {
    boxes.push({ x: bbox.x, y, width: bbox.width, height: h })
    y += h
  }
  return boxes
}

/**
 * ocr.ts 의 Tesseract CJK 경로(buildCjkLineWords)는 이미 형태소 분석기(kuromoji/segmentit)
 * 로 의미 단위 재조합을 하는데, 이 Paddle 경로엔 그 단계가 없어서 최종 Word[] 가 전부
 * 글자(또는 위 splitCharBbox 이전 기준 원시 단위) 단위로 나가고 있었다(팝업 하이라이트/
 * 클릭 단위가 "단어"가 아니라 "글자"가 되는 문제). 같은 분석기를 재사용해 줄 하나(=붙어
 * 있는 글자 시퀀스) 안에서 의미 단위 경계를 다시 잡는다.
 *
 * splitCharBbox 로 먼저 모든 원시 단위를 글자 1개=배열 원소 1개로 완전히 풀어두면(아래
 * flatChars) 문자열 오프셋(segmentJapaneseWords/segmentChineseWords 의 [start,end))과
 * 배열 인덱스가 항상 1:1이라 그대로 슬라이스할 수 있다 — 이걸 안 하고 원시 단위 배열에
 * 바로 슬라이스하면(예전 버전) 원시 단위 하나가 글자 2개 이상을 담은 경우부터 배열
 * 인덱스가 문자열 오프셋보다 앞서가서 그 뒤로 모든 그룹의 경계가 밀리고, 그 원시 단위의
 * "합쳐진 큰 bbox"를 여러 단어가 그대로 나눠 갖게 돼 서로 겹치는 박스가 생겼다(실사용 중
 * "클릭한 단어와 팝업에서 선택된 단어가 다름", "박스 테두리가 글자 가운데 있음"으로 확인
 * — 겹치는 박스끼리 findWordAtPoint 의 최소 면적 우선 규칙이 클릭 위치와 무관하게 뒤섞여
 * 골랐던 것).
 *
 * segmentJapaneseWords/segmentChineseWords 는 문장부호만 있는 조각을 걸러내고 반환하는데,
 * 그 걸러진 문자를 그냥 버리면 팝업 본문 텍스트에서 문장부호가 통째로 사라진다(실사용
 * 확인). 그래서 boundaries 가 비운 구간(gap)의 글자는 원래 단위(글자 1개) 그대로 결과에
 * 끼워 넣어 원문을 그대로 보존한다 — 다만 bbox 는 없앤다: 문장부호는 클릭 가능한
 * "단어"가 아닌데 bbox 를 그대로 두면 오버레이에 박스가 뜨고 클릭도 돼버린다(실사용 중
 * "쉼표에 박스가 생기고, 누르면 그 위 단어가 선택됨"으로 확인 — findWordAtPoint 가
 * bbox 있는 항목만 클릭 대상으로 보므로 bbox 를 없애면 자동으로 클릭 대상에서 빠진다).
 *
 * typicalHeight(전형적 글자 높이)는 이 줄만 봐서 계산하지 않고 호출부(recognizeOrderedLines)
 * 가 같은 컬럼 세트 전체의 실측 단일 글자 높이로 미리 계산해 넘겨준다 — 줄이 짧으면
 * (특히 "だが" 처럼 글자 2~3개짜리) 참고할 단독 글자 표본이 거의 없어 중앙값이 불안정해질
 * 수 있어서, 표본이 많은 전체 컬럼 세트 기준이 더 안정적이다(실사용 중 "한 글자짜리
 * 단어인데 박스가 글자를 다 못 덮음"으로 확인된 사례들이 대부분 이런 표본 부족 케이스).
 */
async function groupCjkChars(
  chars: Word[],
  language: 'ja' | 'zh-Hans' | 'zh-Hant',
  typicalHeight: number | null,
): Promise<Word[]> {
  if (chars.length === 0) return []
  const text = chars.map((c) => c.text).join('')
  const boundaries = [...(language === 'ja' ? await segmentJapaneseWords(text) : segmentChineseWords(text))].sort(
    (a, b) => a.start - b.start,
  )
  const flatChars: Word[] = chars.flatMap((c) => {
    const codepoints = [...c.text]
    if (!c.bbox || codepoints.length <= 1) return codepoints.map((ch) => ({ text: ch, bbox: c.bbox }))
    const boxes = splitCharBbox(c.bbox, codepoints.length, typicalHeight)
    return codepoints.map((ch, i) => ({ text: ch, bbox: boxes[i] }))
  })

  const words: Word[] = []
  let pos = 0
  const pushGapChars = (end: number) => {
    for (; pos < end; pos++) {
      const c = flatChars[pos]
      if (c) words.push({ text: c.text })
    }
  }
  for (const b of boundaries) {
    pushGapChars(b.start)
    const group = flatChars.slice(b.start, b.end).filter((c) => c.bbox)
    if (group.length > 0) {
      const x0 = Math.min(...group.map((c) => c.bbox!.x))
      const y0 = Math.min(...group.map((c) => c.bbox!.y))
      const x1 = Math.max(...group.map((c) => c.bbox!.x + c.bbox!.width))
      const y1 = Math.max(...group.map((c) => c.bbox!.y + c.bbox!.height))
      words.push({ text: b.text, bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
    }
    pos = b.end
  }
  pushGapChars(flatChars.length)
  return words
}

/** 줄 목록을 정해진 순서 그대로 병렬 인식해 이어붙인다 — 실패한 줄이 하나라도 있으면
 * 전체를 null 로 반환해 호출부가 Tesseract 로 통째 폴백하게 한다. zh/ja 는 줄 하나
 * 단위로 groupCjkChars 를 거쳐 글자 단위 결과를 의미 단위 단어로 재조합한다(위 주석
 * 참고) — 이 함수의 호출부(recognizeVerticalColumnWithPaddle/recognizeLinesWithPaddle)
 * 는 전부 zh/ja 전용이라 language 는 항상 이 셋 중 하나다. */
async function recognizeOrderedLines(image: Buffer, language: Language, orderedLines: Rect[]): Promise<Word[] | null> {
  const perLine = await Promise.all(orderedLines.map((line) => recognizeWithPaddle(image, language, padLine(line))))
  if (perLine.some((words) => !words)) return null
  if (language !== 'ja' && language !== 'zh-Hans' && language !== 'zh-Hant') {
    return perLine.flatMap((words) => words!)
  }
  // typicalHeight(전형적 글자 높이)는 이 컬럼 세트의 모든 줄에 걸쳐 실측으로 단일 글자
  // 단위로 잘 떼어진 원시 단위들의 높이 중앙값이다 — groupCjkChars 주석 참고(줄 하나만
  // 보면 표본이 부족할 수 있어 전체 세트 기준으로 계산).
  const allSingleCharHeights = perLine.flatMap((words) =>
    words!.filter((w) => w.bbox && [...w.text].length === 1).map((w) => w.bbox!.height),
  )
  const typicalHeight = allSingleCharHeights.length > 0 ? median(allSingleCharHeights) : null
  const grouped = await Promise.all(perLine.map((words) => groupCjkChars(words!, language, typicalHeight)))
  return grouped.flat()
}

/**
 * 세로쓰기 열 하나(또는 열 구분이 안 된 영역 전체)를 manga-ocr 대신 PaddleOCR 로
 * 인식한다 — 실측 비교(합성 세로쓰기 8줄): 같은 조건(워커 풀 3개, 병렬)에서 PaddleOCR
 * 1.6초 vs manga-ocr 7.6초로 약 4.6배 빨랐고, 회전 트릭 없이도(세로쓰기는 글자 자체는
 * 똑바로 서 있고 읽는 방향만 위→아래라 PaddleOCR 인식 모델이 그대로 정확히 읽음) 정확도도
 * 100% 일치했다. manga-ocr 은 망가 말풍선 같은 손글씨풍 폰트 전용으로 남겨두고(ocrManga.ts,
 * 지금은 기본 경로에서 안 씀 — 필요해지면 다시 연결), 일반 활자 세로쓰기(소설/책 PDF 등)는
 * 이 함수를 기본으로 쓴다.
 *
 * detectLinesWithPaddle 로 줄 위치를 먼저 찾고, 열이 여러 개 섞여있을 수 있으니
 * clusterVerticalLinesIntoColumns 로 순서를 바로잡은 뒤 줄마다 recognizeWithPaddle 을
 * 병렬로 호출한다 — recognizeWithPaddle 을 영역 전체에 한 번만 호출해도 PaddleOCR 자체
 * 검출기가 내부적으로 텍스트를 찾긴 하지만, 그 결과 순서가 세로쓰기 읽기 순서를
 * 보장한다는 근거가 없어서(가로쓰기 기준으로 설계된 정렬) 줄 단위로 직접 나눠 순서를
 * 우리가 확정짓는 쪽을 택했다.
 */
export async function recognizeVerticalColumnWithPaddle(
  image: Buffer,
  language: Language,
  columnBbox: Rect,
  precomputedLines?: Rect[],
): Promise<Word[] | null> {
  // precomputedLines 가 오면 재검출 안 한다 — DocLayout 이 블록을 못 찾았을 때(ocr.ts)
  // 가로/세로 판별용으로 이미 이 크롭에 detectLinesWithPaddle 을 한 번 돌려놨는데, 여기서
  // 또 같은 크롭에 같은 호출을 하면 완전히 중복된 작업이라(실측: 이 호출 자체가 페이지
  // 전체 크롭일 땐 38초까지도 걸림) 호출부가 넘겨주면 그대로 재사용한다.
  const lines = precomputedLines ?? (await detectLinesWithPaddle(image, columnBbox))
  if (!lines || lines.length === 0) return []
  // 열 병합보다 먼저 후리가나를 걸러낸다 — excludeFurigana 주석 참고(후리가나 잡음 줄이
  // 남아있으면 열 폭 중앙값이 왜곡돼 clusterVerticalLinesIntoColumns 의 간격 판정이
  // 흔들린다, 실측 확인: 순서 뒤섞임/내용 누락).
  const bodyLines = excludeFurigana(lines)
  const ordered = clusterVerticalLinesIntoColumns(bodyLines)
  return recognizeOrderedLines(image, language, ordered)
}

/**
 * ocr.ts 가 DocLayout 실패(blocks=0) + 가로쓰기로 판별된 영역 전체를 인식할 때 쓴다.
 * 열 구분이 없는 단일 영역이라 가로쓰기 읽기 순서는 그냥 위→아래(줄바꿈 순서)면 충분해서
 * (세로쓰기처럼 여러 열이 나란히 있는 경우와 달리, 이 경로에서 여러 단(다단)까지
 * 섞이는 경우는 아직 확인된 바 없어 다루지 않는다 — 필요해지면 나중에 확장) 클러스터링은
 * 안 하고 y좌표로만 정렬한다. `recognizeWithPaddle` 을 영역 전체에 한 번 호출하는 대신
 * 줄 단위로 나눠 병렬 호출하는 이유는 recognizeVerticalColumnWithPaddle 과 같다(실측:
 * 페이지 전체를 한 번에 넘기면 38초, 열/줄 병렬화가 전혀 안 먹는 경로였음).
 */
export async function recognizeLinesWithPaddle(
  image: Buffer,
  language: Language,
  bbox: Rect,
  precomputedLines?: Rect[],
): Promise<Word[] | null> {
  const lines = precomputedLines ?? (await detectLinesWithPaddle(image, bbox))
  if (!lines || lines.length === 0) return []
  const ordered = [...lines].sort((a, b) => a.y - b.y)
  return recognizeOrderedLines(image, language, ordered)
}

/**
 * 앱 시작 시(warmup.ts) 미리 불러서 풀의 워커 전부에 PaddleOCR 엔진을 만들어둔다 —
 * 워커마다 모델을 독립적으로 로드하므로(프로세스 간 공유 안 됨) 한 워커만 예열하면
 * 나머지는 실제 사용 시점에야 콜드 스타트를 겪는다. 위치 전용 엔진(en, detectLinesWithPaddle
 * 이 항상 쓰는 것)과 지금 우선 대상인 일본어 인식 엔진 둘 다 예열한다.
 *
 * `server.warmUpAll()`은 `recognizeWithPaddle`/`detectLinesWithPaddle`(에러를 내부에서
 * 잡아 null 반환)을 거치지 않고 서버에 직접 요청하므로 Python 쪽 에러가 나면 그대로
 * reject 된다 — 여기서 안 잡으면 warmup.ts 의 `Promise.all([...])`이 통째로 reject 돼서
 * (다른 엔진은 멀쩡해도) "예열 완료" 상태로 절대 안 넘어가고 창 선택 버튼이 계속
 * 막혀있게 된다. 그래서 이 함수는 절대 reject 하지 않도록 직접 잡는다.
 */
export async function warmUp(): Promise<void> {
  try {
    const tmpPath = await writeCrop(TINY_PNG, { x: 0, y: 0, width: 1, height: 1 })
    try {
      await server.warmUpAll({ image_path: tmpPath, language: DETECTION_ONLY_LANGUAGE, mode: 'detect_lines' })
      await server.warmUpAll({ image_path: tmpPath, language: 'ja' })
    } finally {
      void unlink(tmpPath).catch(() => {})
    }
  } catch (err) {
    console.error('[ocrPaddle] 예열 실패(무시):', err)
  }
}
