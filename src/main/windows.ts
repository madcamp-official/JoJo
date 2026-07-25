import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

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

const MAIN_WIDTH = 760
const MAIN_HEIGHT_NORMAL = 460
const MAIN_HEIGHT_EXPANDED = 900

/** 설정 화면 진입 시 메인 창을 세로로 확대하고, 메인 화면 복귀 시 원래 크기로 되돌린다. */
export function setMainWindowExpanded(expanded: boolean): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const { height: workHeight } = screen.getPrimaryDisplay().workAreaSize
  const target = expanded ? Math.min(MAIN_HEIGHT_EXPANDED, workHeight - 40) : MAIN_HEIGHT_NORMAL
  if (win.getSize()[1] === target) return
  win.setSize(MAIN_WIDTH, target, false) // 애니메이션 없이 즉시 변경
  win.center()
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

// TODO(담당 A): 선택된 창 위에 정확히 정렬되는 투명·클릭스루 오버레이.
export function createOverlayWindow(bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload, sandbox: false },
  })
  win.setIgnoreMouseEvents(true, { forward: true }) // 기본 클릭스루, 단어 위에서만 해제
  loadRoute(win, 'overlay')
  return win
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
