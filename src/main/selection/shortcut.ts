import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import {
  consumeDebugBlocksVisible,
  onWindowResized,
  sendOverlayNotice,
  sendRegionSelectionNeeded,
  setOverlayMode,
} from '../windows'
import { getSettings } from '../settingsStore'
import { startChangeWatcher, stopChangeWatcher } from './changeWatcher'
import { invalidateExtractionCache, refreshExtractionCache } from './extractionCache'
import { autoDetectRegion, clearRegion, getRegion, setRegion } from './regionSelection'
import { decideExtraction, type ExtractionDecision } from './decideOcr'
import { isSubtitleModeActive, startSubtitleMode, stopSubtitleMode } from './subtitleSource'
import { isWebModeActive, startWebMode, stopWebMode } from './webSource'

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
  // 자막/웹 경로는 화면 좌표 기반 OCR 영역이 아예 없으므로 창 리사이즈 시 재선택이 필요 없다.
  if (isSubtitleModeActive() || isWebModeActive()) return
  clearRegion()
  invalidateExtractionCache() // 이전 영역 기준 캐시/단어를 비움(오버레이에도 빈 배열 통지돼 박스가 사라짐)
  stopChangeWatcher() // 영역이 무효화됐으니 그 영역 기준 변화 감지도 멈춘다(재선택 후 다시 시작)
  sendOverlayNotice('창 크기가 바뀌었어요. 본문 영역을 다시 찾는 중이에요…')
  if (resizeSettleTimer) clearTimeout(resizeSettleTimer)
  resizeSettleTimer = setTimeout(() => {
    resizeSettleTimer = null
    if (getSettings().autoDetectRegion) {
      void acquireRegionAutomaticallyOrAskDrag()
    } else {
      acquireRegionManually()
    }
  }, RESIZE_SETTLE_DELAY_MS)
})

/**
 * 자동 탐지 블록이 오버레이에 떠 있는 동안 이 단축키를 누르면(사용자 요청, 2026-07-29)
 * 첫 번째 누름은 그 블록만 지우고 모드는 그대로 유지한다 — 블록을 보다가 무심코 눌렀는데
 * 바로 모드까지 바뀌어버리는 게 불편하다는 피드백. 블록이 없으면(자동 탐지 결과가
 * 아니었거나 이미 한 번 지운 뒤) 평소처럼 바로 모드를 토글한다.
 */
/** 선택 모드를 끈다(단축키 토글의 "끄기" 분기와 자막→비자막 자동 전환이 공유). */
function exitSelectMode(): void {
  mode = 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  stopChangeWatcher()
  stopSubtitleMode()
  stopWebMode()
  clearRegionEscapeShortcut()
}

export function toggleMode(): void {
  if (consumeDebugBlocksVisible()) return
  if (mode === 'select') {
    exitSelectMode()
    return
  }
  mode = 'select'
  setOverlayMode(mode)
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
    stopWebMode()
    stopChangeWatcher()
    startSubtitleMode()
    return
  }
  if (decision.mode === 'web') {
    // 일반 웹페이지 경로 — 확장의 본문 DOM 텍스트를 우선 시도한다(decideOcr.ts, 낙관적
    // 판정). 실제 텍스트가 부족하면 startWebMode 가 이 콜백을 통해 기존 OCR 흐름으로
    // 넘어간다(§4.1 "텍스트 양으로 분기").
    stopSubtitleMode()
    stopChangeWatcher()
    startWebMode(() => startOcrFallback(epoch))
    return
  }
  // 자막(미디어)/웹(텍스트 위주) 페이지였다가 그 외 페이지로 바뀐 경우(예: 유튜브 영상을
  // 보다가 채널/홈으로 이동) — OCR 로 자동 전환하지 않고 선택 모드 자체를 끈다(사용자 요청,
  // 2026-07-29, 웹 모드에도 동일하게 적용). 그 페이지를 벗어난 건 "이 페이지도 계속
  // 선택하고 싶다"는 의도가 아닐 가능성이 커서, 엉뚱한 페이지에 OCR 영역 지정 드래그가
  // 뜨는 것보다 조용히 꺼지는 쪽이 낫다고 판단.
  if (isSubtitleModeActive() || isWebModeActive()) {
    exitSelectMode()
    return
  }
  // OCR/direct 경로(자막/웹 모드였던 적이 없는 일반 진입) — 기존 영역/OCR 흐름으로.
  stopSubtitleMode()
  stopWebMode()
  startOcrFallback(epoch)
}

// OCR 영역/캡처/변화감지 흐름으로 진입한다 — decision.mode 가 애초에 ocr/direct 였을 때,
// 그리고 web 모드가 텍스트 부족으로 startWebMode 의 콜백을 통해 폴백할 때 공유한다.
function startOcrFallback(epoch: number): void {
  if (getRegion()) {
    refreshExtractionCache()
    startChangeWatcher()
  } else if (getSettings().autoDetectRegion) {
    void acquireRegionAutomaticallyOrAskDrag(epoch)
  } else {
    acquireRegionManually()
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
      setRegion(detected, 'auto')
      refreshExtractionCache()
      startChangeWatcher()
    } else {
      // 영역이 없으면(처음 선택하는 창이거나, 리사이즈로 무효화된 뒤) 오버레이에 드래그
      // 선택을 요청한다 — 사용자가 영역을 그리면 ipc.ts(SUBMIT_REGION)가 저장 후 추출을 시작한다.
      requestRegionSelection()
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
 * 자동 탐지를 건너뛰고 바로 오버레이에 드래그 선택을 요청한다 — 자동 탐지 설정
 * (autoDetectRegion)이 꺼져 있을 때(선택 모드 진입/리사이즈) 기본 경로, 그리고 설정이
 * 켜져 있어도 트레이 "영역 수동 선택"으로 강제 전환할 때(requestManualRegionSelection)
 * 쓴다. acquireRegionAutomaticallyOrAskDrag 와 달리 무거운 Python 호출이 없어 동기로
 * 끝나므로 detecting/pendingRedetect 같은 겹침 방지 장치가 필요 없다.
 */
function acquireRegionManually(): void {
  requestRegionSelection()
}

// 오버레이가 "영역을 드래그로 지정하세요" 배너를 띄우는 동안(Overlay.tsx: needsRegion)
// Esc 를 누르면 선택 모드 자체를 빠져나가도록 한다(2026-07-29 사용자 요청) — 오버레이
// 창은 focusable: false 라 렌더러가 keydown 을 직접 받을 수 없으므로(windows.ts:
// ensureOverlayWindow) globalShortcut 을 쓴다. 사용자가 설정하는 영구 단축키가 아니라
// 이 배너가 떠 있는 좁은 구간에서만 등록됐다 해제되는 임시 단축키라, 그 구간이 아닐 때
// 다른 앱의 Esc 사용과 충돌하지 않는다.
let regionEscapeRegistered = false

function requestRegionSelection(): void {
  if (!regionEscapeRegistered) {
    regionEscapeRegistered = globalShortcut.register('Escape', resetToNormalMode)
  }
  sendRegionSelectionNeeded()
}

/** 드래그 완료(SUBMIT_REGION)·모드 이탈 등으로 배너가 사라질 때 호출해 임시 등록을 해제한다. */
export function clearRegionEscapeShortcut(): void {
  if (!regionEscapeRegistered) return
  globalShortcut.unregister('Escape')
  regionEscapeRegistered = false
}

/**
 * 트레이 "영역 수동 선택" 클릭 시 호출(tray.ts) — 자동 탐지 결과가 마음에 안 들 때 강제로
 * 드래그 선택으로 전환한다. 트레이가 이 메뉴 항목 자체를 선택 모드에서만 보여주므로
 * (currentMode() 체크) 여기서도 방어적으로 한 번 더 확인한다.
 */
export function requestManualRegionSelection(): void {
  if (mode !== 'select') return
  clearRegion()
  invalidateExtractionCache()
  stopChangeWatcher()
  acquireRegionManually()
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

// 트레이 메뉴 항목(창 선택/창 선택 전환/창 선택 해제/영역 수동 선택) 전용 전역 단축키
// (2026-07-29, 기본 Opt+1/2/3) — modeShortcut 처럼 콜백이 이 파일에 고정돼 있지 않고
// 항목마다 다른 곳(tray.ts)에 있어, id 별로 콜백을 등록해두고 재사용하는 범용 레지스트리로
// 둔다. tray.ts 가 createTray() 시 한 번 등록(registerNamedShortcut)하고, 설정 화면에서
// 단축키를 바꾸면 updateNamedShortcut 으로 재등록한다(updateModeShortcut과 동일 패턴).
export type NamedShortcutId = 'windowSelect' | 'windowDeselect' | 'manualRegion'
const namedAccelerators: Record<NamedShortcutId, string[]> = {
  windowSelect: [],
  windowDeselect: [],
  manualRegion: [],
}
const namedCallbacks: Partial<Record<NamedShortcutId, () => void>> = {}

function applyNamedShortcut(id: NamedShortcutId, accelerator: string): void {
  namedAccelerators[id].forEach((a) => globalShortcut.unregister(a))
  namedAccelerators[id] = []
  const cb = namedCallbacks[id]
  if (!accelerator || !cb) return // 빈 문자열 = 단축키 해제 상태(등록 안 함)
  const accelerators = expandAccelerator(accelerator)
  accelerators.forEach((a) => globalShortcut.register(a, cb))
  namedAccelerators[id] = accelerators
}

export function registerNamedShortcut(id: NamedShortcutId, accelerator: string, cb: () => void): void {
  namedCallbacks[id] = cb
  applyNamedShortcut(id, accelerator)
}

export function updateNamedShortcut(id: NamedShortcutId, accelerator: string): void {
  applyNamedShortcut(id, accelerator)
}

// "설정 화면 열기" 단축키(기본 Cmd/Ctrl+,)는 더 이상 여기(globalShortcut)에 없다
// (2026-07-29) — Cmd+,는 VSCode/Claude Desktop 등 다른 앱도 흔히 쓰는 조합인데,
// globalShortcut 은 OS 레벨에서 그 키 조합을 통째로 가로채서, Nuance가 실행 중이기만
// 하면 우리 콜백이 "지금은 동작 안 함"이라 판단해도 이미 늦어(다른 앱은 그 키 입력
// 자체를 못 받음) 다른 앱의 같은 단축키가 먹통이 되는 문제가 있었다(사용자 제보).
// "Nuance 자신의 창이 포커싱돼 있을 때"만 동작하면 충분한 조건이라 전역 후킹이
// 애초에 필요 없었다 — 각 렌더러(App.tsx)가 로컬 keydown 리스너로 직접 판정해
// IPC(OPEN_SETTINGS)로 메인에 열기만 요청하는 방식으로 교체했다(shortcutMatch.ts).
// "선택된 대상 창이 포커싱돼 있을 때도 동작"은 전역 후킹 없이는 못 하는 요구라 함께
// 포기(트레이 메뉴가 떠 있는 동안 허용하려던 이전 시도도 같은 이유로 이미 포기했었음
// — Menu 트래킹 루프가 JS 이벤트 루프를 막아 콜백 자체가 안 불림, 실사용 확인).

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
  // 자막/웹 모드였다면 확장의 캡처도 꺼야 한다 — 안 그러면 새 창을 선택해도(또는 선택
  // 해제해도) 확장은 이전 탭에서 hover 하이라이트 박스를 계속 띄운다(탭 새로고침 전까지
  // 안 꺼짐).
  stopSubtitleMode()
  stopWebMode()
  clearRegionEscapeShortcut()
}
