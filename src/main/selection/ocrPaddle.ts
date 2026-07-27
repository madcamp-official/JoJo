import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Language, Rect, Word } from '@shared/types'
import { createPythonServerPool, TINY_PNG } from './pythonServer'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). PaddleOCR(python/ocr_paddle.py)
// 로 en/zh/ja(가로쓰기) 텍스트를 검출+인식한다 — 일본어 스캔 파일에서 Tesseract
// 인식률이 낮아서(실사용 확인) 도입. Tesseract 의 `rectangle` 옵션 같은 크롭 restrict
// 가 PaddleOCR 엔 없어서, 여기서 직접 크롭한 이미지를 Python 에 넘긴다 — 그래서
// 응답 bbox 는 크롭 기준 상대좌표이고, cropBbox 원점을 더해 절대좌표로 되돌린다.
//
// 워커를 여러 개 띄운다(POOL_SIZE) — 다단 레이아웃은 열마다 따로 인식을 돌려야 해서
// (ocr.ts) 워커가 하나면 열이 여러 개일 때 전부 한 줄로 서서 기다린다(실사용 중
// "세로쓰기 페이지 인식이 오래 걸림"으로 확인). 워커마다 모델을 독립적으로 메모리에
// 올려서(공유 안 됨) 메모리 사용량이 그만큼 늘어나는 트레이드오프가 있다.
const POOL_SIZE = 3
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

// 세로쓰기 열이 여러 개인 페이지에서 DocLayout 이 열을 못 나눠주면(blocks=0) 줄 검출
// 결과가 열 구분 없이 전부 섞여서 온다 — 이걸 그냥 y좌표로만 정렬하면 서로 다른 열의
// 줄이 뒤섞여 읽힌다(예: A열 3번째 줄 다음에 B열 1번째 줄이 오는 식). x좌표로 다시 열을
// 묶어서 세로쓰기 순서(오른쪽 열부터, 각 열 안에서는 위→아래)로 바로잡는다. 열 간격
// 판정 기준은 줄 폭의 중앙값 — 세로쓰기 줄 하나의 폭은 대략 글자 크기라 같은 열 안의
// 줄들은 폭이 비슷하고, 다른 열로 넘어가면 그보다 확연히(1.5배 이상) 떨어진 x에 나타난다.
// 정상적인 단일 열(DocLayout 이 이미 열을 나눠준 경우 등)에서는 이 클러스터링이 그냥
// 열 1개로 수렴하므로 무해하다 — recognizeVerticalColumnWithPaddle 에서 항상 적용한다.
const COLUMN_GAP_RATIO = 1.5

function clusterVerticalLinesIntoColumns(lines: Rect[]): Rect[] {
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

/** 줄 목록을 정해진 순서 그대로 병렬 인식해 이어붙인다 — 실패한 줄이 하나라도 있으면
 * 전체를 null 로 반환해 호출부가 Tesseract 로 통째 폴백하게 한다. */
async function recognizeOrderedLines(image: Buffer, language: Language, orderedLines: Rect[]): Promise<Word[] | null> {
  const perLine = await Promise.all(orderedLines.map((line) => recognizeWithPaddle(image, language, line)))
  if (perLine.some((words) => !words)) return null
  return perLine.flatMap((words) => words!)
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
  const ordered = clusterVerticalLinesIntoColumns(lines)
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
