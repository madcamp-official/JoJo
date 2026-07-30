import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { MainScreen } from './screens/MainScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PopupScreen } from './screens/PopupScreen'
import { Overlay } from './screens/Overlay'
import { WindowPickerScreen } from './screens/WindowPickerScreen'
import { ViewerScreen } from './screens/ViewerScreen'
import { matchesAccelerator } from './shortcutMatch'

// 해시에 쿼리(예: '#/popup?demo=zh')가 붙어도 라우트 매칭은 '?' 앞부분만 본다.
function getRoute(): string {
  return window.location.hash.replace(/^#\//, '').split('?')[0] || 'main'
}

// 해시 라우팅 — 각 BrowserWindow 가 #/route 로 로드된다 (windows.ts).
// hashchange 를 구독해 같은 창 안에서의 라우팅(예: 메인 ↔ 설정 ↔ 피커)도 반영한다.
export function App() {
  const [route, setRoute] = useState(getRoute)
  const [selected, setSelected] = useState<CaptureSource | null>(null)

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // 메인 프로세스(트레이 등)가 화면 전환을 지시하면 해시를 바꿔 반영한다(navigate.ts 참고).
  useEffect(() => window.nuance.onNavigate((r) => (window.location.hash = `#/${r}`)), [])

  // 라우트가 실제로 바뀌어 화면이 리렌더된 뒤(main/picker/settings 만 대상 — 이 셋만
  // 창 하나를 재사용해 숨김↔전환 깜빡임 문제가 있다), 메인 프로세스에 "전환 완료"를
  // 알린다 — showMainWindowAtRoute 가 숨겨진 창을 이 신호를 받은 뒤에야 보여준다.
  useEffect(() => {
    if (route === 'main' || route === 'picker' || route === 'settings') {
      window.nuance.notifyNavigateReady(route)
    }
  }, [route])

  // 최상위에서 항상 구독 — MainScreen 이 마운트돼 있지 않을 때(피커 화면 등) 선택 이벤트를
  // 놓치지 않도록. 메인/피커/설정이 창 하나를 재사용하는 구조라 이 순서가 어긋날 수 있다.
  useEffect(() => window.nuance.onWindowSelected(setSelected), [])

  // "설정 화면 열기" 단축키(기본 Cmd/Ctrl+,, 2026-07-29부터 로컬 판정) — App 이 모든
  // BrowserWindow(메인/설정/피커/팝업/오버레이, 전부 이 컴포넌트를 최상위로 로드함)의
  // keydown 을 구독하므로 여기 한 곳에만 있으면 전체 창을 커버한다. 이 창이 실제로
  // OS 포커스를 갖고 있을 때만 keydown 이 여기 도달하므로("Nuance 자신의 창이
  // 포커싱돼 있을 때"), globalShortcut 처럼 다른 앱의 같은 키 입력을 가로챌 일이
  // 없다(shortcut.ts 상단 주석 참고 — Cmd+,는 VSCode 등도 흔히 쓰는 조합이라 전역
  // 후킹은 그 앱들의 단축키를 먹통으로 만드는 부작용이 있었음). 매 keydown 마다
  // 최신 설정을 조회해(state 캐싱 없음) 설정 화면에서 방금 바꾼 값도 바로 반영된다 —
  // 이 키 조합 자체가 극히 드물게만 눌리므로 IPC 왕복 비용은 무시할 수 있다.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      void window.nuance.getSettings().then((settings) => {
        if (matchesAccelerator(e, settings.settingsShortcut)) {
          e.preventDefault()
          void window.nuance.openSettingsWindow()
        }
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  switch (route) {
    case 'settings':
      return <SettingsScreen />
    case 'popup':
      return <PopupScreen />
    case 'overlay':
      return <Overlay />
    case 'picker':
      return <WindowPickerScreen />
    case 'viewer':
      return <ViewerScreen />
    case 'main':
    default:
      return <MainScreen selected={selected} />
  }
}
