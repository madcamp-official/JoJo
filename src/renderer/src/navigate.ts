export type MainRoute = 'main' | 'picker' | 'settings'

// 메인/피커/설정 화면은 동시에 두 개 이상 보일 필요가 없어 창 하나를 재사용한다
// (windows.ts: setMainWindowRoute — 화면에 맞는 크기로 애니메이션 없이 즉시 전환 + 중앙 정렬).
// 해시를 바꿔 즉시 리렌더하고, 메인 프로세스에는 창 크기 조정만 요청한다.
export function goto(route: MainRoute): void {
  window.location.hash = `#/${route}`
  void window.nuance.setWindowRoute(route)
}
