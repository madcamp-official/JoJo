// 공동 소유 — 선택 근방 문맥 범위 계산 (PLAN.md §3 '문맥 범위(Byte)')
//
// 선택 영역을 기준으로 앞/뒤 각각 byteBudget 바이트만큼 문맥을 포함하되,
// 순수 바이트 경계에서 문장이 잘리지 않도록 가장 가까운 문장 경계까지 바깥으로
// 확장한다. LLM 프롬프트 구성과 설정 화면 미리보기가 동일 로직을 공유한다.
// 문장 경계 판단은 Mr./e.g./3.14 같은 약어·소수점의 '.'을 문장 끝과 혼동하지
// 않도록 isAbbreviationDot 으로 걸러낸다(라틴 문자권 한정, CJK 종결부호는 무관).

/** UTF-8 바이트 길이 (영어=1B/자, 한·중·일=3B/자 등) */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

// 문장 종결부호(라틴 + CJK)
const SENTENCE_ENDERS = /[.!?。！？…]/
// 종결부호 뒤에 붙어 문장에 포함되는 닫는 따옴표·괄호
const TRAILING = /["'”’」』）)\]]/

// 마침표로 끝나는 흔한 영어 약어 — 이 뒤의 '.'는 문장 끝으로 보지 않는다(대소문자 무시)
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs',
  'etc', 'al', 'approx', 'no', 'ca', 'dept', 'univ', 'assn',
  'corp', 'co', 'inc', 'ltd', 'ave', 'blvd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

/**
 * text[i] 의 '.'이 실제 문장 끝이 아니라 약어·이니셜·소수점·줄임표의 일부인지 판단.
 * CJK 종결부호(。！？…)는 대상이 아니므로 즉시 false — 라틴 문자권에만 적용된다.
 */
function isAbbreviationDot(text: string, i: number): boolean {
  if (text[i] !== '.') return false

  const prev = text[i - 1] ?? ''
  const next = text[i + 1] ?? ''

  if (/\d/.test(prev) && /\d/.test(next)) return true // 소수점: 3.14
  if (next === '.') return true // 줄임표(...) 진행 중 — 마지막 마침표만 후보로 본다

  let j = i
  while (j > 0 && /[A-Za-z]/.test(text[j - 1])) j -= 1
  const word = text.slice(j, i)
  if (!word) return false

  // 한 글자 토큰: 이니셜(J. K. Rowling)이나 점으로 이어지는 약어(e.g. / i.e. / a.m. / U.S.)의 조각
  if (word.length === 1) return true

  return ABBREVIATIONS.has(word.toLowerCase())
}

function isSentenceEnder(text: string, i: number): boolean {
  return SENTENCE_ENDERS.test(text[i]) && !isAbbreviationDot(text, i)
}

// 닫는 따옴표/괄호(TRAILING)까지 포함해 text 가 문장이 끝나는 지점에서 끝나는지 본다
// (예: 자막 큐 이어붙이기 — 자막 유틸이 여러 곳에서 재사용).
export function endsWithSentenceEnder(text: string): boolean {
  let i = text.length - 1
  while (i >= 0 && TRAILING.test(text[i])) i -= 1
  return i >= 0 && isSentenceEnder(text, i)
}

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
export function sentenceStart(text: string, p: number): number {
  let i = p
  while (i > 0 && !isSentenceEnder(text, i - 1)) i -= 1
  while (i < p && /\s/.test(text[i])) i += 1
  return i
}

/** p 를 포함하는 문장의 끝 인덱스 (다음 종결부호 + 뒤따르는 닫는 따옴표 포함) */
export function sentenceEnd(text: string, p: number): number {
  let i = p
  while (i < text.length && !isSentenceEnder(text, i)) i += 1
  if (i < text.length) {
    i += 1 // 종결부호 포함
    while (i < text.length && TRAILING.test(text[i])) i += 1
  }
  return i
}

/** 문자 인덱스로 표현한 문맥 범위 경계 */
export interface ContextRange {
  extStart: number // 경계까지 확장된 시작(가장 바깥)
  byteStart: number // 바이트 예산 경계 시작
  selStart: number
  selEnd: number
  byteEnd: number // 바이트 예산 경계 끝
  extEnd: number // 경계까지 확장된 끝(가장 바깥)
}

/**
 * text 안에서 [selStart, selEnd) 선택을 기준으로 앞 byteBefore / 뒤 byteAfter 바이트
 * 문맥 + 문장 경계 확장까지의 범위를 계산한다(앞·뒤 예산 분리). LLM 프롬프트 구성과
 * 설정 화면 미리보기가 사용(§'문맥 범위(Byte)').
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
