import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type { SearchRequest, SelectionContext } from '@shared/types'
import { runSelectionPipeline } from './pipelineA'
import { runSearch } from './pipelineB'

// IPC 허브 (공동) — A→B 연결점.
// 렌더러는 preload 를 통해서만 이 채널들에 접근한다.
export function registerIpc(): void {
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
