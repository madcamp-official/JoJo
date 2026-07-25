import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { MainScreen } from './screens/MainScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PopupScreen } from './screens/PopupScreen'
import { Overlay } from './screens/Overlay'
import { WindowPickerScreen } from './screens/WindowPickerScreen'

function getRoute(): string {
  return window.location.hash.replace(/^#\//, '') || 'main'
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

  // 최상위에서 항상 구독 — MainScreen 이 마운트돼 있지 않을 때(피커 화면 등) 선택 이벤트를
  // 놓치지 않도록. 메인/피커/설정이 창 하나를 재사용하는 구조라 이 순서가 어긋날 수 있다.
  useEffect(() => window.nuance.onWindowSelected(setSelected), [])

  switch (route) {
    case 'settings':
      return <SettingsScreen />
    case 'popup':
      return <PopupScreen />
    case 'overlay':
      return <Overlay />
    case 'picker':
      return <WindowPickerScreen />
    case 'main':
    default:
      return <MainScreen selected={selected} />
  }
}
