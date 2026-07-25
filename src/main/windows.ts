import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { AppMode } from '@shared/types'
import { getWindowScreenRect, onWindowLocationChanged } from './selection/win32Capture'

// 3종 윈도우 팩토리 (PLAN.md §5)
//  - 메인: 창 선택 / 설정 진입
//  - 오버레이: 투명·클릭스루, 단어 하이라이트/커서 피드백 (담당 A)
//  - 팝업: 발음·사전·통합질문·구글탭 (담당 B)

const preload = join(__dirname, '../preload/index.js')

function loadRoute(win: BrowserWindow, route: string) {
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

let mainWindow: BrowserWindow | null = null
let pickerWindow: BrowserWindow | null = null

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 460,
    show: true,
    autoHideMenuBar: true,
    webPreferences: { preload, sandbox: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRoute(win, 'main')
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
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
    alwaysOnTop: true,
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
  }
  if (!overlayVisible) {
    win.showInactive()
    overlayVisible = true
  }
}

let locationHookWired = false

/**
 * 선택된 창의 테두리 색 표시(일반=파랑/선택=보라) — 대상 창 bounds 바로 바깥에 정렬하고,
 * 대상 창이 이동/리사이즈되는 즉시(Win32 WinEventHook) 오버레이도 따라가게 한다.
 * 훅이 이벤트를 놓치는 경우를 대비해 저빈도 폴링을 안전망으로 같이 둔다.
 */
export function trackSelectionOverlay(hwnd: bigint): void {
  trackedHwnd = hwnd
  applyOverlayBounds(getWindowScreenRect(hwnd))

  if (!locationHookWired) {
    onWindowLocationChanged((changedHwnd) => {
      if (trackedHwnd !== null && changedHwnd === trackedHwnd) {
        applyOverlayBounds(getWindowScreenRect(trackedHwnd))
      }
    })
    locationHookWired = true
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
