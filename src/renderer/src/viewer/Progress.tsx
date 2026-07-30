import type { PageState } from './pager'

// 화면 아래 진도 표시 — **페이지 모드 전용**이다. 스크롤로 읽을 때는 스크롤바가 이미
// 위치를 알려줘서 이 바가 겹쳐 보인다(2026-07-31 사용자 요청으로 제외).
export function Progress({ pageState }: { pageState: PageState }) {
  if (pageState.total <= 0) return null
  const percent = (pageState.current / pageState.total) * 100

  return (
    <div className="viewer-progress">
      <div className="viewer-progress-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="viewer-progress-text">
        {pageState.current} / {pageState.total}
      </span>
    </div>
  )
}
