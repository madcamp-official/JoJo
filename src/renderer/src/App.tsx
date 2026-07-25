import { useEffect, useState } from 'react'
import { MainScreen } from './screens/MainScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PopupScreen } from './screens/PopupScreen'
import { Overlay } from './screens/Overlay'
import { WindowPickerScreen } from './screens/WindowPickerScreen'

function getRoute(): string {
  return window.location.hash.replace(/^#\//, '') || 'main'
}

// 해시 라우팅 — 각 BrowserWindow 가 #/route 로 로드된다 (windows.ts).
// hashchange 를 구독해 같은 창 안에서의 라우팅(예: 메인 ↔ 설정)도 반영한다.
export function App() {
  const [route, setRoute] = useState(getRoute)

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
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
    case 'main':
    default:
      return <MainScreen />
  }
}
