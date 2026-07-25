import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { SelectionContext } from '@shared/types'

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

// 선택 확정 후 뜨는 검색/채팅 팝업 (담당 B).
//  - 화면 중앙에 뜨고, 헤더 드래그로 사용자가 위치를 옮길 수 있다(styles.css: -webkit-app-region).
//  - 담당 A 통합 시: 선택 파이프라인이 SelectionContext 를 만들어 createPopupWindow(ctx) 로 넘긴다.
//    지금은 데모용으로 ctx 없이 열면 팝업이 자체 목업(호빗 well-to-do)으로 fallback 한다.
let popupWindow: BrowserWindow | null = null
let popupContext: SelectionContext | null = null

const POPUP_WIDTH = 460
const POPUP_HEIGHT = 640

export function createPopupWindow(ctx: SelectionContext | null = null): BrowserWindow {
  popupContext = ctx
  if (popupWindow) {
    popupWindow.focus()
    popupWindow.webContents.send(IPC.POPUP_GET_CONTEXT, ctx) // 이미 열려 있으면 컨텍스트만 갱신
    return popupWindow
  }
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    x: Math.round((screenWidth - POPUP_WIDTH) / 2),
    y: Math.round((screenHeight - POPUP_HEIGHT) / 2),
    frame: false,
    alwaysOnTop: true,
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
  loadRoute(win, 'popup')
  return win
}

/** 팝업 렌더러가 마운트 시 조회하는 현재 SelectionContext (없으면 null → 렌더러가 목업 fallback). */
export function getPopupContext(): SelectionContext | null {
  return popupContext
}
