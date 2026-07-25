import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type { AppSettings, CaptureSource, LlmProvider, QuestionRequest, SelectionContext } from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'
import { listWindows, setSelectedWindowId } from './selection/capture'
import { closeWindowPicker, getMainWindow, showWindowPicker } from './windows'
import { updateModeShortcut } from './selection/shortcut'
import { getSettings, setSettings } from './settingsStore'
import { deleteApiKey, getApiKey, setApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'

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
  })

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

  // 담당 B: 설정 조회/변경
  ipcMain.handle(IPC.SETTINGS_GET, async (): Promise<AppSettings> => {
    return getSettings()
  })

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = setSettings(patch)
    if (patch.llm) setActiveProvider(patch.llm)
    if (patch.modeShortcut) updateModeShortcut(patch.modeShortcut)
    return next
  })

  // 담당 B: API 키 조회/저장/삭제 (safeStorage 암호화, keyStore.ts)
  ipcMain.handle(IPC.APIKEY_GET, async (_e, provider: LlmProvider): Promise<string | null> => {
    return getApiKey(provider)
  })

  ipcMain.handle(IPC.APIKEY_SET, async (_e, provider: LlmProvider, key: string): Promise<void> => {
    setApiKey(provider, key)
  })

  ipcMain.handle(IPC.APIKEY_DELETE, async (_e, provider: LlmProvider): Promise<void> => {
    deleteApiKey(provider)
  })

  // TODO: SET_MODE 핸들러 연결
}
