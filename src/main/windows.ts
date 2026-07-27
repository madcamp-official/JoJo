import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { AppMode, ExtractedSelection, Word } from '@shared/types'
// win32Capture 는 koffi 로 user32.dll 등을 로드하므로 최상단 static import 로 두면
// Windows 가 아닌 OS(맥·리눅스)에서도 import 시점에 DLL 로드가 실행돼 크래시한다.
// → Windows 경로에서만 동적 import 로 지연 로드한다(koffi 는 optionalDependencies).
// `import type` 은 컴파일 타임에 완전히 제거되므로 런타임 로드가 없다.
import type * as Win32Capture from './selection/win32Capture'

// 3종 윈도우 팩토리 (PLAN.md §6)
//  - 메인: 창 선택 / 설정 진입
//  - 오버레이: 투명·클릭스루, 단어 하이라이트/커서 피드백 (담당 A)
//  - 팝업: 발음·사전·통합질문·구글탭 (담당 B)

const preload = join(__dirname, '../preload/index.js')

// 패키징 전(electron-vite dev/build) 기준 — out/main/index.js 에서 두 단계 위가 프로젝트
// 루트. TODO: electron-builder 등으로 실제 패키징할 때 리소스 경로 재검토 필요.
export function resolveIconPath(): string {
  return join(__dirname, '../../build/icon.png')
}

function loadRoute(win: BrowserWindow, route: string, query?: string) {
  const hash = query ? `${route}?${query}` : route
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${hash}` })
  }
}

let mainWindow: BrowserWindow | null = null

// 트레이 "종료" 메뉴로 실제 종료할 때만 true — 그 전까지는 메인 창 X 버튼이 앱을
// 끄지 않고 트레이로 숨긴다(PLAN.md §3: 창 선택 후 백그라운드 실행).
let isQuitting = false

export function setQuitting(value: boolean): void {
  isQuitting = value
}

/** 커서(활성 모니터)가 있는 디스플레이의 작업영역 중앙에 width×height 창을 놓을 좌표. */
function centerOnCursorDisplay(width: number, height: number): { x: number; y: number } {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
  }
}

export function createMainWindow(): BrowserWindow {
  const { x, y } = centerOnCursorDisplay(760, 460) // 실행 시 커서가 있는 모니터에 뜨도록
  const win = new BrowserWindow({
    width: 760,
    height: 460,
    x,
    y,
    show: true,
    autoHideMenuBar: true,
    icon: resolveIconPath(),
    webPreferences: { preload, sandbox: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRoute(win, 'main')
  mainWindow = win
  // X 버튼 = 트레이로 숨기기. 실제 종료는 트레이 메뉴 "종료"(app.quit, isQuitting=true)로만.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export type MainRoute = 'main' | 'picker' | 'settings'

const ROUTE_SIZES: Record<MainRoute, { width: number; height: number }> = {
  main: { width: 760, height: 460 },
  picker: { width: 860, height: 760 },
  settings: { width: 760, height: 800 },
}

// 메인/피커/설정 세 화면은 동시에 두 개 이상 보일 필요가 없어 창 하나를 재사용한다.
// 화면을 바꿀 때마다 창 크기를 그 화면에 맞게 즉시(애니메이션 없이) 바꾸고 중앙 정렬한다 —
// 리사이즈가 눈에 보이면 안 되고, 마치 다른 창이 뜬 것처럼 한 번에 바뀌어야 한다.
function resizeMainWindowForRoute(route: MainRoute): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const { width, height } = ROUTE_SIZES[route]
  // 창이 현재 놓인 모니터를 기준으로 크기 제한 + 중앙 정렬(멀티모니터에서 주 모니터로 튀지 않게).
  const wa = screen.getDisplayMatching(win.getBounds()).workArea
  const targetWidth = Math.min(width, wa.width - 40)
  const targetHeight = Math.min(height, wa.height - 40)
  win.setBounds(
    {
      x: Math.round(wa.x + (wa.width - targetWidth) / 2),
      y: Math.round(wa.y + (wa.height - targetHeight) / 2),
      width: targetWidth,
      height: targetHeight,
    },
    false,
  )
}

/** 렌더러(navigate.ts: goto())가 호출 — 렌더러가 이미 해시를 바꿨으므로 창 크기만 맞춘다. */
export function setMainWindowRoute(route: MainRoute): void {
  resizeMainWindowForRoute(route)
}

/** 메인 프로세스(트레이 등)에서 호출 — 창 크기를 맞추고, 렌더러에도 화면 전환을 지시한다. */
export function navigateMainWindow(route: MainRoute): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  resizeMainWindowForRoute(route)
  win.webContents.send(IPC.NAVIGATE, route)
}

let overlayWindow: BrowserWindow | null = null
let overlayMode: AppMode = 'normal'
let trackedHwnd: bigint | null = null
let trackTimer: NodeJS.Timeout | null = null
let lastBounds: Electron.Rectangle | null = null
let overlayVisible = false

// WinEventHook 이 실시간으로 위치를 잡아주는 게 기본이고, 이 폴링은 훅이 놓치는 경우를
// 대비한 안전망이라 느리게 돌아도 된다.
const TRACK_FALLBACK_INTERVAL_MS = 150

/**
 * Win32 API(GetWindowRect/DWM)는 물리 픽셀 좌표를 주는데, Electron BrowserWindow 의
 * bounds 는 논리(DIP) 좌표를 기대한다 — 디스플레이 배율이 100%가 아니면 그대로 쓰면
 * 어긋난다. Electron 이 제공하는 물리→논리 변환(screenToDipPoint)으로 정확히 맞춘다.
 */
function physicalToDipRect(rect: Electron.Rectangle): Electron.Rectangle {
  const topLeft = screen.screenToDipPoint({ x: rect.x, y: rect.y })
  const bottomRight = screen.screenToDipPoint({
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  })
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  }
}

/**
 * 캡처(물리 픽셀) → 오버레이 렌더링(DIP/CSS 픽셀) 배율. 캡처·OCR 은 물리 픽셀 기준이라
 * 단어 bbox 도 물리 픽셀인데, 오버레이는 DIP 기준으로 그려져서 디스플레이 배율이
 * 100%가 아니면 그대로 쓰면 어긋난다(extractionCache.ts 가 이 값으로 bbox 를 나눈다).
 */
export function getPhysicalToDipScale(physicalRect: Electron.Rectangle): number {
  const dip = physicalToDipRect(physicalRect)
  return dip.width > 0 ? physicalRect.width / dip.width : 1
}

function sameBounds(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

const resizeListeners = new Set<() => void>()

/** 대상 창의 크기(너비/높이)가 바뀔 때 통지받는다 — 위치만 바뀌는 이동은 대상 아님. */
export function onWindowResized(cb: () => void): void {
  resizeListeners.add(cb)
}

/** applyOverlayBounds/showMacOverlayAt 이 lastBounds 를 갱신하기 직전에 호출 — 크기 변화만 감지. */
function notifyIfResized(newBounds: Electron.Rectangle): void {
  if (lastBounds && (lastBounds.width !== newBounds.width || lastBounds.height !== newBounds.height)) {
    for (const cb of resizeListeners) cb()
  }
}

function ensureOverlayWindow(initialBounds: Electron.Rectangle): BrowserWindow {
  if (overlayWindow) return overlayWindow
  const win = new BrowserWindow({
    ...initialBounds,
    transparent: true,
    frame: false,
    // alwaysOnTop 을 안 쓴다 — 항상 최상위면 다른 창이 대상 창을 덮어도 테두리가 계속
    // 그 위에 떠서 이상해 보인다. 대신 z-order 상 대상 창 바로 위 한 칸에만 꽂아서
    // (syncOverlayZOrder), 다른 창이 대상 창을 덮으면 테두리도 자연스럽게 같이 가려지게 한다.
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    // 오버레이 크기/위치는 항상 setBounds() 로만 프로그래밍적으로 바뀐다(대상 창을
    // 따라감) — resizable/movable 기본값(true)을 그대로 두면, 영역 선택 대기 중
    // (needsRegion) 처럼 오버레이가 완전히 인터랙티브해질 때 사용자가 대상 창 가장자리를
    // 드래그한 게 오버레이 자신의 OS 리사이즈로 잡혀 대상 창과 따로 놀게 되는 문제가 있었다.
    resizable: false,
    movable: false,
    show: false,
    webPreferences: { preload, sandbox: false },
  })
  win.setIgnoreMouseEvents(true, { forward: true }) // 완전 클릭스루 — 테두리만 그리고 조작엔 개입 안 함
  if (process.platform === 'darwin') {
    // 미션 컨트롤/Exposé 에 오버레이 창이 썸네일로 잡히지 않게 한다.
    win.setHiddenInMissionControl(true)
    // 대상 창(일반 레벨) 바로 위에 테두리가 보이도록 floating 레벨 + 모든 스페이스에서 표시.
    // (다른 창이 대상을 덮을 때 사이에 끼는 문제는 showMacSelectionOverlay 의 가림 판정으로 숨겨 처리)
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.on('closed', () => {
    if (overlayWindow === win) overlayWindow = null
  })
  // Windows 에서 transparent+frameless 창은 생성 시 지정한 크기로 처음 보일 때 렌더링이
  // 정확히 맞물리지 않는 경우가 있다(최초 1회만) — 실제로 화면에 보인 직후 같은 bounds 를
  // 한 번 더 적용해 강제로 재배치시켜 어긋남을 없앤다.
  win.once('show', () => {
    win.setBounds(initialBounds)
  })
  overlayWindow = win
  loadRoute(win, 'overlay')
  return win
}

function applyOverlayBounds(targetRect: Electron.Rectangle | null): void {
  if (!targetRect) {
    if (overlayWindow && overlayVisible) {
      overlayWindow.hide()
      overlayVisible = false
    }
    lastBounds = null
    return
  }

  const bounds = physicalToDipRect(targetRect)
  const win = ensureOverlayWindow(bounds)
  if (!lastBounds || !sameBounds(lastBounds, bounds)) {
    notifyIfResized(bounds)
    win.setBounds(bounds)
    lastBounds = bounds
    // Windows 에서 transparent+frameless 창은 setBounds 직후 한 번에 정확히 반영되지
    // 않는 경우가 있다(특히 폭이 크게 바뀌는 재사용 시) — 다음 tick 에 같은 값을 한 번
    // 더 강제 재적용해 어긋남을 없앤다. 그 사이 값이 또 바뀌었으면 최신값으로 다시 맞춘다.
    setImmediate(() => {
      if (!win.isDestroyed()) win.setBounds(lastBounds ?? bounds)
    })
  }
  if (!overlayVisible) {
    win.showInactive()
    overlayVisible = true
  }
}

let hooksWired = false
let win32CaptureMod: typeof Win32Capture | null = null

/** 오버레이를 대상 창 바로 위 z-order 한 칸에 꽂는다 — 다른 창이 대상을 덮으면 같이 가려짐. */
function syncOverlayZOrder(mod: typeof Win32Capture, hwnd: bigint): void {
  if (!overlayWindow) return
  const overlayHwnd = overlayWindow.getNativeWindowHandle().readBigUInt64LE(0)
  mod.placeWindowJustAbove(overlayHwnd, hwnd)
}

/**
 * 선택된 창의 테두리 색 표시(일반=파랑/선택=보라) — 대상 창 bounds 바로 바깥에 정렬하고,
 * 대상 창이 이동/리사이즈되는 즉시(Win32 WinEventHook) 오버레이도 따라가게 한다.
 * 훅이 이벤트를 놓치는 경우를 대비해 저빈도 폴링을 안전망으로 같이 둔다.
 * Windows 전용 — 호출부(ipc.ts)에서 process.platform === 'win32' 일 때만 부른다.
 */
export async function trackSelectionOverlay(hwnd: bigint): Promise<void> {
  const mod = win32CaptureMod ?? (win32CaptureMod = await import('./selection/win32Capture'))
  const { getWindowScreenRect, onWindowForegroundChanged, onWindowLocationChanged } = mod

  trackedHwnd = hwnd
  applyOverlayBounds(getWindowScreenRect(hwnd))
  syncOverlayZOrder(mod, hwnd)

  if (!hooksWired) {
    onWindowLocationChanged((changedHwnd) => {
      if (trackedHwnd !== null && changedHwnd === trackedHwnd) {
        applyOverlayBounds(getWindowScreenRect(trackedHwnd))
      }
    })
    // 대상 창이 다시 포그라운드로 올라올 때(예: 다른 창에 가려졌다가 클릭해서 복귀)
    // 오버레이도 같이 그 바로 위로 다시 꽂아준다. 그 외의 경우엔 그대로 둬서, 다른
    // 창이 대상을 덮으면 오버레이도 자연스럽게 같이 가려지게 한다.
    //
    // Windows 가 대상 창을 z-order 맨 위로 올리는 작업을 아직 다 끝내기 전에 이 이벤트가
    // 먼저 도착하는 경우가 있어(레이스), 그 순간 바로 재배치하면 "일부만" 가려진 채로
    // 남는 경우가 있었다. 창 크기 어긋남 버그 때와 같은 방식으로, 즉시 한 번 + 다음
    // 틱들에 몇 번 더 재적용해서 Windows 쪽 정리가 끝난 뒤에도 확실히 맞춰지게 한다.
    onWindowForegroundChanged((changedHwnd) => {
      if (trackedHwnd === null || changedHwnd !== trackedHwnd) return
      const hwndAtEvent = trackedHwnd
      syncOverlayZOrder(mod, hwndAtEvent)
      for (const delayMs of [0, 16, 50]) {
        setTimeout(() => {
          if (trackedHwnd === hwndAtEvent) syncOverlayZOrder(mod, hwndAtEvent)
        }, delayMs)
      }
    })
    hooksWired = true
  }

  if (trackTimer) clearInterval(trackTimer)
  trackTimer = setInterval(() => {
    if (trackedHwnd === null) return
    applyOverlayBounds(getWindowScreenRect(trackedHwnd))
    // 탭 전환처럼 같은 창(hwnd) 안에서 내부적으로 다시 그려지는 경우는 포그라운드
    // 전환 이벤트가 안 떠서(창 자체는 안 바뀌니까) syncOverlayZOrder 가 그 순간에
    // 안 불린다 — 그 사이 오버레이가 뒤로 밀려도 다음 포그라운드 이벤트가 오기 전까지
    // 안 돌아왔었다. 폴링에도 같이 넣어서 최대 150ms 안에 항상 다시 앞으로 오게 한다.
    syncOverlayZOrder(mod, trackedHwnd)
  }, TRACK_FALLBACK_INTERVAL_MS)
}

export function hideSelectionOverlay(): void {
  trackedHwnd = null
  trackedMacWindowId = null
  if (trackTimer) {
    clearInterval(trackTimer)
    trackTimer = null
  }
  applyOverlayBounds(null)
}

let trackedMacWindowId: number | null = null
let macCovered = false

// 위치/크기 추적은 단일 창 조회라 가벼워 빠르게(16ms) 돌려 딜레이를 줄인다.
// 가림 판정은 전체 창 열거라 무거워 ~100ms(16*OCCLUSION_EVERY)마다만 한다.
const MAC_TRACK_INTERVAL_MS = 16
const MAC_OCCLUSION_EVERY = 6

function showMacOverlayAt(bounds: { x: number; y: number; width: number; height: number }): void {
  const win = ensureOverlayWindow(bounds) // darwin 설정(미션컨트롤 숨김·floating)은 생성 시 1회
  if (!lastBounds || !sameBounds(lastBounds, bounds)) {
    notifyIfResized(bounds)
    win.setBounds(bounds)
    lastBounds = bounds
  }
  if (!overlayVisible) {
    win.showInactive()
    overlayVisible = true
  }
}

function hideMacOverlay(): void {
  if (overlayWindow && overlayVisible) {
    overlayWindow.hide()
    overlayVisible = false
  }
}

/**
 * macOS 선택 오버레이 — Windows 의 trackSelectionOverlay 에 대응하는 mac 경로.
 * CoreGraphics(koffi, selection/macWindow.ts)로 대상 창을 앞으로 올리고 bounds 를 얻어
 * 테두리 오버레이를 그 창에 정확히 맞춘다. 이후 16ms 폴링으로 이동/리사이즈를 바로 따라가고,
 * 대상 창이 다른 앱 창에 가려지면(z-순서 판정) 테두리를 숨겨 "창 사이에 끼는" 걸 막는다.
 * 호출부(ipc.ts)에서 process.platform !== 'win32' 일 때만 부른다.
 */
export async function showMacSelectionOverlay(windowId: number): Promise<void> {
  const { raiseAndGetBounds, getMacWindowBounds, isMacTargetCovered } = await import(
    './selection/macWindow'
  )
  const ownPid = process.pid

  trackedMacWindowId = windowId
  macCovered = false
  const first = raiseAndGetBounds(windowId) // 앞으로 올리고 최초 bounds
  if (first) showMacOverlayAt(first)

  if (trackTimer) clearInterval(trackTimer)
  let tick = 0
  trackTimer = setInterval(() => {
    if (trackedMacWindowId === null) return
    if (tick % MAC_OCCLUSION_EVERY === 0) {
      macCovered = isMacTargetCovered(trackedMacWindowId, ownPid)
    }
    tick++
    if (macCovered) {
      hideMacOverlay()
      return
    }
    const b = getMacWindowBounds(trackedMacWindowId)
    if (b) showMacOverlayAt(b)
    else hideMacOverlay()
  }, MAC_TRACK_INTERVAL_MS)
}

/**
 * 오버레이가 클릭스루 상태(`setIgnoreMouseEvents(true)`)인 동안은 OS 가 이 창을 입력
 * 대상에서 완전히 제외하기 때문에, 렌더러에서 CSS `cursor` 를 바꿔도 실제 시스템
 * 커서에는 반영되지 않는다. 단어 위에 커서가 있는 동안만 일시적으로 클릭스루를 꺼서
 * (`interactive=true`) 커서 모양이 실제로 바뀌게 하고, 벗어나면 다시 켠다.
 * 렌더러(Overlay.tsx)가 자체 `mousemove` 기반 hover 판정 결과에 따라 호출한다.
 */
export function setOverlayInteractive(interactive: boolean): void {
  overlayWindow?.setIgnoreMouseEvents(!interactive, { forward: true })
}

export function getOverlayMode(): AppMode {
  return overlayMode
}

/** 전역 단축키로 모드가 토글될 때 호출 — 오버레이 렌더러에 새 색을 통지한다. */
export function setOverlayMode(mode: AppMode): void {
  overlayMode = mode
  overlayWindow?.webContents.send(IPC.MODE_CHANGED, mode)
}

/** extractionCache.ts 가 캐시를 채우거나 무효화할 때 호출 — 오버레이가 실제 단어 bbox 로 hover/클릭 판정을 하게 한다. */
export function sendOverlayWords(words: Word[]): void {
  overlayWindow?.webContents.send(IPC.EXTRACTION_WORDS, words)
}

/** changeWatcher.ts 가 화면 변화 감지로 재추출을 시작할 때 호출 — 오버레이에 "추출 중" 표시를 띄운다. */
export function sendExtractionStarted(): void {
  overlayWindow?.webContents.send(IPC.EXTRACTION_STARTED)
}

/** shortcut.ts 가 선택 모드 진입 시(영역 미지정) 또는 "영역 재선택" 요청 시 호출. */
export function sendRegionSelectionNeeded(): void {
  overlayWindow?.webContents.send(IPC.REGION_SELECTION_NEEDED)
}

/** 오버레이 상단에 잠깐 뜨는 안내 배너 — 리사이즈로 영역이 무효화됐을 때 등에 사용. */
export function sendOverlayNotice(text: string): void {
  overlayWindow?.webContents.send(IPC.OVERLAY_NOTICE, text)
}

// 선택 확정 후 뜨는 검색/채팅 팝업 (담당 B).
//  - 화면 중앙에 뜨고, 헤더 드래그로 사용자가 위치를 옮길 수 있다(styles.css: -webkit-app-region).
//  - 담당 A 통합 시: 선택 파이프라인이 ExtractedSelection 을 만들어 createPopupWindow(ctx) 로 넘긴다.
//    지금은 데모용으로 ctx 없이 열면 팝업이 자체 목업(호빗 well-to-do)으로 fallback 한다.
let popupWindow: BrowserWindow | null = null
let popupContext: ExtractedSelection | null = null

const POPUP_WIDTH = 900
const POPUP_HEIGHT = 900
// 화면이 작을 때 팝업이 화면을 넘어가지 않도록, 세로 길이는 활성 모니터 작업 영역
// 높이에서 위아래 여백을 뺀 값을 상한으로 삼는다.
const POPUP_HEIGHT_MARGIN = 40

export function createPopupWindow(
  ctx: ExtractedSelection | null = null,
  demo?: string,
): BrowserWindow {
  popupContext = ctx
  if (popupWindow) {
    popupWindow.focus()
    popupWindow.webContents.send(IPC.POPUP_GET_CONTEXT, ctx) // 이미 열려 있으면 컨텍스트만 갱신
    return popupWindow
  }
  const workAreaHeight = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea.height
  const popupHeight = Math.min(POPUP_HEIGHT, workAreaHeight - POPUP_HEIGHT_MARGIN)
  const { x, y } = centerOnCursorDisplay(POPUP_WIDTH, popupHeight) // 활성 모니터에 뜨도록
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: popupHeight,
    x,
    y,
    frame: false,
    // alwaysOnTop 을 쓰지 않는다 — 일반 창처럼 다른 창과 z-order 를 자유롭게 오갈 수 있게.
    show: false,
    webPreferences: { preload, sandbox: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (popupWindow === win) popupWindow = null
    popupContext = null
  })
  popupWindow = win
  loadRoute(win, 'popup', demo ? `demo=${demo}` : undefined)
  return win
}

/** 팝업 렌더러가 마운트 시 조회하는 현재 ExtractedSelection (없으면 null → 렌더러가 목업 fallback). */
export function getPopupContext(): ExtractedSelection | null {
  return popupContext
}

/** 현재 팝업 창의 화면 좌표/크기(DIP). 구글 검색 창을 같은 위치·크기로 띄우는 데 쓴다. */
export function getPopupBounds(): { x: number; y: number; width: number; height: number } | null {
  if (!popupWindow || popupWindow.isDestroyed()) return null
  return popupWindow.getBounds()
}
