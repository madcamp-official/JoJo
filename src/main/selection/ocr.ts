import { createWorker, type Worker } from 'tesseract.js'
import type { Language, Rect, Word } from '@shared/types'
import type { Extracted } from './extractDirect'

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

export async function runOcr(image: Buffer, language: Language, region?: Rect): Promise<Extracted> {
  const w = await getWorker(language)
  // blocks 출력은 기본 꺼져 있음 — 단어별 bbox 를 얻으려면 명시적으로 켜야 한다.
  // region 을 주면 Tesseract 가 그 사각형 안쪽만 인식한다(SetRectangle) — 반환되는
  // bbox 는 여전히 원본 이미지 전체 기준 절대좌표라 이후 정렬 로직은 안 바꿔도 된다.
  const recognizeOptions = region
    ? { rectangle: { left: region.x, top: region.y, width: region.width, height: region.height } }
    : {}
  const { data } = await w.recognize(image, recognizeOptions, { blocks: true })

  const words: Word[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          // 높이는 단어 자체 bbox 대신 줄(line) bbox 를 쓴다 — 단어 bbox 는 그 단어를
          // 구성하는 글자의 실제 잉크 범위만 딱 맞춰서 나와서, 어센더/디센더(g/y/p 등)가
          // 없는 단어는 자연히 낮게 나오고 같은 줄에서도 단어마다 높이가 들쭉날쭉해진다.
          // 줄 bbox 는 그 줄 전체 기준이라 같은 줄의 단어들이 통일된 높이로 보인다.
          words.push(...splitWordBySymbols(word, line.bbox))
        }
      }
    }
  }

  return { text: normalizeOcrText(data.text), language, words: removeNoise(words) }
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
interface OcrSymbol { text: string; bbox: OcrBbox }

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

// 여백(위/아래) 판정 비율 — 캡처 내용의 세로 범위 중 이만큼을 헤더/푸터 후보로 본다.
const MARGIN_RATIO = 0.05
// 순수 숫자 — 페이지 번호/글자 수 등으로 추정. 본문 중간의 연도·개수 등을 잘못 지우는
// 걸 막기 위해 여백 안에 있을 때만 이 패턴에 적용한다(아래 removeNoise 참고).
const NUMBER_RE = /^\d+$/
// 메뉴바 상태표시줄에 흔히 붙는 단위/라벨 — 하단 여백에서만 적용.
const STATUS_LABEL_RE = /^(자|글자|줄|words?|characters?|chars?|ln|col|line)$/i
// 메뉴바에 흔히 쓰이는 단어(한/영, 대소문자 무시) — 그 자체로는 본문에도 나올 수 있는
// 흔한 단어라(예: "File"), 아래 removeNoise 에서 "같은 줄에 이 목록 단어가 2개 이상"
// 일 때만 실제 메뉴바로 인정해서 오탐을 줄인다.
const MENU_WORDS = new Set(
  ['파일', '편집', '보기', '서식', '삽입', '도구', '창', '도움말',
    'file', 'edit', 'view', 'format', 'insert', 'tools', 'window', 'help'].map((w) => w.toLowerCase()),
)

/** 같은 줄(line) 식별 키 — ocr.ts 가 단어 높이를 line bbox 로 통일해두므로(y/height 동일) 별도 필드 없이 그룹핑 가능. */
function lineKey(word: Word): string {
  return `${word.bbox!.y}:${word.bbox!.height}`
}

/**
 * 좌표 기반 노이즈 제거 (제목/페이지 번호/메뉴바·상태표시줄 등) — PLAN.md §6. 캡처
 * 한 장(위치 휴리스틱)만으로 판단하는 1차 버전. 세 가지 규칙을 적용한다:
 *  1) 메뉴바: 상단 여백에서 "같은 줄에 메뉴 단어(MENU_WORDS)가 2개 이상" 있는 줄만
 *     진짜 메뉴바로 인정하고 그 단어들만 제거 — 단어 1개만으로 지우면 본문에 "File"
 *     같은 흔한 단어가 우연히 여백에 걸렸을 때 잘못 지워질 위험이 커서, "메뉴바는
 *     여러 메뉴가 한 줄에 나란히 있다"는 구조적 특징으로 보강했다.
 *  2) 페이지 번호/글자 수: 위/아래 여백의 순수 숫자 토큰 제거.
 *  3) 상태표시줄 라벨: 하단 여백의 "자"/"words"/"Ln"/"Col" 등 단위 라벨 제거.
 * 여백에 있다고 전부 지우면(제목 포함) 여백 없이 본문이 가장자리부터 바로 시작하는
 * 창(예: 메모장)에서 진짜 본문 첫 줄까지 날아갈 위험이 커서, 오탐이 비교적 명확한
 * 케이스로 좁혔다 — 정확도는 이 정도가 한계. 더 정확한 판별은 여러 캡처에 걸쳐 같은
 * 위치에 반복되는지 보는 2차 방식(TODO.md)이 필요.
 */
export function removeNoise(words: Word[]): Word[] {
  const boxed = words.filter((w) => w.bbox)
  if (boxed.length === 0) return words

  const minY = Math.min(...boxed.map((w) => w.bbox!.y))
  const maxY = Math.max(...boxed.map((w) => w.bbox!.y + w.bbox!.height))
  const span = maxY - minY
  if (span <= 0) return words

  // 여백을 "전체 내용 높이의 5%"로만 잡으면, 메뉴바~상태바까지 전체 높이가 짧은 창
  // (메모장에 몇 줄 안 써져 있는 경우 등)에서는 5%가 실제 한 줄 높이보다도 작아져서
  // 메뉴바/상태바 자신조차 "여백 안"을 통과 못 하는 문제가 있었다 — 그래서 맨 위/아래
  // 줄 자신의 높이를 최소 보장선으로 같이 반영한다(그 줄은 항상 여백 판정에 들어오게).
  // 대신 짧은 캡처에서 여백이 과도하게 커지지 않도록 span 의 40%로 상한을 둔다.
  const topLineHeight = boxed.find((w) => w.bbox!.y === minY)?.bbox!.height ?? 0
  const bottomLineHeight = boxed.find((w) => w.bbox!.y + w.bbox!.height === maxY)?.bbox!.height ?? 0
  const maxMargin = span * 0.4
  const topMargin = Math.min(Math.max(span * MARGIN_RATIO, topLineHeight * 1.2), maxMargin)
  const bottomMargin = Math.min(Math.max(span * MARGIN_RATIO, bottomLineHeight * 1.2), maxMargin)

  const topBoundary = minY + topMargin
  const bottomBoundary = maxY - bottomMargin
  const inTop = (w: Word) => w.bbox!.y + w.bbox!.height <= topBoundary
  const inBottom = (w: Word) => w.bbox!.y >= bottomBoundary

  // 상단 여백에서 줄별로 메뉴 단어 개수를 세어, 2개 이상인 줄만 "확인된 메뉴바"로 인정.
  const menuLineHits = new Map<string, number>()
  for (const word of boxed) {
    if (!inTop(word) || !MENU_WORDS.has(word.text.toLowerCase())) continue
    const key = lineKey(word)
    menuLineHits.set(key, (menuLineHits.get(key) ?? 0) + 1)
  }
  const confirmedMenuLines = new Set(
    [...menuLineHits.entries()].filter(([, count]) => count >= 2).map(([key]) => key),
  )

  return words.filter((word) => {
    if (!word.bbox) return true
    if (inTop(word) && MENU_WORDS.has(word.text.toLowerCase()) && confirmedMenuLines.has(lineKey(word))) {
      return false
    }
    if ((inTop(word) || inBottom(word)) && NUMBER_RE.test(word.text)) return false
    if (inBottom(word) && STATUS_LABEL_RE.test(word.text)) return false
    return true
  })
}
