import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type { QuestionRequest, SelectionContext } from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'

// IPC 허브 (공동) — A→B 연결점.
// 렌더러는 preload 를 통해서만 이 채널들에 접근한다.
export function registerIpc(): void {
  // 담당 A: 선택 확정 → SelectionContext 생성
  ipcMain.handle(IPC.SELECTION_RESOLVED, async (_e, point: { x: number; y: number }) => {
    const ctx: SelectionContext = await runSelectionPipeline(point)
    return ctx
  })

  // 담당 B: 질문 요청 (스트리밍은 QUESTION_STREAM 이벤트로 전송)
  ipcMain.handle(
    IPC.QUESTION_REQUEST,
    async (e, ctx: SelectionContext, req: QuestionRequest) => {
      return runQuestion(ctx, req, (chunk) => {
        e.sender.send(IPC.QUESTION_STREAM, chunk)
      })
    },
  )

  // TODO: SET_MODE, SETTINGS_*, APIKEY_* 핸들러 연결
}
