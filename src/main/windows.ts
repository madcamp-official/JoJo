import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { AppMode } from '@shared/types'
// win32Capture 는 koffi 로 user32.dll 등을 로드하므로 최상단 static import 로 두면
// Windows 가 아닌 OS(맥·리눅스)에서도 import 시점에 DLL 로드가 실행돼 크래시한다.
// → Windows 경로에서만 동적 import 로 지연 로드한다(koffi 는 optionalDependencies).
// `import type` 은 컴파일 타임에 완전히 제거되므로 런타임 로드가 없다.
import type * as Win32Capture from './selection/win32Capture'

// 3종 윈도우 팩토리 (PLAN.md §5)
//  - 메인: 창 선택 / 설정 진입
//  - 오버레이: 투명·클릭스루, 단어 하이라이트/커서 피드백 (담당 A)
//  - 팝업: 발음·사전·통합질문·구글탭 (담당 B)

const preload = join(__dirname, '../preload/index.js')

// 패키징 전(electron-vite dev/build) 기준 — out/main/index.js 에서 두 단계 위가 프로젝트
// 루트. TODO: electron-builder 등으로 실제 패키징할 때 리소스 경로 재검토 필요.
export function resolveIconPath(): string {
  return join(__dirname, '../../build/icon.png')
}

function loadRoute(win: BrowserWindow, route: string) {
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

let mainWindow: BrowserWindow | null = null
let pickerWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

// 트레이 "종료" 메뉴로 실제 종료할 때만 true — 그 전까지는 메인 창 X 버튼이 앱을
// 끄지 않고 트레이로 숨긴다(PLAN.md §3: 창 선택 후 백그라운드 실행).
let isQuitting = false

export function setQuitting(value: boolean): void {
  isQuitting = value
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 460,
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

/** 트레이 "설정" 항목 / 메인 화면 설정 아이콘에서 연다 — 이미 열려 있으면 포커스만. */
export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 520,
    height: 640,
    autoHideMenuBar: true,
    icon: resolveIconPath(),
    webPreferences: { preload, sandbox: false },
  })
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  settingsWindow = win
  loadRoute(win, 'settings')
  return win
}

const PICKER_WIDTH = 860
const PICKER_HEIGHT = 760

/** 창 선택 목록 — 메인 창의 모달 자식 창으로 별도 OS 창에 띄운다. */
export function showWindowPicker(): void {
  if (pickerWindow) {
    pickerWindow.focus()
    return
  }
  const parent = mainWindow ?? undefined
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: PICKER_WIDTH,
    height: PICKER_HEIGHT,
    x: Math.round((screenWidth - PICKER_WIDTH) / 2),
    y: Math.round((screenHeight - PICKER_HEIGHT) / 2),
    frame: false,
    resizable: false,
    modal: !!parent,
    parent,
    show: false,
    webPreferences: { preload, sandbox: false },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (pickerWindow === win) pickerWindow = null
  })
  pickerWindow = win
  loadRoute(win, 'picker')
}

export function closeWindowPicker(): void {
  pickerWindow?.close()
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

function sameBounds(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
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
    show: false,
    webPreferences: { preload, sandbox: false },
  })
  win.setIgnoreMouseEvents(true, { forward: true }) // 완전 클릭스루 — 테두리만 그리고 조작엔 개입 안 함
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
  }, TRACK_FALLBACK_INTERVAL_MS)
}

export function hideSelectionOverlay(): void {
  trackedHwnd = null
  if (trackTimer) {
    clearInterval(trackTimer)
    trackTimer = null
  }
  applyOverlayBounds(null)
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

// TODO(담당 B): 선택 좌표 근처에 뜨는 검색 팝업.
export function createPopupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 620,
    frame: false,
    alwaysOnTop: true,
    webPreferences: { preload, sandbox: false },
  })
  loadRoute(win, 'popup')
  return win
}
