import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type { CaptureSource, SearchRequest, SelectionContext } from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runSearch } from './search'
import { listWindows, setSelectedWindowId } from './selection/capture'
import { bringWindowToForeground } from './selection/win32Capture'
import {
  closeWindowPicker,
  getMainWindow,
  getOverlayMode,
  hideSelectionOverlay,
  showWindowPicker,
  trackSelectionOverlay,
} from './windows'

// IPC 허브 (공동) — A→B 연결점.
// 렌더러는 preload 를 통해서만 이 채널들에 접근한다.
export function registerIpc(): void {
  // 담당 A: 창 목록 조회 / 선택 (선택 창은 별도 모달 OS 창)
  ipcMain.handle(IPC.WINDOW_LIST, async (): Promise<CaptureSource[]> => {
    return listWindows()
  })

  ipcMain.handle(IPC.OPEN_WINDOW_PICKER, async () => {
    showWindowPicker()
  })

  ipcMain.handle(IPC.CLOSE_WINDOW_PICKER, async () => {
    closeWindowPicker()
  })

  ipcMain.handle(IPC.SELECT_WINDOW, async (_e, source: CaptureSource) => {
    setSelectedWindowId(source.id)
    getMainWindow()?.webContents.send(IPC.WINDOW_SELECTED, source)
    closeWindowPicker()

    if (process.platform === 'win32') {
      const hwnd = BigInt(source.id)
      bringWindowToForeground(hwnd) // 가려진 채로 선택되면 테두리와 실제 화면이 어긋나 보임
      trackSelectionOverlay(hwnd) // 대상 창 이동/리사이즈를 따라 오버레이도 갱신
    } else {
      hideSelectionOverlay()
    }
  })

  ipcMain.handle(IPC.GET_MODE, async () => getOverlayMode())

  // 담당 A: 선택 확정 → SelectionContext 생성
  ipcMain.handle(IPC.SELECTION_RESOLVED, async (_e, point: { x: number; y: number }) => {
    const ctx: SelectionContext = await runSelectionPipeline(point)
    return ctx
  })

  // 담당 B: 검색 요청 (스트리밍은 SEARCH_STREAM 이벤트로 전송)
  ipcMain.handle(
    IPC.SEARCH_REQUEST,
    async (e, ctx: SelectionContext, req: SearchRequest) => {
      return runSearch(ctx, req, (chunk) => {
        e.sender.send(IPC.SEARCH_STREAM, chunk)
      })
    },
  )

  // TODO: SET_MODE, SETTINGS_*, APIKEY_* 핸들러 연결
}
