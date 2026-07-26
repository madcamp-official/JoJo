import { nativeImage } from 'electron'
import { createWorker, type Worker } from 'tesseract.js'
import type { Language, Rect, Word } from '@shared/types'
import type { Extracted } from './extractDirect'
import { detectLayoutBlocks, mergeIntoColumns, padRect } from './layoutDetect'

// YOLO 블록 bbox 를 Tesseract crop 사각형으로 쓸 때 더하는 여유(padRect 주석 참고) —
// 실측 결과 가로는 줄 끝 단어가 통째로 깨지지 않으려면 50px은 필요했고(10~30px 는
// 부족), 세로는 크게 주면 메뉴바/툴바 문구가 딸려 들어와서 작게 유지한다.
const BLOCK_PADDING_X = 50
const BLOCK_PADDING_Y = 12

// 담당 A — OCR 엔진 래퍼 (PLAN.md §4.1 / §6 / §8)
// 범용 엔진: Tesseract.js 채택 확정(오프라인, 언어팩 교체로 다국어 대응). 언어별 특화
// 엔진(예: 중국어 PaddleOCR)은 나중에 벤치마킹 후 라우팅 추가 — 지금은 Tesseract 단일 경로.

const TESS_LANG: Record<Language, string> = { en: 'eng', ja: 'jpn', zh: 'chi_sim' }

// 언어별 워커를 재사용한다 — 언어팩 로드 비용이 커서(수 MB 다운로드/초기화) 매 호출마다
// 새로 만들지 않는다. 언어가 바뀌면 이전 워커를 정리하고 새로 만든다.
let worker: Worker | null = null
let workerLang: Language | null = null

async function getWorker(language: Language): Promise<Worker> {
  if (worker && workerLang === language) return worker
  if (worker) await worker.terminate()
  worker = await createWorker(TESS_LANG[language])
  workerLang = language
  return worker
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
export async function runOcr(image: Buffer, language: Language, region?: Rect): Promise<Extracted> {
  const w = await getWorker(language)
  const layoutBlocks = await detectLayoutBlocks(image, region)
  const columns = layoutBlocks ? mergeIntoColumns(layoutBlocks) : null

  if (columns && columns.length > 1) {
    const clampBounds: Rect =
      region ?? (() => {
        const { width, height } = nativeImage.createFromBuffer(image).getSize()
        return { x: 0, y: 0, width, height }
      })()
    const texts: string[] = []
    const words: Word[] = []
    for (const column of columns) {
      const paddedBbox = padRect(column.bbox, BLOCK_PADDING_X, BLOCK_PADDING_Y, clampBounds)
      const result = await recognizeRegion(w, image, paddedBbox)
      if (result.text) texts.push(result.text)
      words.push(...result.words)
    }
    return { text: texts.join('\n\n'), language, words }
  }

  const result = await recognizeRegion(w, image, region)
  return { text: result.text, language, words: result.words }
}

/** 이미지 한 장(전체 또는 region 으로 제한된 한 블록)을 인식해 텍스트+단어 bbox 를 뽑는다. */
async function recognizeRegion(
  w: Worker,
  image: Buffer,
  region?: Rect,
): Promise<{ text: string; words: Word[] }> {
  // blocks 출력은 기본 꺼져 있음 — 단어별 bbox 를 얻으려면 명시적으로 켜야 한다.
  // region 을 주면 Tesseract 가 그 사각형 안쪽만 인식한다(SetRectangle) — 반환되는
  // bbox 는 여전히 원본 이미지 전체 기준 절대좌표라 이후 정렬 로직은 안 바꿔도 된다.
  const recognizeOptions = region
    ? { rectangle: { left: region.x, top: region.y, width: region.width, height: region.height } }
    : {}
  const { data } = await w.recognize(image, recognizeOptions, { blocks: true })

  const lines = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines),
  )
  // 영역의 맨 위/아래 줄이 다른 줄보다 확연히 낮으면, 위/아래 경계가 그 줄 중간을
  // 가로질러서 글자 위쪽/아래쪽 절반만 보이는 것으로 본다(findEdgeClippedLines) — 이
  // 경우 그 줄 전체를 통째로 제외한다.
  const clippedLines = region ? findEdgeClippedLines(lines) : new Set<(typeof lines)[number]>()

  const words: Word[] = []
  for (const line of lines) {
    if (clippedLines.has(line)) continue
    for (const word of line.words) {
      // 잘린 단어는 통째로 제외한다 — 두 가지 다른 원인을 각각 다른 방법으로 잡는다.
      //  1) 우리가 지정한 영역 경계 자체가 단어 중간을 가로지르는 경우: Tesseract 는
      //     rectangle 옵션으로 크롭된 픽셀만 보므로 bbox 가 그 경계에 거의 딱 붙어서
      //     나온다(isWordClippedByRegion). 하지만 사용자가 영역을 넉넉하게(글자 주변에
      //     여백을 두고) 잡았다면, 실제 잘림은 영역 안쪽 — 원본 화면 자체에서 이미 잘려
      //     보이는 경우(예: 스크롤 패널 경계에 걸친 줄)일 수 있고, 이때 bbox 는 영역
      //     경계와 거리가 있어서 위 방식으로는 못 잡는다.
      //  2) 그래서 인식 신뢰도(confidence)도 같이 본다: 글자 획 일부만 보이는 상태로
      //     인식되면 Tesseract 도 확신을 못 해서 대체로 confidence 가 낮게 나온다
      //     (looksTruncated) — 위치와 무관하게 "제대로 안 보인 글자"를 잡아낸다.
      if (region && (isWordClippedByRegion(word.bbox, region) || looksTruncated(word))) continue
      // 높이는 단어 자체 bbox 대신 줄(line) bbox 를 쓴다 — 단어 bbox 는 그 단어를
      // 구성하는 글자의 실제 잉크 범위만 딱 맞춰서 나와서, 어센더/디센더(g/y/p 등)가
      // 없는 단어는 자연히 낮게 나오고 같은 줄에서도 단어마다 높이가 들쭉날쭉해진다.
      // 줄 bbox 는 그 줄 전체 기준이라 같은 줄의 단어들이 통일된 높이로 보인다.
      words.push(...splitWordBySymbols(word, line.bbox))
    }
  }

  return { text: normalizeOcrText(data.text), words }
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

/**
 * Tesseract 가 조립한 원문은 관례적으로 문단 사이엔 연속 개행(빈 줄), 한 문단 안의
 * 줄바꿈은 단일 개행을 쓴다. 단일 개행은 캡처 당시 창 폭 기준으로 어쩌다 끊긴 자리일
 * 뿐이라 의미가 없어서 공백으로 합치고, 연속 개행(진짜 문단 구분)만 유지한다 —
 * 안 그러면 팝업처럼 원본과 다른 폭의 컨테이너에 표시할 때 엉뚱한 자리에서 줄이
 * 끊겨 보인다.
 */
function normalizeOcrText(raw: string): string {
  return raw
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n')
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

// 단어 평균 신뢰도가 이보다 낮으면 잘렸을 가능성이 큰 것으로 본다. 정상 단어가
// 오탐으로 같이 빠지진 않는 게 확인돼서 임계값을 더 올려 잡아내는 범위를 넓혔다.
const MIN_WORD_CONFIDENCE = 90
// 단어 전체 평균은 넘겨도, 특정 글자 하나만 유독 신뢰도가 낮으면(예: 마지막 글자만
// 반쯤 잘림) 그 한 글자 때문에 단어 전체가 부정확해지므로 별도로 확인한다.
const MIN_SYMBOL_CONFIDENCE = 75

/**
 * 위치(isWordClippedByRegion)가 아니라 "제대로 안 보이는 글자"를 인식 신뢰도로 판정한다.
 * 사용자가 영역을 넉넉하게 잡아서 잘린 지점이 영역 경계와 멀리 떨어져 있어도(예: 원본
 * 화면 자체의 스크롤 패널 경계에 걸쳐 반만 보이는 줄), 글자 획 일부만 보이면 Tesseract
 * 도 확신을 못 해 confidence 가 낮게 나오는 경향을 이용한다 — 위치 기반 판정을 못
 * 빠져나가는 잘림까지 잡기 위한 보완 규칙.
 */
function looksTruncated(word: { confidence: number; symbols?: OcrSymbol[] }): boolean {
  if (word.confidence < MIN_WORD_CONFIDENCE) return true
  return (word.symbols ?? []).some((s) => s.confidence < MIN_SYMBOL_CONFIDENCE)
}

// 끝에 붙는 문장부호(마침표·쉼표·닫는 인용부호/괄호 등, 한/영/일 공통) — 박스 계산에서
// 만 제외하고 심볼 자체는 버린다(뒤에 더 없는 "끝"에서만 적용, 단어 중간엔 안 건드림).
const TRAILING_PUNCT_RE = /^[.,!?;:'")\]}»›」』、。！？；：]$/
// em dash(—)/en dash(–) — 이걸로 이어진 표현은 두 단어로 취급해 박스를 나눈다.
// (일반 하이픈(-)은 well-to-do 처럼 한 단어 취급이 맞는 경우가 많아 건드리지 않는다.)
const DASH_CHARS = new Set(['—', '–'])

/**
 * Tesseract 단어 1개를 글자(symbol) 단위로 훑어서, em/en dash 를 경계로 여러 단어로
 * 쪼개고 각 조각 끝의 문장부호는 텍스트에서 제외한다. `symbols` 가 없으면(드묾) 기존
 * 단어 bbox 그대로 반환.
 *
 * 개별 글자의 bbox 는 어디에도 신뢰하지 않는다 — 마침표·쉼표 같은 작은 문장부호는
 * Tesseract 가 잡는 경계 상자가 실제보다 부풀려져서(앞 글자 쪽으로 침범) 나오는
 * 경우가 있어서, 그걸 "잘라내는 기준선"으로 쓰면 마지막 글자가 통째로 잘리거나
 * 반만 잡히는 문제가 생겼다(대시 자신의 bbox 를 기준선으로 썼을 때도 마찬가지 위험).
 * 그래서:
 *  - 대시가 없는 단어: 박스는 원본 단어 bbox 를 그대로 유지(잘림 위험 자체가 없음),
 *    끝 문장부호는 텍스트 문자열에서만 제거한다.
 *  - 대시가 있는 단어: 어차피 조각마다 별도 박스가 필요해서 폭을 나눠야 하는데,
 *    개별 글자 bbox 대신 "글자 개수 비율"로 원본 폭을 나눈다 — 완벽히 정밀하진
 *    않지만(글자 폭이 다 다르므로) 어떤 심볼 bbox 도 안 믿으므로 잘림 위험이 없다.
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

  const hasDash = symbols.some((s) => DASH_CHARS.has(s.text))

  if (!hasDash) {
    let end = symbols.length
    while (end > 0 && TRAILING_PUNCT_RE.test(symbols[end - 1]!.text)) end--
    if (end === 0) return [mk(word.text, word.bbox.x0, word.bbox.x1)] // 전부 문장부호면(드묾) 원본 유지
    const text = symbols.slice(0, end).map((s) => s.text).join('')
    return [mk(text, word.bbox.x0, word.bbox.x1)]
  }

  // 대시를 경계로 글자 그룹을 나눈다(대시 자신은 어느 그룹에도 안 넣음). 대시가 차지하는
  // 폭은 그룹 사이 "빈 틈"으로 따로 기록해둔다 — 이 폭을 안 빼고 그냥 전체 폭을 글자 수
  // 비율로만 나누면, 대시 자신의 공간이 양쪽 단어 중 하나에 잘못 흡수돼서(단어 길이
  // 비율에 따라) 대시 한가운데서 잘리거나 통째로 한쪽 박스에 포함되는 문제가 있었다.
  const groups: OcrSymbol[][] = []
  const gapWidths: number[] = [] // gapWidths[i] = groups[i] 와 groups[i+1] 사이 대시 폭
  let current: OcrSymbol[] = []
  for (const sym of symbols) {
    if (DASH_CHARS.has(sym.text)) {
      if (current.length > 0) {
        groups.push(current)
        gapWidths.push(sym.bbox.x1 - sym.bbox.x0)
        current = []
      }
      // current 가 비어있는 채로 대시를 만나면(대시가 맨 앞 등, 드묾) 그냥 건너뜀.
    } else {
      current.push(sym)
    }
  }
  if (current.length > 0) groups.push(current)

  const totalGapWidth = gapWidths.reduce((sum, w) => sum + w, 0)
  const totalWidth = word.bbox.x1 - word.bbox.x0 - totalGapWidth
  const totalLen = groups.reduce((sum, g) => sum + g.length, 0)
  if (totalLen === 0) return []

  const results: Word[] = []
  let x = word.bbox.x0
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!
    const isLast = i === groups.length - 1
    let end = group.length
    if (isLast) {
      while (end > 0 && TRAILING_PUNCT_RE.test(group[end - 1]!.text)) end--
    }
    const fullWidth = totalWidth * (group.length / totalLen)
    if (end > 0) {
      const keptWidth = totalWidth * (end / totalLen)
      const text = group.slice(0, end).map((s) => s.text).join('')
      results.push(mk(text, x, x + keptWidth))
    }
    x += fullWidth
    if (i < gapWidths.length) x += gapWidths[i]!
  }
  return results
}
