import type { ExtractedSelection, JaToken, SelectionContext, Word, ZhWord } from '@shared/types'
import { computeContextRange } from '@shared/context'
import { mergeJaTokens } from '@shared/nlp/ja'

// ============================================================================
// 담당 B — 팝업 안에서의 범위 재지정 (PLAN.md §4.1 "팝업 내 범위 지정")
//
// 팝업이 뜬 뒤 사용자가 원문 문맥을 드래그해 선택 범위를 바꿀 수 있게 한다.
//  - 영어: 단어(atom) 단위. 단, "well-to-do" 처럼 하이픈으로 묶인 표현은
//    well / to / do 각각을 별도 atom 으로 쪼개, 하이픈 단어 하나하나도 따로 선택 가능.
//  - 초기 선택: 담당 A 가 넘긴 selectedText(예: "well-to-do") 전체가 선택된 상태로 연다.
//
// 표시 텍스트 = precedingText + selectedText + followingText 를 하나의 문자열로 보고,
// 그 위에서 atom(선택 단위) 오프셋을 계산한다. 선택 결과는 다시 이 오프셋으로 slice 한다.
// (일/중 문자 단위 확장은 atom 규칙만 언어별로 바꾸면 되도록 分離)
// ============================================================================

/** 선택 가능한 최소 단위(단어 조각) 하나. display 문자열 상의 [start, end) 오프셋. */
export interface Atom {
  start: number
  end: number
}

export interface PopupSelectionModel {
  /** preceding + selected + following 를 이은 표시 문자열 */
  displayText: string
  atoms: Atom[]
  /** 초기 선택에 해당하는 atom 인덱스 범위 [from, to] (양끝 포함) */
  initialFrom: number
  initialTo: number
  /** displayText 오프셋 → extracted.text 오프셋 역산에 쓰는 값(buildDisplayText 참고) */
  windowStart: number
  insertions: number[]
}

// 팝업 원문 문맥 표시 범위 — 선택 앞뒤 각 256 바이트.
// 순수 바이트 경계에서 문장이 잘리면 가장 가까운 문장 경계까지 더 넣어서 보여주고,
// 원문이 그만큼 없으면(문서 시작/끝 근처) 있는 만큼만 보여준다 — @shared/context 공유 로직.
const DISPLAY_CONTEXT_BYTES_BEFORE = 256
const DISPLAY_CONTEXT_BYTES_AFTER = 256

// 문단(줄바꿈) 시작에 넣는 들여쓰기 — 설정 화면 미리보기(SettingsScreen.tsx PREVIEW_TEXT)와
// 동일한 1칸 공백 관례를 그대로 따른다. 원문에 이미 들여쓰기(공백/탭)가 있으면 건드리지 않고,
// 없을 때만 넣어서 "있으면 그대로, 없으면 있는 것처럼 보이게" 만든다.
// 일반 스페이스(U+0020)는 .ctx-text 의 white-space: pre-line 렌더링에서 줄바꿈 직후
// 공백으로 축약(제거)되어 화면에 안 보인다 — 축약 대상이 아닌 non-breaking space 를 쓴다.
const PARAGRAPH_INDENT = ' '

/**
 * displayText 의 각 문단 시작에 들여쓰기를 넣고, selStart/selEnd 를 삽입된 만큼 보정해
 * 반환한다. 창은 문장 경계로만 확장되므로(computeContextRange) 첫 줄이 항상 문단 시작인
 * 건 아니다 — 문단 중간에서 창이 시작하면 그 첫 줄은 이어지는 텍스트일 뿐이므로
 * firstIsParagraphStart 가 false 일 때만 첫 줄 들여쓰기를 건너뛴다.
 *
 * insertions(출력 문자열 상 들여쓰기가 삽입된 위치, 오름차순)도 함께 반환한다 — LLM 문맥
 * 구성 시 displayText 오프셋을 들여쓰기 이전(windowedText) 오프셋으로 되돌리는 데 쓰인다
 * (toWindowedOffset 참고).
 */
function indentParagraphs(
  text: string,
  selStart: number,
  selEnd: number,
  firstIsParagraphStart: boolean,
): { text: string; selStart: number; selEnd: number; insertions: number[] } {
  const paragraphs = text.split('\n')
  let newSelStart = selStart
  let newSelEnd = selEnd
  let offset = 0
  let outOffset = 0
  const insertions: number[] = []
  const out = paragraphs.map((p, i) => {
    const paraStart = offset
    offset += p.length + 1 // +1 = 소비되는 '\n'
    if (i === 0 && !firstIsParagraphStart) {
      outOffset += p.length + 1
      return p
    }
    if (/^[ \t]/.test(p)) {
      outOffset += p.length + 1
      return p
    }
    if (paraStart <= selStart) newSelStart += PARAGRAPH_INDENT.length
    if (paraStart <= selEnd) newSelEnd += PARAGRAPH_INDENT.length
    insertions.push(outOffset)
    outOffset += PARAGRAPH_INDENT.length + p.length + 1
    return PARAGRAPH_INDENT + p
  })
  return { text: out.join('\n'), selStart: newSelStart, selEnd: newSelEnd, insertions }
}

/** displayText(들여쓰기 포함) 오프셋을 windowedText(들여쓰기 이전) 오프셋으로 되돌린다. */
function toWindowedOffset(displayPos: number, insertions: number[]): number {
  let removed = 0
  for (const insPos of insertions) {
    if (insPos > displayPos) break
    removed += PARAGRAPH_INDENT.length
  }
  return displayPos - removed
}

// 영어 atom: 알파벳/숫자 연속(내부 아포스트로피 허용). 하이픈은 경계로 취급 →
// "well-to-do" 는 well / to / do 세 atom, "left-hand" 는 left / hand 두 atom 이 된다.
const LATIN_ATOM_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/y

// 한자(중/일 공통) atom: 한 글자가 곧 atom 하나 — "天线" 은 天 / 线 두 atom 으로,
// 원하는 한 글자만 골라 선택할 수도 있다(PLAN.md §4.1 "문자 단위 세밀 선택").
const KANJI_CHAR_RE = /[一-鿿㐀-䶿]/

// 가나(히라가나+가타카나) 한 덩어리 — 아래 segmentKanaRun 이 의미 단위로 재분할한다.
const KANA_RUN_RE = /[぀-ヿ]+/y

// 助詞(조사) — kuromoji 결과가 아직 없을 때(비동기 로딩 중) 쓰는 즉석 대체 규칙에서만 참조.
const JA_PARTICLES = new Set([
  'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'から', 'まで', 'より', 'へ', 'や',
  'ので', 'のに', 'けど', 'けれど', 'けれども', 'たら', 'なら', 'という', 'とか',
  'やら', 'なり', 'きり', 'だけ', 'ばかり', 'ほど', 'くらい', 'ぐらい', 'まま', 'つつ',
  'って', 'とも', 'こそ', 'すら', 'だに', 'ながら', 'し', 'ば', 'か', 'ね', 'よ', 'わ', 'さ', 'な',
])
const JA_AUX_FRAGMENTS = new Set([
  'ます', 'ました', 'ません', 'でした', 'たい', 'たかった', 'なかった', 'ない',
  'だった', 'だろう', 'でしょう', 'られる', 'れる', 'させる', 'せる', 'たり', 'だり',
])

const kanaSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('ja', { granularity: 'word' })
    : null

/**
 * kuromoji 결과(jaTokens)가 아직 도착하지 않은 짧은 순간에만 쓰는 즉석 대체 — 팝업이
 * 열리자마자 바로 상호작용 가능해야 하므로 Intl.Segmenter 기반 근사치로 우선 렌더링한다
 * (main/nlp/japanese.ts 의 kuromoji 결과가 도착하면 buildSelectionModel 재호출로 대체됨).
 */
function segmentKanaRunFallback(run: string): Atom[] {
  if (!kanaSegmenter) return [{ start: 0, end: run.length }]
  const atoms: Atom[] = []
  for (const { segment, index } of kanaSegmenter.segment(run)) {
    const start = index
    const end = index + segment.length
    const isFragment =
      !JA_PARTICLES.has(segment) && (segment.length === 1 || JA_AUX_FRAGMENTS.has(segment))
    const prev = atoms[atoms.length - 1]
    if (isFragment && prev) {
      prev.end = end
    } else {
      atoms.push({ start, end })
    }
  }
  return atoms
}

/**
 * 가나 한 덩어리(run, text 상 절대 오프셋 absoluteStart부터)를 kuromoji 토큰 경계로
 * 쪼갠다 — 조동사(助動詞, 예: た/ます/ない)로 시작하는 토큰만 앞 atom 에 이어붙여 동사
 * 어간+어미를 하나로 취급하고(예: "渡った"의 った), 그 외(助詞·명사·동사 등)는 토큰이
 * 시작할 때마다 새 atom 을 연다 — 조사는 자연히 항상 독립 atom 이 된다.
 */
function segmentKanaRunWithTokens(
  run: string,
  absoluteStart: number,
  tokenAt: (pos: number) => JaToken | undefined,
): Atom[] {
  const atoms: Atom[] = []
  let current: Atom | null = null
  for (let i = 0; i < run.length; i++) {
    const absPos = absoluteStart + i
    const token = tokenAt(absPos)
    const isTokenStart = !token || token.start === absPos
    if (isTokenStart) {
      const shouldMergeIntoPrev = !!current && token?.pos === '助動詞'
      if (!shouldMergeIntoPrev) current = null
    }
    if (current) {
      current.end = i + 1
    } else {
      current = { start: i, end: i + 1 }
      atoms.push(current)
    }
  }
  return atoms
}

/** text 상 절대 위치 → 그 위치를 포함하는 jaToken 조회 함수를 만든다(팝업 문맥은 짧아 선형 탐색으로 충분). */
function buildTokenLookup(jaTokens: JaToken[]): (pos: number) => JaToken | undefined {
  return (pos: number) => jaTokens.find((t) => pos >= t.start && pos < t.start + t.surface.length)
}

/**
 * zhWords(segmentChineseWords 결과, 이미 단어 경계가 확정됨)로부터 "이 위치에서 단어가
 * 시작하면 그 끝 오프셋"을 찾는 조회 함수를 만든다 — jaTokens 와 달리 병합 규칙이 필요
 * 없어 시작 위치만 알면 바로 atom 하나를 만들 수 있다.
 */
function buildZhWordLookup(zhWords: ZhWord[]): (pos: number) => number | undefined {
  const endByStart = new Map(zhWords.map((w) => [w.start, w.end]))
  return (pos: number) => endByStart.get(pos)
}

// 팝업 내 일본어 선택 단위 전략.
//  - 'wordMerge'(현재 기본): OCR 단어 클릭(main/nlp/japanese.ts segmentJapaneseWords)과
//    동일하게 mergeJaTokens(@shared/nlp/ja) 결과를 그대로 atom 으로 쓴다 — 한자+가나가
//    붙어 하나의 문절 단위로 선택된다. 병합 결과를 화면에서 바로 확인하기 위한 임시 기본값.
//  - 'charLevel': 원래 계획대로 한자는 한 글자씩 별도 atom 으로 유지하고, 가나 조각만
//    kuromoji 품사로 병합한다(아래 tokenizeAtoms 의 KANJI_CHAR_RE/segmentKanaRunWithTokens
//    분기, jaTokens 가 없을 때의 기존 폴백과 동일한 코드 경로). 나중에 되돌릴 때는 이 값만
//    바꾸면 된다.
const JA_ATOM_STRATEGY: 'wordMerge' | 'charLevel' = 'wordMerge'

// mergeJaTokens 가 만든 순수 기호·공백뿐인 토큰(문장부호 등)은 atom 으로 만들지 않는다 —
// tokenizeAtoms 의 기존 LATIN/KANA/KANJI 루프가 그런 문자를 건너뛰던 것과 동일한 기준.
const SELECTABLE_CONTENT_RE = /[A-Za-z0-9一-鿿㐀-䶿぀-ヿ]/

/** JA_ATOM_STRATEGY==='wordMerge' 일 때 — 병합된 토큰 하나를 atom 하나로 그대로 쓴다. */
function atomsFromMergedTokens(jaTokens: JaToken[]): Atom[] {
  const atoms: Atom[] = []
  for (const t of mergeJaTokens(jaTokens)) {
    if (!SELECTABLE_CONTENT_RE.test(t.surface)) continue
    atoms.push({ start: t.start, end: t.start + t.surface.length })
  }
  return atoms
}

function tokenizeAtoms(text: string, jaTokens?: JaToken[], zhWords?: ZhWord[]): Atom[] {
  if (jaTokens && jaTokens.length > 0 && JA_ATOM_STRATEGY === 'wordMerge') {
    return atomsFromMergedTokens(jaTokens)
  }
  const tokenAt = jaTokens ? buildTokenLookup(jaTokens) : null
  const zhWordEndAt = zhWords && zhWords.length > 0 ? buildZhWordLookup(zhWords) : null
  const atoms: Atom[] = []
  let i = 0
  while (i < text.length) {
    LATIN_ATOM_RE.lastIndex = i
    const latin = LATIN_ATOM_RE.exec(text)
    if (latin) {
      atoms.push({ start: i, end: i + latin[0].length })
      i += latin[0].length
      continue
    }
    // OCR 단어 클릭(main/nlp/chinese.ts segmentChineseWords)과 동일하게, 확정된 단어
    // 경계가 이 위치에서 시작하면 한자 하나가 아니라 단어 전체를 atom 하나로 쓴다.
    const zhWordEnd = zhWordEndAt?.(i)
    if (zhWordEnd !== undefined) {
      atoms.push({ start: i, end: zhWordEnd })
      i = zhWordEnd
      continue
    }
    KANA_RUN_RE.lastIndex = i
    const kana = KANA_RUN_RE.exec(text)
    if (kana) {
      const sub = tokenAt
        ? segmentKanaRunWithTokens(kana[0], i, tokenAt)
        : segmentKanaRunFallback(kana[0])
      for (const a of sub) atoms.push({ start: i + a.start, end: i + a.end })
      i += kana[0].length
      continue
    }
    if (KANJI_CHAR_RE.test(text[i]!)) {
      atoms.push({ start: i, end: i + 1 })
      i += 1
      continue
    }
    i += 1
  }
  return atoms
}

interface DisplayText {
  displayText: string
  selStart: number
  selEnd: number
  /** extracted.text 안에서 windowedText(=들여쓰기 전 displayText) 가 시작하는 오프셋 */
  windowStart: number
  /** indentParagraphs 가 삽입한 위치들(오름차순) — toWindowedOffset 에 그대로 전달 */
  insertions: number[]
}

/**
 * ExtractedSelection 으로부터 표시 문자열(displayText)과 그 안에서의 선택 오프셋만 계산한다.
 * language 와 무관 — 일본어 kuromoji 토큰(jaTokens)을 요청하려면 이 displayText 가 먼저
 * 필요해서(PopupScreen 이 비동기로 IPC 호출) buildSelectionModel 과 분리해 둔다.
 *
 * 이 함수가 만드는 windowedText/displayText 는 어디까지나 화면 표시용이다. LLM 에 넘길
 * 문맥 범위는 이걸 거치지 않고 extracted.text 원문 + settings.contextBytesBefore/After
 * 로 별도 계산한다(@main/question/llm/adapter.ts buildContextBlock) — windowStart/
 * insertions 는 화면에서 재지정한 선택 범위를 extracted.text 오프셋으로 되돌리기 위한
 * 것일 뿐, 그 자체가 LLM 문맥의 상한이 되지 않는다.
 */
export function buildDisplayText(extracted: ExtractedSelection): DisplayText {
  // 원문 전체(extracted.text) 중 선택 앞뒤 256바이트(+문장 경계 확장)만 "표시"에 쓴다.
  const range = computeContextRange(
    extracted.text,
    extracted.anchor.start,
    extracted.anchor.end,
    DISPLAY_CONTEXT_BYTES_BEFORE,
    DISPLAY_CONTEXT_BYTES_AFTER,
  )
  const windowedText = extracted.text.slice(range.extStart, range.extEnd)
  const windowedSelStart = extracted.anchor.start - range.extStart
  const windowedSelEnd = extracted.anchor.end - range.extStart
  const firstIsParagraphStart = range.extStart === 0 || extracted.text[range.extStart - 1] === '\n'
  const { text: displayText, selStart, selEnd, insertions } = indentParagraphs(
    windowedText,
    windowedSelStart,
    windowedSelEnd,
    firstIsParagraphStart,
  )
  return { displayText, selStart, selEnd, windowStart: range.extStart, insertions }
}

/**
 * ExtractedSelection 으로부터 표시 문자열·atom·초기 선택 범위를 계산한다. jaTokens 를 주면
 * 일본어 가나 조각을 kuromoji 품사 기반으로 병합하고(없으면 즉석 대체 규칙으로 근사),
 * zhWords 를 주면 중국어 한자를 segmentit 단어 경계 기준으로 묶는다(없으면 글자 단위).
 */
export function buildSelectionModel(
  extracted: ExtractedSelection,
  jaTokens?: JaToken[],
  zhWords?: ZhWord[],
): PopupSelectionModel {
  const { displayText, selStart, selEnd, windowStart, insertions } = buildDisplayText(extracted)
  const atoms = tokenizeAtoms(displayText, jaTokens, zhWords)

  // 선택 구간 [selStart, selEnd) 과 겹치는 atom 들을 초기 선택으로 잡는다.
  let initialFrom = atoms.findIndex((a) => a.end > selStart && a.start < selEnd)
  let initialTo = -1
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i]!.end > selStart && atoms[i]!.start < selEnd) initialTo = i
  }
  if (initialFrom < 0) {
    // 선택이 어떤 atom 과도 겹치지 않는 예외 상황 — 가장 가까운 atom 하나로 대체
    initialFrom = 0
    initialTo = atoms.length > 0 ? 0 : -1
  }
  return { displayText, atoms, initialFrom, initialTo, windowStart, insertions }
}

function splitWords(selectedText: string): Word[] {
  return selectedText
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((t) => ({ text: t }))
}

/**
 * displayText 의 [start, end) 구간(들여쓰기 포함 오프셋)을 최종 SelectionContext 로
 * 조립한다(메타는 base 유지). fullText/selStart/selEnd 는 표시용 트리밍·들여쓰기를
 * 되돌려 base.text(extracted.text 원문) 좌표로 넘긴다 — LLM 문맥은 이 원문 좌표를
 * 기준으로 settings.contextBytesBefore/After 만큼 별도로 잘라 쓴다(표시 범위와 무관).
 */
function contextFromRange(
  base: ExtractedSelection,
  displayText: string,
  windowStart: number,
  insertions: number[],
  start: number,
  end: number,
): SelectionContext {
  const selectedText = displayText.slice(start, end)
  return {
    selectedText,
    fullText: base.text,
    selStart: windowStart + toWindowedOffset(start, insertions),
    selEnd: windowStart + toWindowedOffset(end, insertions),
    words: splitWords(selectedText),
    language: base.language,
    source: base.source,
    extraction: base.extraction,
  }
}

/**
 * 현재 선택된 atom 범위 [from, to] 로부터 최종 SelectionContext 를 파생한다.
 * language/source/extraction 등 메타는 base(ExtractedSelection)를 유지하고,
 * selectedText/fullText/selStart/selEnd/words 만 계산한다.
 */
export function deriveContext(
  base: ExtractedSelection,
  model: PopupSelectionModel,
  from: number,
  to: number,
): SelectionContext {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const a = model.atoms[lo]
  const b = model.atoms[hi]
  // atom 이 하나도 없거나 범위가 유효하지 않으면(공백·기호만 넘어온 경우 등)
  // 초기 선택(anchor)으로 fallback한다 — anchor 는 이미 base.text(원문) 좌표이므로
  // display 매핑을 거치지 않고 그대로 쓴다.
  if (!a || !b) {
    const selectedText = base.text.slice(base.anchor.start, base.anchor.end)
    return {
      selectedText,
      fullText: base.text,
      selStart: base.anchor.start,
      selEnd: base.anchor.end,
      words: splitWords(selectedText),
      language: base.language,
      source: base.source,
      extraction: base.extraction,
    }
  }
  return contextFromRange(base, model.displayText, model.windowStart, model.insertions, a.start, b.end)
}
