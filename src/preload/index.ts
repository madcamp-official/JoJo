import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  ApiKeyId,
  AppMode,
  AppSettings,
  CaptureSource,
  ExtractedSelection,
  JaToken,
  Language,
  LlmProvider,
  ProviderValidation,
  QuestionRequest,
  QuestionResult,
  Rect,
  SelectionContext,
  Word,
  ZhWord,
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

  // 선택 모드 진입 시 미리 캐시된 단어 bbox 목록 수신(extractionCache.ts) — 오버레이가
  // hover/클릭 판정에 실제 텍스트 위치를 쓸 수 있게 한다.
  onExtractionWords: (cb: (words: Word[]) => void): (() => void) => {
    const listener = (_e: unknown, words: Word[]) => cb(words)
    ipcRenderer.on(IPC.EXTRACTION_WORDS, listener)
    return () => ipcRenderer.removeListener(IPC.EXTRACTION_WORDS, listener)
  },

  // 화면 변화 감지로 백그라운드 재추출이 시작될 때 수신(changeWatcher.ts) — 끝나면
  // onExtractionWords 가 다시 와서 "추출 중" 표시를 끈다.
  onExtractionStarted: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.EXTRACTION_STARTED, listener)
    return () => ipcRenderer.removeListener(IPC.EXTRACTION_STARTED, listener)
  },

  // OCR 대상 영역 지정 — 메인이 오버레이에 드래그 선택을 요청(영역 없거나 "영역 재선택")
  onRegionSelectionNeeded: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.REGION_SELECTION_NEEDED, listener)
    return () => ipcRenderer.removeListener(IPC.REGION_SELECTION_NEEDED, listener)
  },

  // 오버레이가 드래그로 그린 영역(오버레이 로컬 DIP 좌표)을 메인에 전달
  submitRegion: (rect: Rect): Promise<void> => ipcRenderer.invoke(IPC.SUBMIT_REGION, rect),

  // 오버레이 상단에 잠깐 뜨는 안내 배너(예: 리사이즈로 영역 무효화 안내)
  onOverlayNotice: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on(IPC.OVERLAY_NOTICE, listener)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_NOTICE, listener)
  },

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

  getFrequent: (): Promise<string[]> => ipcRenderer.invoke(IPC.FREQUENT_GET),

  setFrequent: (list: string[]): Promise<string[]> => ipcRenderer.invoke(IPC.FREQUENT_SET, list),

  getApiKey: (id: ApiKeyId): Promise<string | null> => ipcRenderer.invoke(IPC.APIKEY_GET, id),

  setApiKey: (id: ApiKeyId, key: string): Promise<void> =>
    ipcRenderer.invoke(IPC.APIKEY_SET, id, key),

  deleteApiKey: (id: ApiKeyId): Promise<void> => ipcRenderer.invoke(IPC.APIKEY_DELETE, id),

  validateProvider: (provider: LlmProvider, apiKey: string): Promise<ProviderValidation> =>
    ipcRenderer.invoke(IPC.PROVIDER_VALIDATE, provider, apiKey),

  // 팝업 (담당 B)
  openPopup: (demo?: string): Promise<void> => ipcRenderer.invoke(IPC.OPEN_POPUP, demo),

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

  openNaverDict: (text: string, lang: Language): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_NAVER_DICT, { text, lang }),

  // 팝업 원문 문맥의 가나 atom 병합용 kuromoji 형태소 분석 요청
  tokenizeJapanese: (text: string): Promise<JaToken[]> =>
    ipcRenderer.invoke(IPC.TOKENIZE_JA, text),

  // 팝업 원문 문맥의 중국어 단어 atom 구성용 segmentit 형태소 분석 요청
  tokenizeChinese: (text: string): Promise<ZhWord[]> =>
    ipcRenderer.invoke(IPC.TOKENIZE_ZH, text),
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
