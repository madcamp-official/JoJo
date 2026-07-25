import type { ExtractedSelection } from '@shared/types'

// ============================================================================
// 담당 B — 팝업 개발용 목업 (호빗 첫 페이지, "well-to-do" 클릭 상황)
//
// ⚠️ 임시 fixture. 담당 A 의 선택 파이프라인이 실제 ExtractedSelection 을 만들어
//    createPopupWindow(ctx) 로 넘기면 이 목업은 자연스럽게 대체된다.
//    (팝업 렌더러는 실제 ctx 가 없을 때만 이 목업으로 fallback 한다.)
//
// 문맥 범위는 "선택 문장 앞뒤 N개 문장"으로 잡아 문장 중간에서 잘리지 않게 한다.
// 범위를 넓히거나 좁히려면 아래 두 상수만 바꾸면 된다.
// ============================================================================

/** 선택 문장 기준 앞으로 포함할 문장 수 */
export const CONTEXT_SENTENCES_BEFORE = 1
/** 선택 문장 기준 뒤로 포함할 문장 수 */
export const CONTEXT_SENTENCES_AFTER = 1

/** 호빗 첫 페이지 원문 (담당 A 가 PDF 에서 추출했다고 가정한 전체 텍스트) */
export const HOBBIT_TEXT = [
  'In a hole in the ground there lived a hobbit. Not a nasty, dirty, wet hole, filled with the ends of worms and an oozy smell, nor yet a dry, bare, sandy hole with nothing in it to sit down on or to eat: it was a hobbit-hole, and that means comfort.',
  'It had a perfectly round door like a porthole, painted green, with a shiny yellow brass knob in the exact middle. The door opened on to a tube-shaped hall like a tunnel: a very comfortable tunnel without smoke, with panelled walls, and floors tiled and carpeted, provided with polished chairs, and lots and lots of pegs for hats and coats—the hobbit was fond of visitors. The tunnel wound on and on, going fairly but not quite straight into the side of the hill—The Hill, as all the people for many miles round called it—and many little round doors opened out of it, first on one side and then on another. No going upstairs for the hobbit: bedrooms, bathrooms, cellars, pantries (lots of these), wardrobes (he had whole rooms devoted to clothes), kitchens, dining-rooms, all were on the same floor, and indeed on the same passage. The best rooms were all on the left-hand side (going in), for these were the only ones to have windows, deep-set round windows looking over his garden, and meadows beyond, sloping down to the river.',
  'This hobbit was a very well-to-do hobbit, and his name was Baggins. The Bagginses had lived in the neighbourhood of The Hill for time out of mind, and people considered them very respectable, not only because most of them were rich, but also because they never had any adventures or did anything unexpected: you could tell what a Baggins would say on any question without the bother of asking him. This is a story of how a Baggins had an adventure, and found himself doing and saying things altogether unexpected. He may have lost the neighbours’ respect, but he gained—well, you will see whether he gained anything in the end.',
].join('\n')

/** 사용자가 클릭한 표현(하이픈으로 묶인 하나의 표현) */
export const HOBBIT_TARGET = 'well-to-do'

interface SentenceSpan {
  start: number
  end: number
}

// 문장 경계 휴리스틱: `.!?` 뒤에 공백/끝이 오면 문장 종료로 본다.
// (약어·소수점 등 예외는 이 목업 텍스트에선 발생하지 않는다. 실제 추출 텍스트엔
//  더 정교한 분할이 필요할 수 있으나, 그건 담당 A 의 추출 단계에서 다뤄진다.)
function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  const re = /[.!?]+(?=\s|$)/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length
    spans.push({ start, end })
    let s = end
    while (s < text.length && /\s/.test(text[s]!)) s++
    start = s
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 전체 원문에서 target 을 찾아, 그 문장 앞뒤로 N개 문장을 포함한 문맥 창을 만들어
 * ExtractedSelection 으로 조립한다(A가 넘길 형태). 문장 경계로 자르므로 문맥이 중간에서
 * 끊기지 않고, target 위치는 anchor(초기 선택)로 표시한다.
 */
export function buildExtractedSelection(
  full: string,
  target: string,
  before = CONTEXT_SENTENCES_BEFORE,
  after = CONTEXT_SENTENCES_AFTER,
): ExtractedSelection {
  const targetPos = full.indexOf(target)
  if (targetPos < 0) throw new Error(`target(${target}) 를 원문에서 찾지 못했습니다.`)

  const spans = sentenceSpans(full)
  const hostIdx = spans.findIndex((sp) => targetPos >= sp.start && targetPos < sp.end)
  const from = Math.max(0, hostIdx - before)
  const to = Math.min(spans.length - 1, hostIdx + after)

  const windowText = collapseWhitespace(full.slice(spans[from]!.start, spans[to]!.end))
  const selStart = windowText.indexOf(target)

  return {
    text: windowText,
    anchor: { start: selStart, end: selStart + target.length },
    words: windowText
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => ({ text: t })),
    language: 'en',
    source: { kind: 'pdf', appName: 'Hobbit.pdf' },
    extraction: 'direct',
  }
}

/** 팝업이 실제 ctx 없이 열렸을 때 쓰는 기본 목업 추출 결과 */
export function mockHobbitExtraction(): ExtractedSelection {
  return buildExtractedSelection(HOBBIT_TEXT, HOBBIT_TARGET)
}
