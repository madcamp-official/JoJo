// 공동 소유 — 선택 근방 문맥 범위 계산 (PLAN.md §3 'AI 주변 범위(Byte)')
//
// 선택 영역을 기준으로 앞/뒤 각각 byteBudget 바이트만큼 문맥을 포함하되,
// 순수 바이트 경계에서 문장이 잘리지 않도록 가장 가까운 문장 경계까지 바깥으로
// 확장한다. LLM 프롬프트 구성과 설정 화면 미리보기가 동일 로직을 공유한다.

/** UTF-8 바이트 길이 (영어=1B/자, 한·중·일=3B/자 등) */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

// 문장 종결부호(라틴 + CJK)
const SENTENCE_ENDERS = /[.!?。！？…]/
// 종결부호 뒤에 붙어 문장에 포함되는 닫는 따옴표·괄호
const TRAILING = /["'”’」』）)\]]/

/** from 에서 뒤로(왼쪽) byteBudget 바이트만큼 이동한 문자 인덱스 (문자 경계 유지) */
function stepBack(text: string, from: number, byteBudget: number): number {
  let i = from
  let used = 0
  while (i > 0) {
    const b = byteLength(text[i - 1])
    if (used + b > byteBudget) break
    used += b
    i -= 1
  }
  return i
}

/** from 에서 앞으로(오른쪽) byteBudget 바이트만큼 이동한 문자 인덱스 */
function stepForward(text: string, from: number, byteBudget: number): number {
  let i = from
  let used = 0
  while (i < text.length) {
    const b = byteLength(text[i])
    if (used + b > byteBudget) break
    used += b
    i += 1
  }
  return i
}

/** p 를 포함하는 문장의 시작 인덱스 (직전 종결부호 다음, 선행 공백 스킵) */
function sentenceStart(text: string, p: number): number {
  let i = p
  while (i > 0 && !SENTENCE_ENDERS.test(text[i - 1])) i -= 1
  while (i < p && /\s/.test(text[i])) i += 1
  return i
}

/** p 를 포함하는 문장의 끝 인덱스 (다음 종결부호 + 뒤따르는 닫는 따옴표 포함) */
function sentenceEnd(text: string, p: number): number {
  let i = p
  while (i < text.length && !SENTENCE_ENDERS.test(text[i])) i += 1
  if (i < text.length) {
    i += 1 // 종결부호 포함
    while (i < text.length && TRAILING.test(text[i])) i += 1
  }
  return i
}

/** 문자 인덱스로 표현한 문맥 범위 경계 */
export interface ContextRange {
  extStart: number // 문장 경계까지 확장된 시작(가장 바깥)
  byteStart: number // 바이트 예산 경계 시작
  selStart: number
  selEnd: number
  byteEnd: number // 바이트 예산 경계 끝
  extEnd: number // 문장 경계까지 확장된 끝(가장 바깥)
}

/**
 * text 안에서 [selStart, selEnd) 선택을 기준으로 앞 byteBefore / 뒤 byteAfter 바이트
 * 문맥 + 문장 경계 확장까지의 범위를 계산한다(앞·뒤 예산 분리).
 */
export function computeContextRange(
  text: string,
  selStart: number,
  selEnd: number,
  byteBefore: number,
  byteAfter: number,
): ContextRange {
  const byteStart = stepBack(text, selStart, byteBefore)
  const byteEnd = stepForward(text, selEnd, byteAfter)
  return {
    extStart: sentenceStart(text, byteStart),
    byteStart,
    selStart,
    selEnd,
    byteEnd,
    extEnd: sentenceEnd(text, byteEnd),
  }
}

/** 선택 표현을 mark 로 감싼 최종 문맥 블록 문자열(LLM 전달용). */
export function buildContextText(
  text: string,
  selStart: number,
  selEnd: number,
  byteBefore: number,
  byteAfter: number,
  mark: (sel: string) => string,
): string {
  const r = computeContextRange(text, selStart, selEnd, byteBefore, byteAfter)
  return (
    text.slice(r.extStart, selStart) +
    mark(text.slice(selStart, selEnd)) +
    text.slice(selEnd, r.extEnd)
  )
}
