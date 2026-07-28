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

// ja/zh 인식 백엔드를 여러 개(PaddleOCR, Yomitoku) 두면서 이 필터를 Rect 뿐 아니라
// "Rect + 그 줄의 텍스트" 같은 확장 타입에도 그대로 쓸 일이 생겨서(ocrYomitoku.ts)
// 제네릭으로 바꿨다 — 내부 로직은 Rect 필드(x/y/width/height)만 보고 그 외 필드는
// 아예 안 건드리므로 동작 변화 없음, 기존 호출부(Rect[] 그대로 넘김)도 그대로 동작한다.
//
// widthRatio 를 인자로 뺀 이유: Yomitoku 의 후리가나 검출 박스는 PaddleOCR 만큼 타이트하게
// 안 잘려서(실측 확인: 본문 대비 1.4~1.75배 정도, PaddleOCR 는 보통 2배 이상) 기본값
// (FURIGANA_WIDTH_RATIO=1.8, PaddleOCR 기준으로 튜닝됨)으로는 실제 후리가나가 안 걸러지고
// 그대로 열로 남아 열 순서/기준선 계산을 오염시켰다(실사용 중 확인) — ocrYomitoku.ts 는
// 더 낮은 값을 넘겨써서 이 문제를 피한다. PaddleOCR 호출부는 인자를 안 넘기므로 기존
// 동작(1.8) 그대로 유지된다.
export function excludeFurigana<T extends Rect>(lines: T[], widthRatio: number = FURIGANA_WIDTH_RATIO): T[] {
  return lines.filter((line) => {
    const hasWiderNeighbor = lines.some((other) => {
      if (other === line) return false
      if (other.width < line.width * widthRatio) return false
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

// excludeFurigana 와 같은 이유로 제네릭화(ocrYomitoku.ts 에서 "Rect + 텍스트" 쌍을
// 그대로 재정렬하는 데 재사용) — 내부는 Rect 필드만 본다.
export function clusterVerticalLinesIntoColumns<T extends Rect>(lines: T[]): T[] {
  if (lines.length <= 1) return lines
  const widths = [...lines].map((l) => l.width).sort((a, b) => a - b)
  const medianWidth = widths[Math.floor(widths.length / 2)]!
  const gapThreshold = medianWidth * COLUMN_GAP_RATIO

  // 오른쪽 열부터 읽는다(세로쓰기 관례) — x 중심 기준 내림차순으로 훑으며 묶는다.
  const byX = [...lines].sort((a, b) => b.x + b.width / 2 - (a.x + a.width / 2))

  const columns: T[][] = []
  const columnCenterSum: number[] = []
  const columnCount: number[] = []
  for (const line of byX) {
    const center = line.x + line.width / 2
    const last = columns.length - 1
    // 경계값(간격이 정확히 gapThreshold 와 같은 경우)은 "다른 열"로 본다(<= 가 아니라 <)
    // — 실측 확인: 어떤 페이지에서 서로 다른 두 열의 중심 간격이 medianWidth*COLUMN_GAP_RATIO
    // 와 정확히 일치해서(글자 폭이 균일한 조판이라 우연이 아니라 실제로 자주 맞아떨어짐)
    // <= 였을 때 두 열이 하나로 합쳐져 버렸고, 합쳐진 뭉치 안에서 y좌표로 재정렬되며 읽기
    // 순서가 뒤섞였다(오른쪽 열이 왼쪽 열보다 늦게 읽힘). 경계에서는 "합치지 않음" 쪽이
    // 더 안전한 기본값이다 — 잘못 합쳐지면 순서가 깨지지만, 잘못 안 합쳐지면(같은 열이
    // 조각나 있던 경우) 최악의 경우도 조각들이 별개 열처럼 취급될 뿐 순서 자체는 유지된다.
    if (last >= 0 && Math.abs(columnCenterSum[last]! / columnCount[last]! - center) < gapThreshold) {
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

export function padLine(line: Rect): Rect {
  return {
    x: line.x - LINE_PADDING_X,
    y: line.y - LINE_PADDING_Y,
    width: line.width + LINE_PADDING_X * 2,
    height: line.height + LINE_PADDING_Y * 2,
  }
}

// PaddleOCR 의 `text_word`가 주는 개별 bbox 크기는 못 믿는다 — 실측 확인 결과 글자
// 하나짜리 원시 단위도 が/を/で 같은 조사가 3~4px 높이로 잡히는 등 들쭉날쭉하고(모델
// CTC 디코딩 특성상 나온 결과일 뿐, 실제 글자 칸 크기가 아님), 여러 글자가 원시 단위
// 하나(bbox 하나)로 뭉쳐 오는 경우(예: "まさか、こんな" 7글자가 박스 하나)까지 겹치면
// 그 안에서 이 개별 bbox 들을 기준으로 아무리 추정해도 실제 글자 위치와 어긋났다
// (실사용 중 "박스 테두리가 글자 가운데 있음" 등으로 계속 확인됨).
//
// 대신 세로쓰기/가로쓰기 CJK 조판은 관례적으로 글자 한 칸이 전부 같은 크기인 균등
// 격자다(활자 조판 "몇 자 詰め" 관례) — 그래서 PaddleOCR 의 개별 bbox 크기는 전부
// 버리고, 이미 신뢰하는 줄 전체의 검출 범위(lineRect, detectLinesWithPaddle 결과)를
// 그 줄의 실제 글자 수로 균등 격자 분할해 각 글자 칸의 위치를 새로 만든다. 그 격자
// 위에 Sudachi/kuromoji 가 정한 단어 경계를 그대로 얹어 단어 박스(칸 여러 개를 이어붙인
// 사각형)를 만든다 — PaddleOCR 가 내부적으로 글자를 어떻게 뭉쳐서 줬는지는 완전히
// 무시되므로(텍스트만 가져다 씀) 뭉침 여부와 무관하게 항상 같은 방식으로 정확하다.
//
// vertical=true(세로쓰기, 위→아래로 읽음)면 높이를 글자 수로 나누고, false(가로쓰기,
// 왼→오로 읽음)면 폭을 나눈다 — 이 함수는 recognizeVerticalColumnWithPaddle(세로)와
// recognizeLinesWithPaddle(가로 폴백) 양쪽에서 공유해서 쓰이므로 방향을 인자로 받는다.
// 문장부호(、。 등)를 다른 글자보다 좁게(반각) 칠 가능성을 고려해봤는데, 실제 대상
// 문서에서는 문장부호도 전각(다른 글자와 같은 폭)으로 조판돼 있어 그냥 모든 글자를
// 동일 가중치(1칸)로 균등 분할한다.
//
// typicalCellSize 를 주면(estimateCellSizeFromIndent 로 구한, 이 컬럼 세트 전체의
// 들여쓰기 기반 기준값) 그걸 그대로 칸 크기로 쓰고, 없으면(그 기준값을 못 구한 경우)
// 이 줄 자신의 "검출 범위 ÷ 글자 수"로 되돌아간다 — 후자는 검출 모델이 글자 사이
// 여백까지 포함 안 하고 잉크에만 딱 맞게 범위를 잡는 경향이 있어(실측 확인) 실제 칸
// 크기보다 살짝 작게 나오고, 글자 위치가 누적합이라 줄 아래로 갈수록 그 작은 오차가
// 쌓여 어긋남이 커진다 — 페이지 전체에서 공통으로 구한 기준값을 쓰면 이 누적 오차가
// 없다.
// 세로쓰기 조판 관례(縦中横, tate-chū-yoko) — 아라비아 숫자가 정확히 2자리 연속으로
// 나오면(예: "16") 세로 두 칸이 아니라 가로로 나란히 눕혀서 한 칸에 압축해 넣는다(실측
// 확인: 레ベル 뒤의 "16"이 딱 한 글자 높이 안에 들어가 있음). 1자리나 3자리 이상인
// 숫자 연속, 숫자+기호 조합(예: "+5")은 압축 안 되고 그대로 한 칸씩 차지한다(실측
// 확인: "+5"는 "+"와 "5"가 각각 따로 한 칸씩). 이 압축을 안 셈에 넣으면 "16"을 2칸으로
// 쳐서 그 뒤 모든 글자 위치가 한 칸씩 밀린다(실사용 중 "그 다음 글자에 박스가 안 뜨고
// 밑에 밀림"으로 확인).
const DIGIT_RE = /[0-9]/

export function computeSlotWeights(codepoints: string[]): number[] {
  const weights = new Array(codepoints.length).fill(1)
  let i = 0
  while (i < codepoints.length) {
    if (!DIGIT_RE.test(codepoints[i]!)) {
      i++
      continue
    }
    let j = i
    while (j < codepoints.length && DIGIT_RE.test(codepoints[j]!)) j++
    if (j - i === 2) {
      weights[i] = 0.5
      weights[i + 1] = 0.5
    }
    i = j
  }
  return weights
}

export async function groupCjkCharsGrid(
  lineRect: Rect,
  text: string,
  language: 'ja' | 'zh-Hans' | 'zh-Hant',
  vertical: boolean,
  typicalCellSize: number | null,
): Promise<Word[]> {
  const codepoints = [...text]
  if (codepoints.length === 0) return []
  const boundaries = [
    ...(language === 'ja' ? await segmentJapaneseWords(text) : await segmentChineseWords(text, language)),
  ].sort((a, b) => a.start - b.start)
  const weights = computeSlotWeights(codepoints)
  const cumulative: number[] = [0]
  for (const w of weights) cumulative.push(cumulative[cumulative.length - 1]! + w)
  const totalWeight = cumulative[cumulative.length - 1]!
  const cellSize = typicalCellSize ?? (vertical ? lineRect.height : lineRect.width) / totalWeight

  const words: Word[] = []
  let pos = 0
  // boundaries 가 비운 구간(문장부호 등 형태소 분석기가 걸러낸 글자)은 원문 보존을 위해
  // 텍스트만 그대로 끼워 넣는다 — bbox 는 안 준다(클릭 가능한 "단어"가 아니므로 오버레이에
  // 박스가 뜨거나 클릭되면 안 된다, 실사용 중 "쉼표에 박스 생김"으로 확인).
  const pushGapChars = (end: number) => {
    for (; pos < end; pos++) words.push({ text: codepoints[pos]! })
  }
  for (const b of boundaries) {
    pushGapChars(b.start)
    const start = cumulative[b.start]! * cellSize
    const span = (cumulative[b.end]! - cumulative[b.start]!) * cellSize
    words.push({
      text: b.text,
      bbox: vertical
        ? { x: lineRect.x, y: lineRect.y + start, width: lineRect.width, height: span }
        : { x: lineRect.x + start, y: lineRect.y, width: span, height: lineRect.height },
    })
    pos = b.end
  }
  pushGapChars(codepoints.length)
  return words
}

/** 줄 목록을 정해진 순서 그대로 병렬 인식해 이어붙인다 — 실패한 줄이 하나라도 있으면
 * 전체를 null 로 반환해 호출부가 Tesseract 로 통째 폴백하게 한다. zh/ja 는 PaddleOCR 의
 * 인식 텍스트만 가져다 쓰고(bbox 는 안 믿음) `groupCjkCharsGrid`로 줄 자체의 검출 범위를
 * 격자 분할해 단어 박스를 다시 만든다(위 주석 참고) — 이 함수의 호출부
 * (recognizeVerticalColumnWithPaddle/recognizeLinesWithPaddle)는 전부 zh/ja 전용이라
 * language 는 항상 이 셋 중 하나다. */
async function recognizeOrderedLines(
  image: Buffer,
  language: Language,
  orderedLines: Rect[],
  vertical: boolean,
): Promise<Word[] | null> {
  const perLine = await Promise.all(orderedLines.map((line) => recognizeWithPaddle(image, language, padLine(line))))
  if (perLine.some((words) => !words)) return null
  if (language !== 'ja' && language !== 'zh-Hans' && language !== 'zh-Hant') {
    return perLine.flatMap((words) => words!)
  }
  const texts = perLine.map((words) => words!.map((w) => w.text).join(''))
  // 세로쓰기에서만 대시(―) 보정을 시도한다 — 가로쓰기 폴백 경로는 이 문제 대상이 아니다.
  const { texts: finalTexts, typicalCellSize } = vertical
    ? await insertUndetectedMarks(
        orderedLines,
        perLine.map((w) => w!),
        texts,
      )
    : { texts, typicalCellSize: null }
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `texts-${Date.now()}.json`),
      JSON.stringify(
        orderedLines.map((line, i) => ({ x: line.x, before: texts[i], after: finalTexts[i], changed: texts[i] !== finalTexts[i] })),
        null,
        2,
      ),
    )
  }
  const grouped = await Promise.all(
    orderedLines.map((line, i) => groupCjkCharsGrid(line, finalTexts[i]!, language, vertical, typicalCellSize)),
  )
  return grouped.flat()
}

export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * "글자 하나당 실제 크기"(typicalCellSize)를 세로쓰기 관례(문단/대사 시작 컬럼만 한 칸
 * 들여쓰기)를 이용해 구한다 — 컬럼별 (검출 범위 ÷ 인식된 글자 수)의 중앙값을 쓰던
 * 이전 방식은 인식이 실패한 컬럼(글자 수 자체가 틀림, 예: "有" 한 글자로 뭉개진 경우)
 * 이 섞이면 기준값 자체가 오염됐다(실사용 중 확인). 컬럼의 "위쪽 시작 y좌표"는 인식
 * 품질과 무관한 순수 검출 정보라 훨씬 깨끗하다 — 대부분 컬럼이 공유하는 기준선(baseline,
 * 가장 많이 겹치는 y좌표)을 찾고, 그보다 뚜렷이 아래에서 시작하는(들여쓰기된) 컬럼들의
 * 차이값이 곧 글자 하나의 높이다. 들여쓰기된 컬럼이 하나도 없으면(전부 기준선에서
 * 시작) 이전 방식(글자 수 기반)으로 되돌아간다.
 */
// 후리가나 잔재 등 짧은 조각 줄은 본문 컬럼과 무관한 y좌표에 떠 있어(실측 확인: 이런
// 조각들 때문에 기준선 계산이 엉뚱한 값으로 튐 — 77px 같은 비정상적인 "글자 하나 높이"가
// 나온 사례). 본문 컬럼만 골라 쓰기 위한 최소 높이 기준.
// ocrYomitoku.ts 도 같은 필터(짧은 잡음 줄 제외 후 기준선 계산)를 재사용한다.
export const MIN_BODY_LINE_HEIGHT = 100

/**
 * 여러 컬럼(줄)이 공유하는 "기준선"(들여쓰기 없는 문단/컬럼들의 공통 시작 y좌표) —
 * ocrYomitoku.ts 도 같은 개념(대시 미검출로 줄이 기준선보다 아래서 시작하는지 판정)이
 * 필요해서 분리해 export 한다. 최빈값 기준이라 후리가나 등 잡음이 섞여도(MIN_BODY_LINE_HEIGHT
 * 로 이미 걸렀다는 전제 하에) 안정적이다.
 */
export function computeBaseline(bodyLines: Rect[]): number | null {
  if (bodyLines.length < 2) return null
  const rounded = bodyLines.map((l) => Math.round(l.y / 5) * 5)
  const counts = new Map<number, number>()
  for (const y of rounded) counts.set(y, (counts.get(y) ?? 0) + 1)
  let baseline = rounded[0]!
  let bestCount = 0
  for (const [y, c] of counts) {
    // 동점이면 더 작은 y(=들여쓰기 없는 "기준" 쪽일 가능성이 더 큼)를 우선한다.
    if (c > bestCount || (c === bestCount && y < baseline)) {
      bestCount = c
      baseline = y
    }
  }
  return baseline
}

export function estimateCellSizeFromIndent(lines: Rect[]): number | null {
  const bodyLines = lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT)
  const baseline = computeBaseline(bodyLines)
  if (baseline === null) return null
  const diffs = bodyLines.map((l) => l.y - baseline).filter((d) => d > 5)
  if (diffs.length === 0) return null
  // 평균을 실제로 테스트해보니(직접 확인) diff 값들이 뚜렷이 다른 두 무리로 갈렸다 —
  // 진짜 "문단 들여쓰기 1칸"(17~22 근방)과, 대시 등 미검출 구간 때문에 훨씬 더 밀린
  // 열(50~53 근방, 3칸 가까이)이 섞여 있어서 평균을 내면 어느 쪽도 아닌 애매한 값
  // (예: 1칸도 3칸도 아닌 1.7칸어치)이 나왔다. 최빈값(2px 단위로 반올림해 가장 많이
  // 겹치는 값)을 쓰면 이런 소수의 이상치 무리에 안 끌려가고 실제로 더 많이 나타나는
  // "진짜" 들여쓰기 값을 그대로 찾아낸다.
  const roundedDiffs = diffs.map((d) => Math.round(d / 2) * 2)
  const diffCounts = new Map<number, number>()
  for (const d of roundedDiffs) diffCounts.set(d, (diffCounts.get(d) ?? 0) + 1)
  let best = roundedDiffs[0]!
  let bestDiffCount = 0
  for (const [d, c] of diffCounts) {
    if (c > bestDiffCount) {
      bestDiffCount = c
      best = d
    }
  }
  return best
}

// 미검출/미식별 구간(대시 외에도 종류가 다양함 — 물결표, 각종 강조 기호 등)을 표시할
// 때 쓰는 공통 자리표자. 처음엔 "―"(대시)로 단정하고 채웠는데, 실사용 중 세로쓰기에서
// 몇 칸을 차지하는 기호 종류가 대시 말고도 여러 가지 있고 그때마다 어떤 기호인지
// 정확히 맞히는 게 오히려 오류를 늘린다는 게 확인돼서(사용자 판단) — 정확한 기호를
// 추정하려 들지 않고 "여기 뭔가 있었는데 못 읽었다"는 사실만 통일된 표시(게타 마크,
// 일본어 문헌에서 미판독 글자를 표시하는 관례)로 팝업 본문에 남긴다.
export const UNKNOWN_GAP_PLACEHOLDER = '〓'

/**
 * 세로쓰기 일본어 소설에서 문장 시작/전환에 쓰이는 대시(―)나 그 밖의 몇 칸짜리 기호는
 * 획이 단순해서 텍스트 검출 모델이 아예 텍스트로 못 잡는 경우가 많다(실측 확인) —
 * detectLinesWithPaddle 이 잡은 줄 범위(line)가 이런 미검출 여백을 포함하고 있으면,
 * 그 범위를 인식된 글자 수만큼 나눠 칸을 만들 때(groupCjkCharsGrid) 분모에 안 들어간
 * 여백만큼 칸이 커져서 뒤 글자들 위치가 전부 계통적으로 밀린다(실사용 중 확인) — 이런
 * 미검출 구간이 줄 맨 앞뿐 아니라 중간·끝에 오는 경우도 실제로 확인됨.
 *
 * 이미지 픽셀 모양(얇고 긴 직선인지)으로 판별하는 방식을 먼저 시도했는데, 실측 확인
 * 결과 진짜 글자의 잉크가 우연히 얇게 잡히는 경우와 구분이 잘 안 돼 오탐이 잦았다.
 * 대신 **PaddleOCR 가 실제로 인식해낸 글자(원시 단위)들 사이의 y 간격**을 직접 비교한다
 * — 원시 단위 하나하나의 정확한 크기는 못 믿어도(실측 확인), 두 원시 단위 사이에 기준
 * 칸 크기(typicalCellSize)의 약 2배에 달하는 빈틈이 있다는 건 훨씬 큰 신호라 믿을 만하다.
 * 이런 간격이 줄 맨 앞(줄 시작~첫 원시 단위), 중간(원시 단위끼리), 맨 끝(마지막 원시
 * 단위~줄 끝) 어디에 있든 같은 방식으로 잡아낸다. 간격 크기(기준 칸 크기의 몇 배인지
 * 반올림)만큼 UNKNOWN_GAP_PLACEHOLDER 를 텍스트에 끼워 넣고, 그 뒤로는 원래 인식된
 * 글자를 순서대로 이어 붙인다 — 이러면 이후 groupCjkCharsGrid 가 "줄 범위 ÷ 글자 수
 * (자리표자 포함)"로 나눠도 미검출 구간이 어디에 있었든 정확한 자리에 놓인다(줄 범위
 * 자체는 안 건드리므로 별도 좌표 보정이 필요 없음). 정확히 어떤 기호였는지는 추정하지
 * 않는다 — 위 UNKNOWN_GAP_PLACEHOLDER 주석 참고.
 *
 * 간격이 기준 칸 크기의 1.5배 미만이면(원시 단위 사이의 정상적인 여백 수준) 무시한다 —
 * PaddleOCR 인식 실패로 여러 글자가 통째로 빠진 경우(실측 확인된 별개 문제, 예: 10글자
 * 넘는 내용이 "有" 한 글자로 뭉개짐)는 보통 원시 단위 자체가 그 넓은 범위를 통째로
 * 차지해버려서(그 하나의 원시 단위 bbox 가 비정상적으로 큼) 단위 "사이"의 간격으로는
 * 안 나타나므로 이 방식에서 자연히 걸러진다.
 */
// ocrYomitoku.ts 도 같은 배율(줄 시작이 기준선보다 1.5~3칸 아래면 미검출 구간으로 판단,
// 딱 1칸이면 문단 들여쓰기 관례로 판단)을 재사용한다 — 판정 자체의 근거(몇 칸짜리
// 기호는 육안상 다른 글자보다 넓은 공백을 차지)는 인식 엔진이 바뀌어도 동일하다.
export const GAP_RATIO_THRESHOLD = 1.5
// 이 배율을 넘는 간격은 기호가 아니라 PaddleOCR 인식 실패(여러 글자가 통째로 안 잡힘,
// 실측 확인된 별개 문제 — 예: 10글자 넘는 내용이 "有" 한 글자로 뭉개짐)로 본다 — 이런
// 경우까지 전부 자리표자로 채우면 이미 망가진 인식 결과를 더 이상하게 만든다.
export const MAX_GAP_RATIO = 3

/**
 * 줄 하나 안에서, 인식된 원시 단위(글자/조각, bbox 있는 것만)들 사이의 y 간격을 보고
 * 미검출 구간에 자리표자를 끼워 넣은 텍스트를 만든다 — insertUndetectedMarks(여러
 * 줄을 한 번에 처리, 자체적으로 typicalCellSize 를 추정)의 단일 줄 버전. ocrYomitoku.ts
 * 가 Yomitoku 결과 중 줄 끝/중간에 미검출 구간이 의심되는 줄만 PaddleOCR 로 다시 인식해
 * (글자 단위 좌표를 얻어) 이 함수로 정확한 위치에 자리표자를 넣는 데도 재사용한다 —
 * 그때는 이미 페이지 전체에서 구한 typicalCellSize 를 그대로 넘겨써서(이 줄 하나로
 * 다시 추정하면 노이즈가 큼) 다른 줄들과 격자가 어긋나지 않게 한다.
 */
export function insertGapPlaceholdersForLine(line: Rect, units: Word[], text: string, typicalCellSize: number): string {
  if (units.length === 0) return text

  // gaps: [원시 단위 배열상 삽입 위치(문자 오프셋), 끼워 넣을 자리표자 개수][]
  const gaps: [number, number][] = []
  const countAt = (upTo: number) => [...units.slice(0, upTo).map((u) => u.text).join('')].length

  const inRange = (gap: number) =>
    gap >= typicalCellSize * GAP_RATIO_THRESHOLD && gap <= typicalCellSize * MAX_GAP_RATIO

  const leadingGap = units[0]!.bbox!.y - line.y
  if (inRange(leadingGap)) {
    gaps.push([0, Math.round(leadingGap / typicalCellSize)])
  }
  for (let k = 1; k < units.length; k++) {
    const prev = units[k - 1]!
    const gap = units[k]!.bbox!.y - (prev.bbox!.y + prev.bbox!.height)
    if (inRange(gap)) {
      gaps.push([countAt(k), Math.round(gap / typicalCellSize)])
    }
  }
  const last = units[units.length - 1]!
  const trailingGap = line.y + line.height - (last.bbox!.y + last.bbox!.height)
  if (inRange(trailingGap)) {
    gaps.push([countAt(units.length), Math.round(trailingGap / typicalCellSize)])
  }
  if (gaps.length === 0) return text

  // 뒤에서부터 끼워 넣어야 앞쪽 삽입이 뒤쪽 삽입 위치(문자 오프셋)를 안 밀리게 한다.
  const codepoints = [...text]
  for (const [idx, count] of [...gaps].sort((a, b) => b[0] - a[0])) {
    codepoints.splice(idx, 0, ...Array(count).fill(UNKNOWN_GAP_PLACEHOLDER))
  }
  return codepoints.join('')
}

async function insertUndetectedMarks(
  lines: Rect[],
  perLine: Word[][],
  texts: string[],
): Promise<{ texts: string[]; typicalCellSize: number | null }> {
  const rawCellSizes = lines
    .map((line, i) => {
      const n = [...texts[i]!].length
      return n > 0 ? line.height / n : null
    })
    .filter((v): v is number => v !== null)
  const fallbackCellSize = rawCellSizes.length > 0 ? median(rawCellSizes) : null
  const typicalCellSize = estimateCellSizeFromIndent(lines) ?? fallbackCellSize
  if (!typicalCellSize) return { texts, typicalCellSize: null }

  const newTexts = lines.map((line, i) => {
    const units = perLine[i]!.filter((w) => w.bbox)
    return insertGapPlaceholdersForLine(line, units, texts[i]!, typicalCellSize)
  })
  return { texts: newTexts, typicalCellSize }
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
  return recognizeOrderedLines(image, language, ordered, true)
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
  return recognizeOrderedLines(image, language, ordered, false)
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
