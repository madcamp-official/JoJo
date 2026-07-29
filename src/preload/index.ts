import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  ApiKeyId,
  AppMode,
  AppSettings,
  CaptureSource,
  DictionarySourceOption,
  ExtractedSelection,
  JaTokenizeResult,
  Language,
  LlmProvider,
  ProviderValidation,
  QuestionErrorCode,
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

  // 실험용 브랜치(experiment/doclayout-yolo) — DocLayout/PaddleOCR 예열
  // 완료 여부(MainScreen 이 창 선택 버튼을 막을지 판단).
  getWarmupStatus: (): Promise<boolean> => ipcRenderer.invoke(IPC.WARMUP_GET),

  onWarmupReady: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.WARMUP_READY, listener)
    return () => ipcRenderer.removeListener(IPC.WARMUP_READY, listener)
  },

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

  // 언어 감지가 끝나고 실제 OCR 이 시작될 때 수신(extractionCache.ts) — 추출 중 배너를
  // "언어 감지 & 텍스트 영역 탐지" 단계에서 "텍스트 추출" 단계로 넘긴다.
  onExtractionOcrStarted: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.EXTRACTION_OCR_STARTED, listener)
    return () => ipcRenderer.removeListener(IPC.EXTRACTION_OCR_STARTED, listener)
  },

  // OCR이 실제로 인식에 넘긴 블록/열 경계 수신 — 텍스트 영역 자동 탐지 결과 시각화
  // (autoDetectRegion 설정 ON + 자동 탐지로 잡힌 영역일 때만 메인이 보낸다).
  onDebugBlocks: (cb: (blocks: Rect[]) => void): (() => void) => {
    const listener = (_e: unknown, blocks: Rect[]) => cb(blocks)
    ipcRenderer.on(IPC.DEBUG_BLOCKS, listener)
    return () => ipcRenderer.removeListener(IPC.DEBUG_BLOCKS, listener)
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

  // 사전 어댑터 병렬 구현 디버깅용 임시 API(2026-07-28) — 이 언어에 실제로 구현된 소스
  // 목록(registry.ts)을 조회한다.
  getDictionarySources: (language: Language): Promise<DictionarySourceOption[]> =>
    ipcRenderer.invoke(IPC.DICTIONARY_SOURCES_GET, language),

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

  testModel: (provider: LlmProvider, apiKey: string, model: string): Promise<QuestionErrorCode | null> =>
    ipcRenderer.invoke(IPC.PROVIDER_TEST_MODEL, provider, apiKey, model),

  // "설정 화면 열기" 단축키(2026-07-29부터 렌더러 로컬 keydown 매칭 — App.tsx
  // shortcutMatch.ts) — 매칭되면 메인 프로세스에 그냥 창을 열어달라고만 요청한다.
  openSettingsWindow: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_SETTINGS),

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

  // 팝업이 실제 내용을 그리고 첫 페인트까지 끝냈을 때 1회 호출 — 빈 창이 잠깐 보였다
  // 내용으로 채워지는 깜빡임을 없애려고, 메인이 이 신호를 받을 때까지 창을 숨겨둔다.
  notifyPopupContentReady: (): void => ipcRenderer.send(IPC.POPUP_CONTENT_READY),

  openGoogle: (mode: 'pron' | 'image', text: string, lang: Language): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_GOOGLE, { mode, text, lang }),

  openNaverDict: (text: string, lang: Language): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_NAVER_DICT, { text, lang }),

  // 채팅창 마크다운 링크(사전 출처 등) 클릭 시 구글/네이버와 동일한 방식으로 열기
  openExternalLink: (url: string): Promise<void> => ipcRenderer.invoke(IPC.OPEN_EXTERNAL_LINK, url),

  // 팝업 원문 문맥의 가나 atom 병합용 일본어 형태소 분석 요청(엔진은 JA_ENGINE 설정값)
  tokenizeJapanese: (text: string): Promise<JaTokenizeResult> =>
    ipcRenderer.invoke(IPC.TOKENIZE_JA, text),

  // 팝업 원문 문맥의 중국어 단어 atom 구성용 형태소 분석 요청(zh-Hans/zh-Hant 별 엔진은
  // main/nlp/chinese.ts 가 결정)
  tokenizeChinese: (text: string, language: 'zh-Hans' | 'zh-Hant'): Promise<ZhWord[]> =>
    ipcRenderer.invoke(IPC.TOKENIZE_ZH, text, language),
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
