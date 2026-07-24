import { BrowserWindow, shell } from 'electron'
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
  return win
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
