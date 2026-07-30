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
import { isPdfAxModeActive, isPreviewWindowSelected } from './selection/pdfAxSource'
import {
  getMainWindow,
  hideSelectionOverlay,
  showMainWindowAtRoute,
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
// 자동판정으로 되돌아간다. 웹/자막은 이 방향(direct→OCR)만 지원한다.
// PDF(Preview)는 선택 모드인 동안 항상 노출되고 **양방향**이다(사용자 요청, 2026-07-30) —
// 지금 direct(AX)로 읽는 중이면 "OCR로 전환", OCR로 읽는 중(초기 스캔본 판정 또는 이전
// 토글 결과)이면 "텍스트 추출로 전환"으로 라벨이 바뀐다. pdfAxSource.ts 가 문서당 판정을
// 한 번만 내리고 스크롤로는 재판정하지 않기 때문에(삽화 페이지 등으로 문서 전체가 잘못
// 스캔본 취급되는 걸 막는 정책), 첫 판정이 틀렸을 때 사용자가 직접 되돌릴 수 있는 유일한
// 통로가 이 토글이다.

let tray: Tray | null = null

export function deselectWindow(): void {
  setSelectedWindowId(null)
  setSelectedWindowName(null)
  invalidateExtractionCache()
  clearExtractionHistory() // 선택 해제도 "전환"과 동일하게 직전 회차 문맥을 비운다
  clearRegion()
  hideSelectionOverlay()
  getMainWindow()?.webContents.send(IPC.WINDOW_SELECTED, null)
  showMainWindowAtRoute('main')
}

export function openWindowPicker(): void {
  showMainWindowAtRoute('picker')
}

// Windows 에서 accelerator 프로퍼티를 주면 OS가 현재 로케일로 키 이름을 자체 렌더링해
// (예: ',' 가 "콤마"로 표시) 설정 화면 표시와 다르게 보인다 — 한때 Windows/Linux 만
// accelerator 대신 라벨에 직접 텍스트를 붙이는 방식으로 바꿨었지만(2026-07-30),
// 그러면 트레이 메뉴가 열려 있는 동안 그 키를 눌러 항목을 바로 선택하는 네이티브 동작이
// 같이 없어진다(accelerator 프로퍼티가 "표시"와 "메뉴 열려있을 때 키로 선택" 두 기능을
// 겸하고 있어 분리가 안 됨, 실사용 확인). 후자 기능을 지키기로 하고 원래대로 되돌림
// (2026-07-30 사용자 결정 — "콤마" 표시는 감수).
function menuEntry(label: string, shortcut: string): { label: string; accelerator?: string } {
  return { label, accelerator: shortcut || undefined }
}

function buildTrayMenu(): Menu {
  const hasSelection = getSelectedWindowId() !== null
  // 자동 탐지 결과가 마음에 안 들 때 강제로 드래그 선택으로 전환하는 버튼(사용자 요청,
  // 2026-07-29) — 선택 모드가 아닐 때는 뜻이 없어(영역 자체가 아직 안 쓰임) 그때만 보여준다.
  const inSelectMode = currentMode() === 'select'
  // "OCR로 전환"은 지금 실제로 자막/웹 direct 추출 중일 때만 뜻이 있다(이미 OCR이면 필요 없음).
  const inDirectExtraction = isSubtitleModeActive() || isWebModeActive()
  // PDF(Preview)는 양방향 토글이라 라벨이 현재 상태에 따라 바뀐다(사용자 요청, 2026-07-30)
  // — direct(AX)로 읽는 중이면 "OCR로 전환", OCR로 읽는 중(초기 스캔본 판정 또는 이전
  // 토글 결과)이면 "텍스트 추출로 전환". 웹/자막처럼 한쪽 방향만 있는 게 아니라 선택된
  // 창이 Preview인 동안은 늘 노출된다(직접 추출이 지금 실패 중이어도 되돌릴 방법이 있어야
  // 하므로 inDirectExtraction 과 달리 "지금 direct 중" 조건을 안 건다).
  const isPdfWindow = isPreviewWindowSelected()
  const settings = getSettings()

  return Menu.buildFromTemplate([
    ...(hasSelection
      ? [
          // 모드 전환(일반 ↔ 선택, 2026-07-29 트레이 노출 요청) — 대상 창이 있어야 뜻이
          // 있으므로 hasSelection 일 때만 보여준다. 기존 modeShortcut(기본 Opt+`)을 그대로 표시.
          {
            ...menuEntry('모드 전환', settings.modeShortcut),
            click: toggleMode,
          },
          {
            ...menuEntry('창 선택 전환', settings.windowSelectShortcut),
            click: openWindowPicker,
          },
          {
            ...menuEntry('창 선택 해제', settings.windowDeselectShortcut),
            click: deselectWindow,
          },
        ]
      : [{ ...menuEntry('창 선택', settings.windowSelectShortcut), click: openWindowPicker }]),
    ...(inSelectMode
      ? [
          {
            ...menuEntry('영역 수동 선택', settings.manualRegionShortcut),
            click: requestManualRegionSelection,
          },
        ]
      : []),
    ...(inSelectMode && isPdfWindow
      ? [
          {
            ...menuEntry(isPdfAxModeActive() ? 'OCR로 전환' : '텍스트 추출로 전환', settings.forceOcrShortcut),
            click: requestForceOcr,
          },
        ]
      : inDirectExtraction
        ? [
            {
              ...menuEntry('OCR로 전환', settings.forceOcrShortcut),
              click: requestForceOcr,
            },
          ]
        : []),
    { ...menuEntry('설정', settings.settingsShortcut), click: openSettingsWindow },
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
