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

/** 페이지 넘김 효과 — 포맷별 렌더러를 건드리지 않고 본문 전체에 CSS 애니메이션으로 준다. */
export type PageTransition = 'none' | 'slide' | 'flip'

export const PAGE_TRANSITIONS: { value: PageTransition; label: string }[] = [
  { value: 'none', label: '효과 없음' },
  { value: 'slide', label: '슬라이딩' },
  { value: 'flip', label: '페이지 넘김' },
]
