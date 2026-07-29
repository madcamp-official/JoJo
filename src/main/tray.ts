import { Menu, Tray, app, nativeImage } from 'electron'
import { IPC } from '@shared/channels'
import { getSelectedWindowId, setSelectedWindowId, setSelectedWindowName } from './selection/capture'
import { invalidateExtractionCache } from './selection/extractionCache'
import { clearRegion } from './selection/regionSelection'
import {
  getMainWindow,
  hideSelectionOverlay,
  navigateMainWindow,
  openSettingsWindow,
  resolveIconPath,
} from './windows'

// 담당 A — 백그라운드 실행 + 트레이 아이콘 (PLAN.md §3)
// 창을 선택하면 메인 창은 숨고(windows.ts: SELECT_WINDOW 핸들러) 트레이 아이콘만 남는다.
// 트레이 메뉴는 선택 상태에 따라 달라진다:
//   - 선택된 창이 있을 때: 창 선택 전환 / 창 선택 해제 / 설정 / 종료
//   - 없을 때: 창 선택 / 설정 / 종료 ("창 선택 해제"는 뜻이 없고, "창 선택 전환"은 그냥 "창 선택")
// (OCR 영역 재선택은 별도 메뉴 없음 — 창 리사이즈를 감지하면 자동으로 다시 드래그를
// 요청한다. shortcut.ts: onWindowResized)

let tray: Tray | null = null

// 트레이 메뉴(창 선택/설정/종료)가 지금 열려 있는지 — "설정 화면 열기" 전역 단축키를
// (1) Nuance 자신의 창이 포커싱돼 있을 때, (2) 이 트레이 메뉴가 떠 있을 때, (3) 선택된
// 대상 창이 포커싱돼 있을 때로만 한정하는 데 씀(shortcut.ts: isSettingsShortcutAllowed).
// 트레이 메뉴는 BrowserWindow 가 아니라 네이티브 팝업이라 mainWindow.isFocused() 로는
// 감지가 안 돼 따로 추적해야 한다.
let trayMenuOpen = false

export function isTrayMenuOpen(): boolean {
  return trayMenuOpen
}

function deselectWindow(): void {
  setSelectedWindowId(null)
  setSelectedWindowName(null)
  invalidateExtractionCache()
  clearRegion()
  hideSelectionOverlay()
  const main = getMainWindow()
  main?.webContents.send(IPC.WINDOW_SELECTED, null)
  main?.show()
  navigateMainWindow('main')
}

function openWindowPicker(): void {
  getMainWindow()?.show()
  navigateMainWindow('picker')
}

function buildTrayMenu(): Menu {
  const hasSelection = getSelectedWindowId() !== null

  const menu = Menu.buildFromTemplate([
    ...(hasSelection
      ? [
          { label: '창 선택 전환', click: openWindowPicker },
          { label: '창 선택 해제', click: deselectWindow },
        ]
      : [{ label: '창 선택', click: openWindowPicker }]),
    { label: '설정', click: openSettingsWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ])
  // Menu 인스턴스 자체가 내는 이벤트(팝업 전용 — 트레이 클릭 메뉴는 Tray 의 'click'과
  // 무관하게 이 메뉴가 실제로 화면에 떠 있는 동안만 true 여야 한다).
  menu.on('menu-will-close', () => {
    trayMenuOpen = false
  })
  return menu
}

export function createTray(): Tray {
  if (tray) return tray

  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 32, height: 32 })
  tray = new Tray(icon)
  tray.setToolTip('Nuance')

  // setContextMenu 대신 클릭마다 직접 메뉴를 새로 만들어 띄운다 — 선택 상태에 따라
  // 항목이 달라져야 해서, 고정 메뉴 하나를 미리 등록해두는 방식은 쓸 수 없다.
  const showMenu = () => {
    trayMenuOpen = true
    tray?.popUpContextMenu(buildTrayMenu())
  }
  tray.on('click', showMenu)
  tray.on('right-click', showMenu)

  return tray
}
