import { MainScreen } from './screens/MainScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PopupScreen } from './screens/PopupScreen'
import { Overlay } from './screens/Overlay'
import { WindowPickerScreen } from './screens/WindowPickerScreen'

// 해시 라우팅 — 각 BrowserWindow 가 #/route 로 로드된다 (windows.ts).
export function App() {
  const route = window.location.hash.replace(/^#\//, '') || 'main'
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
