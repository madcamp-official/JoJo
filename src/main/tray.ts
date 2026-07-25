import { Menu, Tray, app, nativeImage } from 'electron'
import { IPC } from '@shared/channels'
import { getSelectedWindowId, setSelectedWindowId } from './selection/capture'
import {
  createSettingsWindow,
  getMainWindow,
  hideSelectionOverlay,
  resolveIconPath,
  showWindowPicker,
} from './windows'

// 담당 A — 백그라운드 실행 + 트레이 아이콘 (PLAN.md §3)
// 창을 선택하면 메인 창은 숨고(windows.ts: SELECT_WINDOW 핸들러) 트레이 아이콘만 남는다.
// 트레이 메뉴는 선택 상태에 따라 달라진다:
//   - 선택된 창이 있을 때: 선택 해제 / 재선택 / 설정 / 종료
//   - 없을 때: 선택 / 설정 / 종료 ("선택 해제"는 뜻이 없고, "재선택"은 그냥 "선택")

let tray: Tray | null = null

function deselectWindow(): void {
  setSelectedWindowId(null)
  hideSelectionOverlay()
  const main = getMainWindow()
  main?.webContents.send(IPC.WINDOW_SELECTED, null)
  main?.show()
}

function openWindowPicker(): void {
  getMainWindow()?.show()
  showWindowPicker()
}

function buildTrayMenu(): Menu {
  const hasSelection = getSelectedWindowId() !== null

  return Menu.buildFromTemplate([
    ...(hasSelection
      ? [
          { label: '선택 해제', click: deselectWindow },
          { label: '재선택', click: openWindowPicker },
        ]
      : [{ label: '선택', click: openWindowPicker }]),
    { label: '설정', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ])
}

export function createTray(): Tray {
  if (tray) return tray

  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 32, height: 32 })
  tray = new Tray(icon)
  tray.setToolTip('Nuance')

  // setContextMenu 대신 클릭마다 직접 메뉴를 새로 만들어 띄운다 — 선택 상태에 따라
  // 항목이 달라져야 해서, 고정 메뉴 하나를 미리 등록해두는 방식은 쓸 수 없다.
  const showMenu = () => tray?.popUpContextMenu(buildTrayMenu())
  tray.on('click', showMenu)
  tray.on('right-click', showMenu)

  return tray
}
