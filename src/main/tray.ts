import { Menu, Tray, app, nativeImage } from 'electron'
import { IPC } from '@shared/channels'
import { getSelectedWindowId, setSelectedWindowId, setSelectedWindowName } from './selection/capture'
import { invalidateExtractionCache } from './selection/extractionCache'
import { clearRegion } from './selection/regionSelection'
import { currentMode, requestManualRegionSelection } from './selection/shortcut'
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
//   - 선택된 창이 있을 때: 창 선택 전환 / 창 선택 해제 / (선택 모드면) 영역 수동 선택 / 설정 / 종료
//   - 없을 때: 창 선택 / 설정 / 종료 ("창 선택 해제"는 뜻이 없고, "창 선택 전환"은 그냥 "창 선택")
// "영역 수동 선택"(선택 모드에서만 노출)은 자동 탐지 설정(autoDetectRegion)이 켜져 있어도
// 그 결과가 마음에 안 들 때 강제로 드래그 선택으로 덮어쓰는 용도 — shortcut.ts:
// requestManualRegionSelection. 리사이즈로 인한 영역 재선택은 별도 메뉴 없이 자동으로
// 처리된다(shortcut.ts: onWindowResized).

let tray: Tray | null = null

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
  // 자동 탐지 결과가 마음에 안 들 때 강제로 드래그 선택으로 전환하는 버튼(사용자 요청,
  // 2026-07-29) — 선택 모드가 아닐 때는 뜻이 없어(영역 자체가 아직 안 쓰임) 그때만 보여준다.
  const inSelectMode = currentMode() === 'select'

  return Menu.buildFromTemplate([
    ...(hasSelection
      ? [
          { label: '창 선택 전환', click: openWindowPicker },
          { label: '창 선택 해제', click: deselectWindow },
        ]
      : [{ label: '창 선택', click: openWindowPicker }]),
    ...(inSelectMode
      ? [{ label: '영역 수동 선택', click: requestManualRegionSelection }]
      : []),
    { label: '설정', click: openSettingsWindow },
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
