import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AppMode,
  AppSettings,
  CaptureSource,
  ExtractedSelection,
  Language,
  LlmProvider,
  QuestionRequest,
  QuestionResult,
  SelectionContext,
} from '@shared/types'

// preload — 렌더러에 안전한 API 만 노출 (공동)
const api = {
  listWindows: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.WINDOW_LIST),

  getSelectedWindowId: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.GET_SELECTED_WINDOW_ID),

  // 메인/피커/설정 전환 — navigate.ts: goto() 가 호출(창 크기만 요청, 화면 전환은 렌더러가 직접 처리).
  setWindowRoute: (route: 'main' | 'picker' | 'settings'): Promise<void> =>
    ipcRenderer.invoke(IPC.WINDOW_SET_ROUTE, route),

  // 메인 프로세스(트레이 등)가 화면 전환을 지시할 때 수신 — App.tsx 가 구독해 해시를 바꾼다.
  onNavigate: (cb: (route: 'main' | 'picker' | 'settings') => void): (() => void) => {
    const listener = (_e: unknown, route: 'main' | 'picker' | 'settings') => cb(route)
    ipcRenderer.on(IPC.NAVIGATE, listener)
    return () => ipcRenderer.removeListener(IPC.NAVIGATE, listener)
  },

  selectWindow: (source: CaptureSource): Promise<void> =>
    ipcRenderer.invoke(IPC.SELECT_WINDOW, source),

  onWindowSelected: (cb: (source: CaptureSource | null) => void): (() => void) => {
    const listener = (_e: unknown, source: CaptureSource | null) => cb(source)
    ipcRenderer.on(IPC.WINDOW_SELECTED, listener)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SELECTED, listener)
  },

  setOverlayInteractive: (interactive: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.OVERLAY_SET_INTERACTIVE, interactive),

  getMode: (): Promise<AppMode> => ipcRenderer.invoke(IPC.GET_MODE),

  onModeChanged: (cb: (mode: AppMode) => void): (() => void) => {
    const listener = (_e: unknown, mode: AppMode) => cb(mode)
    ipcRenderer.on(IPC.MODE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.MODE_CHANGED, listener)
  },

  extractSelection: (point: { x: number; y: number }): Promise<ExtractedSelection> =>
    ipcRenderer.invoke(IPC.SELECTION_EXTRACTED, point),

  question: (ctx: SelectionContext, req: QuestionRequest): Promise<QuestionResult> =>
    ipcRenderer.invoke(IPC.QUESTION_REQUEST, ctx, req),

  onQuestionStream: (cb: (chunk: QuestionResult) => void): (() => void) => {
    const listener = (_e: unknown, chunk: QuestionResult) => cb(chunk)
    ipcRenderer.on(IPC.QUESTION_STREAM, listener)
    return () => ipcRenderer.removeListener(IPC.QUESTION_STREAM, listener)
  },

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),

  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, patch),

  getApiKey: (provider: LlmProvider): Promise<string | null> =>
    ipcRenderer.invoke(IPC.APIKEY_GET, provider),

  setApiKey: (provider: LlmProvider, key: string): Promise<void> =>
    ipcRenderer.invoke(IPC.APIKEY_SET, provider, key),

  deleteApiKey: (provider: LlmProvider): Promise<void> =>
    ipcRenderer.invoke(IPC.APIKEY_DELETE, provider),

  // 팝업 (담당 B)
  openPopup: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_POPUP),

  getPopupContext: (): Promise<ExtractedSelection | null> =>
    ipcRenderer.invoke(IPC.POPUP_GET_CONTEXT),

  // 이미 열린 팝업에 컨텍스트가 갱신되면 통지받는다(창 재사용 시)
  onPopupContext: (cb: (ctx: ExtractedSelection | null) => void): (() => void) => {
    const listener = (_e: unknown, ctx: ExtractedSelection | null) => cb(ctx)
    ipcRenderer.on(IPC.POPUP_GET_CONTEXT, listener)
    return () => ipcRenderer.removeListener(IPC.POPUP_GET_CONTEXT, listener)
  },

  openGoogle: (mode: 'pron' | 'image', text: string, lang: Language): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_GOOGLE, { mode, text, lang }),
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
