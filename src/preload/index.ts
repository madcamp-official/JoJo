import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AppMode,
  CaptureSource,
  Language,
  QuestionRequest,
  QuestionResult,
  SelectionContext,
} from '@shared/types'

// preload — 렌더러에 안전한 API 만 노출 (공동)
const api = {
  listWindows: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.WINDOW_LIST),

  openWindowPicker: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_WINDOW_PICKER),

  closeWindowPicker: (): Promise<void> => ipcRenderer.invoke(IPC.CLOSE_WINDOW_PICKER),

  selectWindow: (source: CaptureSource): Promise<void> =>
    ipcRenderer.invoke(IPC.SELECT_WINDOW, source),

  onWindowSelected: (cb: (source: CaptureSource | null) => void): (() => void) => {
    const listener = (_e: unknown, source: CaptureSource | null) => cb(source)
    ipcRenderer.on(IPC.WINDOW_SELECTED, listener)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SELECTED, listener)
  },

  openSettings: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_SETTINGS),

  setOverlayInteractive: (interactive: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.OVERLAY_SET_INTERACTIVE, interactive),

  getMode: (): Promise<AppMode> => ipcRenderer.invoke(IPC.GET_MODE),

  onModeChanged: (cb: (mode: AppMode) => void): (() => void) => {
    const listener = (_e: unknown, mode: AppMode) => cb(mode)
    ipcRenderer.on(IPC.MODE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.MODE_CHANGED, listener)
  },

  resolveSelection: (point: { x: number; y: number }): Promise<SelectionContext> =>
    ipcRenderer.invoke(IPC.SELECTION_RESOLVED, point),

  question: (ctx: SelectionContext, req: QuestionRequest): Promise<QuestionResult> =>
    ipcRenderer.invoke(IPC.QUESTION_REQUEST, ctx, req),

  onQuestionStream: (cb: (chunk: QuestionResult) => void): (() => void) => {
    const listener = (_e: unknown, chunk: QuestionResult) => cb(chunk)
    ipcRenderer.on(IPC.QUESTION_STREAM, listener)
    return () => ipcRenderer.removeListener(IPC.QUESTION_STREAM, listener)
  },

  // 팝업 (담당 B)
  openPopup: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_POPUP),

  getPopupContext: (): Promise<SelectionContext | null> =>
    ipcRenderer.invoke(IPC.POPUP_GET_CONTEXT),

  // 이미 열린 팝업에 컨텍스트가 갱신되면 통지받는다(창 재사용 시)
  onPopupContext: (cb: (ctx: SelectionContext | null) => void): (() => void) => {
    const listener = (_e: unknown, ctx: SelectionContext | null) => cb(ctx)
    ipcRenderer.on(IPC.POPUP_GET_CONTEXT, listener)
    return () => ipcRenderer.removeListener(IPC.POPUP_GET_CONTEXT, listener)
  },

  openGoogle: (mode: 'pron' | 'image', text: string, lang: Language): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_GOOGLE, { mode, text, lang }),
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
