import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import {
  getMainWindow,
  onWindowResized,
  openSettingsWindow,
  sendOverlayNotice,
  sendRegionSelectionNeeded,
  setOverlayMode,
} from '../windows'
import { isTrayMenuOpen } from '../tray'
import { startChangeWatcher, stopChangeWatcher } from './changeWatcher'
import { invalidateExtractionCache, refreshExtractionCache } from './extractionCache'
import { getSelectedWindowId } from './capture'
import { autoDetectRegion, clearRegion, getRegion, setRegion } from './regionSelection'
import { decideExtraction, type ExtractionDecision } from './decideOcr'
import { isSubtitleModeActive, startSubtitleMode, stopSubtitleMode } from './subtitleSource'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 macOS: Option+Q / Windows: Alt+Q)
// Electron accelerator 의 'Alt' 는 macOS 에서 Option 키로 자동 매핑되므로 플랫폼 분기가 필요 없다.
let mode: AppMode = 'normal'
let currentAccelerators: string[] = []

// 판정 세대(epoch) — 선택 모드 진입 직후엔 확장이 아직 활성 탭을 보고하기 전이라(WS
// 연결/핸드셰이크가 비동기) decideExtraction() 이 일시적으로 OCR 로 잘못 판정하는 경우가
// 있다. OCR 판정이 시작한 무거운 비동기 체인(자동 영역 감지→OCR)이 나중에 도착한 정확한
// 판정(예: 자막)을 덮어쓰지 않도록, 매 판정마다 세대를 올리고 비동기 완료 시점에 세대가
// 여전히 최신인지 확인한다 — 낡은 세대의 완료는 조용히 버린다.
let decisionEpoch = 0

// 실제 마우스 드래그(이동이든 리사이즈든)는 WinEventHook 이 한 번에 끝나지 않고 위치가
// 바뀔 때마다(픽셀 단위로) 연달아 이벤트를 쏟아낸다 — resizeJitter 허용치(windows.ts)를
// 넘는 "진짜" 크기 변화라도, 드래그 도중에는 여러 번 연속으로 잡힐 수 있다. 매번 즉시
// 처리하면 자동 영역 감지(무거운 Python 서브프로세스 호출)가 겹쳐 돌면서 심한 렉을
// 유발했다(실사용 중 확인) — 드래그가 끝나고 크기가 안정된 뒤 한 번만 처리한다.
const RESIZE_SETTLE_DELAY_MS = 400
let resizeSettleTimer: NodeJS.Timeout | null = null

// 창 크기가 바뀌면 이전에 지정한 OCR 영역(regionSelection.ts)의 좌표가 더 이상 유효하지
// 않다 — 선택 모드는 그대로 유지하되(모드를 강제로 바꾸지 않음), 영역과 캐시된 단어를
// 비워서 더 이상 아무 박스도 선택되지 않게 하고, 안내 배너와 함께 바로 영역 재선택
// 드래그 모드로 들어간다(오버레이가 배너를 먼저 잠깐 보여준 뒤 드래그 안내로 전환).
onWindowResized(() => {
  if (mode !== 'select') return
  // 자막 경로는 확장이 실시간 좌표를 주므로 창 리사이즈 시 OCR 영역 재선택이 필요 없다.
  if (isSubtitleModeActive()) return
  clearRegion()
  invalidateExtractionCache() // 이전 영역 기준 캐시/단어를 비움(오버레이에도 빈 배열 통지돼 박스가 사라짐)
  stopChangeWatcher() // 영역이 무효화됐으니 그 영역 기준 변화 감지도 멈춘다(재선택 후 다시 시작)
  sendOverlayNotice('창 크기가 바뀌었어요. 본문 영역을 다시 찾는 중이에요…')
  if (resizeSettleTimer) clearTimeout(resizeSettleTimer)
  resizeSettleTimer = setTimeout(() => {
    resizeSettleTimer = null
    void acquireRegionAutomaticallyOrAskDrag()
  }, RESIZE_SETTLE_DELAY_MS)
})

function toggleMode(): void {
  mode = mode === 'normal' ? 'select' : 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  if (mode !== 'select') {
    stopChangeWatcher()
    stopSubtitleMode()
    return
  }
  void enterSelectMode()
}

/**
 * 선택 모드 진입 — 추출 방식을 판정해(브라우저 유튜브/넷플릭스면 자막, 그 외 OCR)
 * 알맞은 경로로 분기한다. 판정은 비동기(언어 감지 등)라 진입 후 적용한다.
 */
async function enterSelectMode(): Promise<void> {
  const epoch = ++decisionEpoch
  const decision = await decideExtraction()
  if (mode !== 'select' || epoch !== decisionEpoch) return // 그 사이 토글로 빠져나갔거나 재판정으로 대체됐으면 무시
  applyExtractionDecision(decision)
}

/**
 * 판정 결과를 실제 파이프라인에 적용한다. 선택 모드 진입 시, 그리고 선택 모드를 유지한
 * 채 탭/URL 이 바뀌어 재판정(reevaluate.ts)될 때 호출된다. 매 호출마다 세대를 올려, 이번
 * 판정이 시작하는 비동기 체인(acquireRegionAutomaticallyOrAskDrag 등)이 그 사이 더 최신
 * 판정으로 대체됐을 때 스스로 무시하게 한다.
 */
export function applyExtractionDecision(decision: ExtractionDecision): void {
  if (mode !== 'select') return
  const epoch = ++decisionEpoch
  if (decision.mode === 'subtitle') {
    // 자막 경로 — OCR 영역 선택/캡처/변화감지를 전부 중단하고 확장 자막을 쓴다.
    stopChangeWatcher()
    startSubtitleMode()
    return
  }
  // OCR/direct 경로 — 자막 모드였으면 중단하고 기존 영역/OCR 흐름으로.
  stopSubtitleMode()
  if (getRegion()) {
    refreshExtractionCache()
    startChangeWatcher()
  } else {
    void acquireRegionAutomaticallyOrAskDrag(epoch)
  }
}

// autoDetectRegion() 은 Python(DocLayout-YOLO) 서브프로세스를 스폰하는 무거운 호출이라,
// 이미 하나가 진행 중인데 또 시작하면(예: 디바운스를 뚫고 연달아 들어온 요청) CPU를
// 서로 잡아먹어 렉이 심해진다(실사용 중 확인) — 한 번에 하나만 돌리고, 그사이 또
// 요청이 들어오면 지금 것이 끝난 뒤 딱 한 번만 더 돈다(여러 번 쌓아두지 않음).
let detecting = false
let pendingRedetect = false

/**
 * 담당 A — 실험용 브랜치(experiment/doclayout-yolo). 영역이 없을 때(처음 선택한 창,
 * 리사이즈로 무효화된 뒤) 먼저 DocLayout-YOLO 로 본문 영역 자동 감지를 시도한다
 * (regionSelection.ts: autoDetectRegion) — 모드 진입 시 기본으로 뜨는 "텍스트 추출
 * 중…" 표시가 이 대기 시간도 자연히 가려준다. 성공하면 드래그 없이 바로 그 영역으로
 * 추출을 시작하고, 실패하면(Python 환경 없음, 본문 인식 실패 등) 기존처럼 오버레이에
 * 드래그 선택을 요청한다 — 즉 이 실험 기능은 "잘 되면 자동, 안 되면 기존 수동 방식"
 * 으로 완전히 폴백하므로 항상 안전하다.
 */
async function acquireRegionAutomaticallyOrAskDrag(epoch = decisionEpoch): Promise<void> {
  if (detecting) {
    pendingRedetect = true
    return
  }
  detecting = true
  try {
    const detected = await autoDetectRegion()
    // 그 사이 모드가 바뀌었거나(빠른 토글 등), 더 최신 판정(예: 자막 모드)으로 대체됐으면
    // 이 낡은 OCR 체인의 완료 결과는 버린다 — 안 그러면 이미 전환된 자막 모드를 덮어쓴다.
    if (mode !== 'select' || epoch !== decisionEpoch) return
    if (detected) {
      setRegion(detected)
      refreshExtractionCache()
      startChangeWatcher()
    } else {
      // 영역이 없으면(처음 선택하는 창이거나, 리사이즈로 무효화된 뒤) 오버레이에 드래그
      // 선택을 요청한다 — 사용자가 영역을 그리면 ipc.ts(SUBMIT_REGION)가 저장 후 추출을 시작한다.
      sendRegionSelectionNeeded()
    }
  } finally {
    detecting = false
    if (pendingRedetect) {
      pendingRedetect = false
      if (epoch === decisionEpoch) void acquireRegionAutomaticallyOrAskDrag(epoch)
    }
  }
}

/**
 * accelerator 에 등록할 실제 조합 목록을 만든다. Electron 의 'CommandOrControl'은
 * "Cmd 또는 Ctrl 둘 다"가 아니라 macOS 에서는 Cmd, 그 외에서는 Ctrl 로 딱 하나만 고정
 * 매핑된다 — 그래서 macOS 에서 물리 Ctrl 키를 눌러도 반응하지 않는다. **설정 화면(2026-07-28
 * 이후)은 이제 Cmd/Ctrl 을 서로 다른 물리 키로 취급해 각각 'Command'/'Control'로 따로
 * 기록**하므로 새로 저장되는 값은 'CommandOrControl'을 안 쓰지만, 과거에 저장된 설정
 * 값(예: 이전 기본값)과의 호환을 위해 이 치환 로직은 그대로 남겨둔다 — 'CommandOrControl'
 * 이 포함된 경우 macOS 에서 'Control'로 치환한 조합도 함께 등록해 Cmd/Ctrl 둘 다 동작하게 한다.
 */
function expandAccelerator(accelerator: string): string[] {
  if (process.platform !== 'darwin' || !accelerator.includes('CommandOrControl')) {
    return [accelerator]
  }
  return [accelerator, accelerator.replace('CommandOrControl', 'Control')]
}

export function registerModeShortcut(accelerator = 'Alt+Q'): void {
  if (!accelerator) return // 빈 문자열 = 단축키 해제 상태(등록 안 함)
  const accelerators = expandAccelerator(accelerator)
  accelerators.forEach((a) => globalShortcut.register(a, toggleMode))
  currentAccelerators = accelerators
}

/**
 * 설정 화면에서 단축키를 변경/해제할 때 호출 — 기존 등록을 해제한 뒤 새 accelerator 로
 * 재등록한다. 빈 문자열을 넘기면 해제만 하고 새로 등록하지 않는다(단축키 없음 상태).
 */
export function updateModeShortcut(accelerator: string): void {
  currentAccelerators.forEach((a) => globalShortcut.unregister(a))
  currentAccelerators = []
  registerModeShortcut(accelerator)
}

export function currentMode(): AppMode {
  return mode
}

/** 지금 이 단축키를 눌러도 되는 상황인지 — "어디서나"가 아니라 (1) Nuance 자신의 창이
 *  포커싱돼 있을 때, (2) 트레이 메뉴(창 선택/설정/종료)가 떠 있을 때, (3) 선택된 대상
 *  창이 포커싱돼 있을 때로 한정한다(사용자 요청, 2026-07-29 — globalShortcut 은 원래
 *  다른 아무 앱에 포커스가 있어도 전역으로 반응하는데, 그러면 예를 들어 이 단축키와
 *  다른 앱의 단축키가 우연히 겹칠 때 사용자가 그 앱을 쓰다가 의도치 않게 설정 화면이
 *  뜨는 문제가 있었음). 선택된 대상 창 포커스 판정은 플랫폼 네이티브 호출이 필요해
 *  비동기다 — win32Capture.isWin32WindowForeground/macWindow.isMacWindowFocused. */
async function isSettingsShortcutAllowed(): Promise<boolean> {
  if (getMainWindow()?.isFocused()) return true
  if (isTrayMenuOpen()) return true

  const selectedId = getSelectedWindowId()
  if (!selectedId) return false

  if (process.platform === 'win32') {
    const { isWin32WindowForeground } = await import('./win32Capture')
    try {
      return isWin32WindowForeground(BigInt(selectedId))
    } catch {
      return false // hwnd 파싱 실패(형식이 다른 값 등) — 안전하게 거부
    }
  }
  if (process.platform === 'darwin') {
    const { isMacWindowFocused } = await import('./macWindow')
    const windowId = Number(/^window:(\d+)/.exec(selectedId)?.[1])
    return Number.isFinite(windowId) && isMacWindowFocused(windowId)
  }
  return false
}

// 담당 공동 — "선택된 컨텍스트에서만" 설정 화면 열기 전역 단축키(기본 CommandOrControl+,,
// macOS 관례상 Cmd+, / 그 외 Ctrl+,). 모드 전환 단축키와 동일한 등록/해제/OS 대응 패턴을
// 그대로 재사용한다(expandAccelerator 로 macOS 에서 Cmd/Ctrl 둘 다 동작하게) — 다만
// 실제 동작 여부는 위 isSettingsShortcutAllowed 로 한 번 더 걸러진다.
let currentSettingsAccelerators: string[] = []

export function registerSettingsShortcut(accelerator = 'CommandOrControl+,'): void {
  if (!accelerator) return // 빈 문자열 = 단축키 해제 상태(등록 안 함)
  const accelerators = expandAccelerator(accelerator)
  accelerators.forEach((a) =>
    globalShortcut.register(a, () => {
      void isSettingsShortcutAllowed().then((allowed) => {
        if (allowed) openSettingsWindow()
      })
    }),
  )
  currentSettingsAccelerators = accelerators
}

export function updateSettingsShortcut(accelerator: string): void {
  currentSettingsAccelerators.forEach((a) => globalShortcut.unregister(a))
  currentSettingsAccelerators = []
  registerSettingsShortcut(accelerator)
}

/**
 * 창을 (재)선택할 때 호출 — 선택 모드였다면 일반 모드로 되돌린다. 새로 선택한 창은
 * 아직 캐시된 단어 위치가 없는데 선택 모드 테두리만 남아있으면 헷갈리고, 굳이
 * 자동으로 새 창에 대해 선택 모드를 유지할 이유도 없다.
 */
export function resetToNormalMode(): void {
  if (mode === 'normal') return
  mode = 'normal'
  setOverlayMode(mode)
  stopChangeWatcher()
}
