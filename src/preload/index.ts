import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AppMode,
  CaptureSource,
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
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
