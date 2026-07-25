import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/channels'
import type { CaptureSource, Language, QuestionRequest, SelectionContext } from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'
import { listWindows, setSelectedWindowId } from './selection/capture'
import {
  closeWindowPicker,
  createPopupWindow,
  getMainWindow,
  getPopupContext,
  showWindowPicker,
} from './windows'
import { googleImageUrl, googlePronunciationUrl } from './question/google'

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

  // 담당 B: 팝업 열기 (데모용 — ctx 없이 열면 렌더러가 목업으로 fallback)
  // 담당 A 통합 시엔 선택 파이프라인이 createPopupWindow(ctx) 를 직접 호출한다.
  ipcMain.handle(IPC.OPEN_POPUP, async () => {
    createPopupWindow(null)
  })

  // 담당 B: 팝업 렌더러가 마운트 시 현재 SelectionContext 를 조회
  ipcMain.handle(IPC.POPUP_GET_CONTEXT, async (): Promise<SelectionContext | null> => {
    return getPopupContext()
  })

  // 담당 B: 구글 발음/이미지 탭을 외부 브라우저로 연다
  // TODO(담당 B): PLAN §4.2 "팝업 속 팝업" — 임베드형 구글 탭(BrowserWindow child)으로 고도화
  ipcMain.handle(
    IPC.OPEN_GOOGLE,
    async (_e, payload: { mode: 'pron' | 'image'; text: string; lang: Language }) => {
      const url =
        payload.mode === 'pron'
          ? googlePronunciationUrl(payload.text, payload.lang)
          : googleImageUrl(payload.text)
      await shell.openExternal(url)
    },
  )

  // TODO: SET_MODE, SETTINGS_*, APIKEY_* 핸들러 연결
}
