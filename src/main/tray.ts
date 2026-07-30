import { Menu, Tray, app, nativeImage } from 'electron'
import { IPC } from '@shared/channels'
import { getSelectedWindowId, setSelectedWindowId, setSelectedWindowName } from './selection/capture'
import { clearExtractionHistory, invalidateExtractionCache } from './selection/extractionCache'
import { clearRegion } from './selection/regionSelection'
import { getSettings } from './settingsStore'
import {
  currentMode,
  registerNamedShortcut,
  requestForceOcr,
  requestManualRegionSelection,
  toggleMode,
} from './selection/shortcut'
import { isSubtitleModeActive } from './selection/subtitleSource'
import { isWebModeActive } from './selection/webSource'
import {
  getMainWindow,
  hideSelectionOverlay,
  navigateMainWindow,
  onTargetWindowGone,
  openSettingsWindow,
  resolveIconPath,
  resolveMacTrayIconPath,
} from './windows'

// 담당 A — 백그라운드 실행 + 트레이 아이콘 (PLAN.md §4)
// 창을 선택하면 메인 창은 숨고(windows.ts: SELECT_WINDOW 핸들러) 트레이 아이콘만 남는다.
// 트레이 메뉴는 선택 상태에 따라 달라진다:
//   - 선택된 창이 있을 때: 모드 전환 / 창 선택 전환 / 창 선택 해제 / (선택 모드면) 영역 수동 선택 / 설정 / 종료
//     (2026-07-29 재수정 — 이 순서로 확정, 단축키는 전환=Opt+1/해제=Opt+2, "현재 모드" 표시는 라벨에서 제거)
//   - 없을 때: 창 선택 / 설정 / 종료 ("창 선택 해제"는 뜻이 없고, "창 선택 전환"은 그냥 "창 선택")
// "영역 수동 선택"(선택 모드에서만 노출)은 자동 탐지 설정(autoDetectRegion)이 켜져 있어도
// 그 결과가 마음에 안 들 때 강제로 드래그 선택으로 덮어쓰는 용도 — shortcut.ts:
// requestManualRegionSelection. 리사이즈로 인한 영역 재선택은 별도 메뉴 없이 자동으로
// 처리된다(shortcut.ts: onWindowResized).
// "OCR로 전환"(자막/웹 direct 추출 중일 때만 노출, 2026-07-30 사용자 요청)은 자동판정
// 결과가 마음에 안 들 때 강제로 OCR로 덮어쓰는 용도 — shortcut.ts: requestForceOcr.
// 같은 페이지에서만 유지되고 다른 페이지로 이동하거나 선택 모드를 나갔다 다시 들어가면
// 자동판정으로 되돌아간다.

let tray: Tray | null = null

export function deselectWindow(): void {
  setSelectedWindowId(null)
  setSelectedWindowName(null)
  invalidateExtractionCache()
  clearExtractionHistory() // 선택 해제도 "전환"과 동일하게 직전 회차 문맥을 비운다
  clearRegion()
  hideSelectionOverlay()
  const main = getMainWindow()
  main?.webContents.send(IPC.WINDOW_SELECTED, null)
  main?.show()
  navigateMainWindow('main')
}

export function openWindowPicker(): void {
  getMainWindow()?.show()
  navigateMainWindow('picker')
}

// 단축키가 해제(빈 문자열)돼 있으면 Electron MenuItem 에 accelerator 를 아예 안 준다 —
// 빈 문자열을 그대로 넘기면 Electron 이 이상한 표시를 만들 수 있어서다.
function accel(a: string): string | undefined {
  return a || undefined
}

function buildTrayMenu(): Menu {
  const hasSelection = getSelectedWindowId() !== null
  // 자동 탐지 결과가 마음에 안 들 때 강제로 드래그 선택으로 전환하는 버튼(사용자 요청,
  // 2026-07-29) — 선택 모드가 아닐 때는 뜻이 없어(영역 자체가 아직 안 쓰임) 그때만 보여준다.
  const inSelectMode = currentMode() === 'select'
  // "OCR로 전환"은 지금 실제로 자막/웹 direct 추출 중일 때만 뜻이 있다(이미 OCR이면 필요 없음).
  const inDirectExtraction = isSubtitleModeActive() || isWebModeActive()
  const settings = getSettings()

  return Menu.buildFromTemplate([
    ...(hasSelection
      ? [
          // 모드 전환(일반 ↔ 선택, 2026-07-29 트레이 노출 요청) — 대상 창이 있어야 뜻이
          // 있으므로 hasSelection 일 때만 보여준다. 기존 modeShortcut(기본 Opt+Q)을 그대로 표시.
          {
            label: '모드 전환',
            accelerator: accel(settings.modeShortcut),
            click: toggleMode,
          },
          {
            label: '창 선택 전환',
            accelerator: accel(settings.windowSelectShortcut),
            click: openWindowPicker,
          },
          {
            label: '창 선택 해제',
            accelerator: accel(settings.windowDeselectShortcut),
            click: deselectWindow,
          },
        ]
      : [{ label: '창 선택', accelerator: accel(settings.windowSelectShortcut), click: openWindowPicker }]),
    ...(inSelectMode
      ? [
          {
            label: '영역 수동 선택',
            accelerator: accel(settings.manualRegionShortcut),
            click: requestManualRegionSelection,
          },
        ]
      : []),
    ...(inDirectExtraction
      ? [
          {
            label: 'OCR로 전환',
            accelerator: accel(settings.forceOcrShortcut),
            click: requestForceOcr,
          },
        ]
      : []),
    { label: '설정', accelerator: accel(settings.settingsShortcut), click: openSettingsWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ])
}

export function createTray(): Tray {
  if (tray) return tray

  // macOS 메뉴바 표준 높이는 22pt(레티나 44px)라 Windows와 같은 32px로 리사이즈하면
  // 비균등 스케일링이 걸려 아이콘이 가로로 길쭉하게 보인다. macOS에서는 배경을 검정,
  // 글자를 흰색으로 바꾼 전용 자산을 써서 라이트/다크 메뉴바 어디서나 또렷하게 보이게 한다.
  const isMac = process.platform === 'darwin'
  const iconPath = isMac ? resolveMacTrayIconPath() : resolveIconPath()
  const iconSize = isMac ? 22 : 32
  const icon = nativeImage.createFromPath(iconPath).resize({ width: iconSize, height: iconSize })
  tray = new Tray(icon)
  tray.setToolTip('Nuance')

  // setContextMenu 대신 클릭마다 직접 메뉴를 새로 만들어 띄운다 — 선택 상태에 따라
  // 항목이 달라져야 해서, 고정 메뉴 하나를 미리 등록해두는 방식은 쓸 수 없다.
  const showMenu = () => tray?.popUpContextMenu(buildTrayMenu())
  tray.on('click', showMenu)
  tray.on('right-click', showMenu)

  // 선택하던 창이 닫히면(최소화 아님 — windows.ts 참고) 선택을 자동 해제한다(2026-07-29,
  // 사용자 요청) — 안 그러면 오버레이는 사라졌는데 트레이 메뉴엔 "선택 해제"만 남아있는
  // 상태로 굳어버렸다. 수동 "선택 해제"와 동일한 동작(메인 창으로 복귀)을 그대로 재사용.
  onTargetWindowGone(deselectWindow)

  // 트레이 메뉴 항목 전역 단축키 등록(2026-07-29, 기본 Opt+1/2/3) — 메뉴가 떠 있지
  // 않아도 어디서나 동작해야 하므로 globalShortcut 기반(shortcut.ts: registerNamedShortcut).
  // 설정 화면에서 바꾸면 updateNamedShortcut 으로 재등록(ipc.ts).
  const settings = getSettings()
  registerNamedShortcut('windowSelect', settings.windowSelectShortcut, openWindowPicker)
  registerNamedShortcut('windowDeselect', settings.windowDeselectShortcut, deselectWindow)
  registerNamedShortcut('manualRegion', settings.manualRegionShortcut, requestManualRegionSelection)
  registerNamedShortcut('forceOcr', settings.forceOcrShortcut, requestForceOcr)

  return tray
}
