export type MainRoute = 'main' | 'picker' | 'settings' | 'manual'

// 메인/피커/설정 화면은 동시에 두 개 이상 보일 필요가 없어 창 하나를 재사용한다
// (windows.ts: setMainWindowRoute — 화면에 맞는 크기로 애니메이션 없이 즉시 전환 + 중앙 정렬).
// 해시를 바꿔 즉시 리렌더하고, 메인 프로세스에는 창 크기 조정만 요청한다.
export function goto(route: MainRoute): void {
  window.location.hash = `#/${route}`
  void window.nuance.setWindowRoute(route)
}

/** 뒤로가기/Esc 로 설정·사용 설명서 같은 보조 화면을 나갈 때 공통으로 쓴다(원래
 *  SettingsScreen.tsx 안에만 있던 것을 ManualScreen.tsx 도 똑같이 필요해져 여기로 옮김,
 *  2026-07-31) — 이미 선택된 창이 있으면(백그라운드 실행 중 이 화면만 열어본 상황) 메인
 *  화면(창 선택 안내)으로 돌아갈 필요가 없다. 그 화면은 "아직 아무 창도 선택 안 한" 초기
 *  상태를 위한 것이라, 이미 선택돼 있는데 거기로 갔다가 다시 트레이로 숨겨야 하는 건
 *  불필요한 경유다 — window.close() 로 창을 바로 닫는다(메인 창은 windows.ts:
 *  createMainWindow 의 close 핸들러가 실제 종료가 아니면 항상 hide 로 가로채므로, 안전하게
 *  "트레이로 숨기기"와 동일하게 동작한다). 선택된 창이 없으면 기존처럼 메인 화면으로. */
export function exitToMainOrClose(hasSelection: boolean): void {
  if (hasSelection) window.close()
  else goto('main')
}
