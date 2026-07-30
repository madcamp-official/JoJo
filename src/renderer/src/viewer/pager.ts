// 뷰어 3종(pdf/epub/txt)이 공유하는 "페이지 넘기기" 계약.
//
// 포맷마다 페이지를 만드는 방법이 완전히 다르다 — PDF 는 pdf.js 가 그린 페이지 요소를
// 하나씩 보여주고, epub 은 epubjs 자체 페이지네이션(iframe 안)을 쓰고, txt 는 CSS 다단
// (column)으로 화면 폭만큼 잘라 가로로 넘긴다. 그래서 "어떻게 넘기는지"는 각 뷰가 알고,
// ViewerScreen 은 이 핸들을 통해 넘기라고 시키기만 한다(화살표 버튼·좌우 방향키 공용).

export interface PagerHandle {
  next(): void
  prev(): void
}

/** 화살표 버튼 활성/비활성과 "3 / 284" 표시에 쓰는 현재 상태. */
export interface PageState {
  /** 1-based 현재 페이지. 아직 모르면 0. */
  current: number
  /** 전체 페이지 수. 아직 모르면 0(=표시 안 함). */
  total: number
  canPrev: boolean
  canNext: boolean
}

export const EMPTY_PAGE_STATE: PageState = { current: 0, total: 0, canPrev: false, canNext: false }

export type ViewerMode = 'scroll' | 'page'

/**
 * 페이지 넘김 효과 — 포맷별 렌더러를 건드리지 않고 본문 전체에 애니메이션을 건다.
 *
 * CSS 클래스가 아니라 **Web Animations API 로 매번 새 애니메이션을 만든다**. CSS 로
 * 하면 같은 방향으로 연속해 넘길 때 재생이 안 되는 문제를 피할 수 없었다 — 클래스
 * 이름만 바꿔서는 브라우저가 재시작을 안 하고(계산된 animation 속성이 같다), 그렇다고
 * getAnimations() 로 되감으면 **이미 끝난 애니메이션은 목록에 없어서** 잡히지 않는다.
 * 그래서 "방향을 바꿀 때만 한 번 재생되고 같은 방향 반복은 무시"되는 증상이 났다
 * (2026-07-31 사용자 제보). element.animate() 는 호출할 때마다 새 인스턴스라 그런 함정이
 * 없다.
 */
export type PageTransition = 'none' | 'slide'

/** 넘김 방향에 맞는 키프레임(없음이면 null). */
export function pageTurnKeyframes(t: PageTransition, dir: 'next' | 'prev'): Keyframe[] | null {
  if (t !== 'slide') return null
  const from = dir === 'next' ? 72 : -72
  return [
    { transform: `translateX(${from}px)`, opacity: 0.25 },
    { transform: 'translateX(0)', opacity: 1 },
  ]
}

export const PAGE_TURN_TIMING: KeyframeAnimationOptions = {
  // 420ms 는 "넘어갔다"는 느낌이 오기 전에 끝나버렸다(사용자 요청으로 추가 완화).
  duration: 700,
  easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
}
