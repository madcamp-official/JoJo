import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PageState } from './pager'

// 페이지 모드에서 본문 좌우에 떠 있는 원형 화살표 — 원 안에 뾰족한 꺾쇠(chevron)가 들어간
// 형태(사용자 지정 디자인). 본문 위에 겹쳐 뜨지만 넘길 수 없는 방향은 숨겨서, 첫/마지막
// 페이지에서 눌러도 아무 일 없는 버튼이 남아있지 않게 한다.
export function PageNav({
  state,
  onPrev,
  onNext,
}: {
  state: PageState
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <>
      {state.canPrev && (
        <button className="page-nav prev" title="이전 페이지 (←)" onClick={onPrev}>
          <ChevronLeft size={26} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {state.canNext && (
        <button className="page-nav next" title="다음 페이지 (→)" onClick={onNext}>
          <ChevronRight size={26} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {state.total > 0 && (
        <div className="page-indicator">
          {state.current} / {state.total}
        </div>
      )}
    </>
  )
}
