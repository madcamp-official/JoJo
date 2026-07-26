import type { ExtractedSelection, SelectionContext, Word } from '@shared/types'
import { computeContextRange } from '@shared/context'

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
}

// 팝업 원문 문맥 표시 범위 — 선택 앞뒤 각 512 바이트.
// 순수 바이트 경계에서 문장이 잘리면 가장 가까운 문장 경계까지 더 넣어서 보여주고,
// 원문이 그만큼 없으면(문서 시작/끝 근처) 있는 만큼만 보여준다 — @shared/context 공유 로직.
const DISPLAY_CONTEXT_BYTES_BEFORE = 512
const DISPLAY_CONTEXT_BYTES_AFTER = 512

// 문단(줄바꿈) 시작에 넣는 들여쓰기 — 설정 화면 미리보기(SettingsScreen.tsx PREVIEW_TEXT)와
// 동일한 1칸 공백 관례를 그대로 따른다. 원문에 이미 들여쓰기(공백/탭)가 있으면 건드리지 않고,
// 없을 때만 넣어서 "있으면 그대로, 없으면 있는 것처럼 보이게" 만든다.
const PARAGRAPH_INDENT = ' '

/**
 * displayText 의 각 문단 시작에 들여쓰기를 넣고, selStart/selEnd 를 삽입된 만큼 보정해
 * 반환한다. 창은 문장 경계로만 확장되므로(computeContextRange) 첫 줄이 항상 문단 시작인
 * 건 아니다 — 문단 중간에서 창이 시작하면 그 첫 줄은 이어지는 텍스트일 뿐이므로
 * firstIsParagraphStart 가 false 일 때만 첫 줄 들여쓰기를 건너뛴다.
 */
function indentParagraphs(
  text: string,
  selStart: number,
  selEnd: number,
  firstIsParagraphStart: boolean,
): { text: string; selStart: number; selEnd: number } {
  const paragraphs = text.split('\n')
  let newSelStart = selStart
  let newSelEnd = selEnd
  let offset = 0
  const out = paragraphs.map((p, i) => {
    const paraStart = offset
    offset += p.length + 1 // +1 = 소비되는 '\n'
    if (i === 0 && !firstIsParagraphStart) return p
    if (/^[ \t]/.test(p)) return p
    if (paraStart <= selStart) newSelStart += PARAGRAPH_INDENT.length
    if (paraStart <= selEnd) newSelEnd += PARAGRAPH_INDENT.length
    return PARAGRAPH_INDENT + p
  })
  return { text: out.join('\n'), selStart: newSelStart, selEnd: newSelEnd }
}

// 영어 atom: 알파벳/숫자 연속(내부 아포스트로피 허용). 하이픈은 경계로 취급 →
// "well-to-do" 는 well / to / do 세 atom, "left-hand" 는 left / hand 두 atom 이 된다.
const WORD_ATOM_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g

function tokenizeAtoms(text: string): Atom[] {
  const atoms: Atom[] = []
  let m: RegExpExecArray | null
  WORD_ATOM_RE.lastIndex = 0
  while ((m = WORD_ATOM_RE.exec(text))) {
    atoms.push({ start: m.index, end: m.index + m[0].length })
  }
  return atoms
}

/** ExtractedSelection 으로부터 표시 문자열·atom·초기 선택 범위를 계산한다. */
export function buildSelectionModel(extracted: ExtractedSelection): PopupSelectionModel {
  // 원문 전체(extracted.text) 중 선택 앞뒤 512바이트(+문장 경계 확장)만 잘라서 보여준다.
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
  const { text: displayText, selStart, selEnd } = indentParagraphs(
    windowedText,
    windowedSelStart,
    windowedSelEnd,
    firstIsParagraphStart,
  )
  const atoms = tokenizeAtoms(displayText)

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
  return { displayText, atoms, initialFrom, initialTo }
}

function splitWords(selectedText: string): Word[] {
  return selectedText
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((t) => ({ text: t }))
}

/** displayText 의 [start, end) 구간을 최종 SelectionContext 로 조립한다(메타는 base 유지). */
function contextFromRange(
  base: ExtractedSelection,
  displayText: string,
  start: number,
  end: number,
): SelectionContext {
  const selectedText = displayText.slice(start, end)
  return {
    selectedText,
    precedingText: displayText.slice(0, start),
    followingText: displayText.slice(end),
    words: splitWords(selectedText),
    language: base.language,
    source: base.source,
    extraction: base.extraction,
  }
}

/**
 * 현재 선택된 atom 범위 [from, to] 로부터 최종 SelectionContext 를 파생한다.
 * language/source/extraction 등 메타는 base(ExtractedSelection)를 유지하고,
 * selectedText/precedingText/followingText/words 만 계산한다.
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
  // 초기 선택(anchor)으로 fallback 한다.
  if (!a || !b) return contextFromRange(base, model.displayText, base.anchor.start, base.anchor.end)
  return contextFromRange(base, model.displayText, a.start, b.end)
}
