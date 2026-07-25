import type { SelectionContext, Word } from '@shared/types'

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

/** ctx 로부터 표시 문자열·atom·초기 선택 범위를 계산한다. */
export function buildSelectionModel(ctx: SelectionContext): PopupSelectionModel {
  const displayText = ctx.precedingText + ctx.selectedText + ctx.followingText
  const selStart = ctx.precedingText.length
  const selEnd = selStart + ctx.selectedText.length
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

/**
 * 현재 선택된 atom 범위 [from, to] 로부터 새 SelectionContext 를 파생한다.
 * language/source/extraction 등 메타는 원본 ctx 를 유지하고,
 * selectedText/precedingText/followingText/words 만 재계산한다.
 */
export function deriveContext(
  base: SelectionContext,
  model: PopupSelectionModel,
  from: number,
  to: number,
): SelectionContext {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const a = model.atoms[lo]!
  const b = model.atoms[hi]!
  const selectedText = model.displayText.slice(a.start, b.end)
  return {
    ...base,
    selectedText,
    precedingText: model.displayText.slice(0, a.start),
    followingText: model.displayText.slice(b.end),
    words: splitWords(selectedText),
  }
}
