// 메인 화면 (PLAN.md §3 화면 구성) — 중앙 [창 선택] + 우상단 설정 아이콘.
// TODO(공동/B): 창 선택 목록(desktopCapturer) 연동, 설정 화면 이동.
export function MainScreen() {
  return (
    <div className="screen main-screen">
      <button className="icon-btn settings" title="설정">⚙️</button>
      <div className="center">
        <button className="primary">🗔 창 선택</button>
        <p className="hint">사용할 창을 선택하세요.</p>
      </div>
    </div>
  )
}
