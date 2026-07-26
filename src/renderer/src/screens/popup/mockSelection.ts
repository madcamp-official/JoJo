import type { ExtractedSelection } from '@shared/types'

// ============================================================================
// 담당 B — 팝업 개발용 목업 (호빗 첫 페이지, "well-to-do" 클릭 상황)
//
// ⚠️ 임시 fixture. 담당 A 의 선택 파이프라인이 실제 ExtractedSelection 을 만들어
//    createPopupWindow(ctx) 로 넘기면 이 목업은 자연스럽게 대체된다.
//    (팝업 렌더러는 실제 ctx 가 없을 때만 이 목업으로 fallback 한다.)
//
// text 는 원문 전체를 그대로 담는다 — 표시 범위(선택 앞뒤 1024바이트 + 문장 경계
// 확장)는 팝업이 buildSelectionModel(@renderer/screens/popup/selection.ts)에서
// 잘라내므로, 여기서는 A 의 실제 추출 결과처럼 트리밍 없이 넘기기만 하면 된다.
// ============================================================================

/** 호빗 첫 페이지 원문 (담당 A 가 PDF 에서 추출했다고 가정한 전체 텍스트) */
export const HOBBIT_TEXT = [
  'In a hole in the ground there lived a hobbit. Not a nasty, dirty, wet hole, filled with the ends of worms and an oozy smell, nor yet a dry, bare, sandy hole with nothing in it to sit down on or to eat: it was a hobbit-hole, and that means comfort.',
  'It had a perfectly round door like a porthole, painted green, with a shiny yellow brass knob in the exact middle. The door opened on to a tube-shaped hall like a tunnel: a very comfortable tunnel without smoke, with panelled walls, and floors tiled and carpeted, provided with polished chairs, and lots and lots of pegs for hats and coats—the hobbit was fond of visitors. The tunnel wound on and on, going fairly but not quite straight into the side of the hill—The Hill, as all the people for many miles round called it—and many little round doors opened out of it, first on one side and then on another. No going upstairs for the hobbit: bedrooms, bathrooms, cellars, pantries (lots of these), wardrobes (he had whole rooms devoted to clothes), kitchens, dining-rooms, all were on the same floor, and indeed on the same passage. The best rooms were all on the left-hand side (going in), for these were the only ones to have windows, deep-set round windows looking over his garden, and meadows beyond, sloping down to the river.',
  'This hobbit was a very well-to-do hobbit, and his name was Baggins. The Bagginses had lived in the neighbourhood of The Hill for time out of mind, and people considered them very respectable, not only because most of them were rich, but also because they never had any adventures or did anything unexpected: you could tell what a Baggins would say on any question without the bother of asking him. This is a story of how a Baggins had an adventure, and found himself doing and saying things altogether unexpected. He may have lost the neighbours’ respect, but he gained—well, you will see whether he gained anything in the end.',
].join('\n')

/** 사용자가 클릭한 표현(하이픈으로 묶인 하나의 표현) */
export const HOBBIT_TARGET = 'well-to-do'

/**
 * 전체 원문에서 target 을 찾아 anchor(초기 선택)로 표시한 ExtractedSelection 을
 * 조립한다(A가 넘길 형태 — 트리밍 없이 원문 그대로).
 */
export function buildExtractedSelection(full: string, target: string): ExtractedSelection {
  const targetPos = full.indexOf(target)
  if (targetPos < 0) throw new Error(`target(${target}) 를 원문에서 찾지 못했습니다.`)

  return {
    text: full,
    anchor: { start: targetPos, end: targetPos + target.length },
    words: full
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
