import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AnyLanguage,
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
  ViewerFilePayload,
  ViewerWordHit,
  Word,
  ZhWord,
} from '@shared/types'
import type { WordSegment } from '@shared/extension'

// preload — 렌더러에 안전한 API 만 노출 (공동)
const api = {
  listWindows: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.WINDOW_LIST),

  getSelectedWindowId: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.GET_SELECTED_WINDOW_ID),

  // 메인/피커/설정/사용 설명서 전환 — navigate.ts: goto() 가 호출(창 크기만 요청, 화면
  // 전환은 렌더러가 직접 처리).
  setWindowRoute: (route: 'main' | 'picker' | 'settings' | 'manual'): Promise<void> =>
    ipcRenderer.invoke(IPC.WINDOW_SET_ROUTE, route),

  // 창 선택 화면에서 Esc — 이미 선택된 창이 있으면 메인 화면 대신 그냥 창을 숨긴다
  hideMainWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_HIDE),

  // 메인 프로세스(트레이 등)가 화면 전환을 지시할 때 수신 — App.tsx 가 구독해 해시를 바꾼다.
  onNavigate: (cb: (route: 'main' | 'picker' | 'settings' | 'manual') => void): (() => void) => {
    const listener = (_e: unknown, route: 'main' | 'picker' | 'settings' | 'manual') => cb(route)
    ipcRenderer.on(IPC.NAVIGATE, listener)
    return () => ipcRenderer.removeListener(IPC.NAVIGATE, listener)
  },

  // 해당 라우트로 실제 전환·렌더가 끝났다고 메인에 알림(windows.ts: showMainWindowAtRoute
  // 가 숨겨진 창을 이 응답을 받은 뒤에야 show() — 전환 중 이전 화면이 잠깐 보이는
  // 깜빡임 방지).
  notifyNavigateReady: (route: 'main' | 'picker' | 'settings' | 'manual'): void =>
    ipcRenderer.send(IPC.NAVIGATE_READY, route),

  selectWindow: (source: CaptureSource): Promise<void> =>
    ipcRenderer.invoke(IPC.SELECT_WINDOW, source),

  onWindowSelected: (cb: (source: CaptureSource | null) => void): (() => void) => {
    const listener = (_e: unknown, source: CaptureSource | null) => cb(source)
    ipcRenderer.on(IPC.WINDOW_SELECTED, listener)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SELECTED, listener)
  },

  // cursor: mac 전용 커서 모양(비활성 앱 창은 CSS cursor 가 안 먹혀 메인이 NSCursor 를
  // 직접 설정한다 — macWindow.ts setMacCursor) — win32에선 무시되고 CSS 가 담당.
  setOverlayInteractive: (interactive: boolean, cursor: 'pointer' | 'crosshair' | null = null): Promise<void> =>
    ipcRenderer.invoke(IPC.OVERLAY_SET_INTERACTIVE, interactive, cursor),

  // macOS 전용 — 클릭스루 오버레이로는 mousemove 가 안 와서(shared/channels.ts
  // OVERLAY_CURSOR 주석), 메인이 폴링한 커서 위치(오버레이-로컬 좌표)를 수신한다.
  onOverlayCursor: (cb: (point: { x: number; y: number }) => void): (() => void) => {
    const listener = (_e: unknown, point: { x: number; y: number }) => cb(point)
    ipcRenderer.on(IPC.OVERLAY_CURSOR, listener)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_CURSOR, listener)
  },

  // macOS 전용 — 오버레이가 클릭을 받으려고 비-클릭스루 상태가 되는 동안 스크롤 휠까지
  // 막혀버리는 문제 우회(shared/channels.ts OVERLAY_FORWARD_SCROLL 주석). 응답이 필요
  // 없어 invoke 대신 send(fire-and-forget).
  forwardScroll: (deltaX: number, deltaY: number): void =>
    ipcRenderer.send(IPC.OVERLAY_FORWARD_SCROLL, { deltaX, deltaY }),

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

  // 추출 파이프라인의 현재 단계 문구 수신(extractionCache.ts: runExtraction()) — 오버레이
  // 배너에 그대로 표시한다. 끝나면 onExtractionWords 가 다시 와서 배너를 끈다.
  onExtractionPhase: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on(IPC.EXTRACTION_PHASE, listener)
    return () => ipcRenderer.removeListener(IPC.EXTRACTION_PHASE, listener)
  },

  // OCR이 실제로 텍스트를 찾아낸 영역(열/블록 단위) 수신 — 매 추출마다 노란 점선
  // 사각형으로 잠깐(3초) 보여준다(2026-07-31 재설계, 설정/개발 모드와 무관하게 항상 옴).
  onDetectedBlocks: (cb: (blocks: Rect[]) => void): (() => void) => {
    const listener = (_e: unknown, blocks: Rect[]) => cb(blocks)
    ipcRenderer.on(IPC.DETECTED_BLOCKS, listener)
    return () => ipcRenderer.removeListener(IPC.DETECTED_BLOCKS, listener)
  },

  // 영역 수동 선택으로 지정된 OCR 대상 영역 수신 — 선택 모드 내내 그 영역 밖을 반투명
  // 회색으로 덮어 보여준다(자동 탐지 영역이거나 없으면 null).
  onRegionInfo: (cb: (rect: Rect | null) => void): (() => void) => {
    const listener = (_e: unknown, rect: Rect | null) => cb(rect)
    ipcRenderer.on(IPC.REGION_INFO, listener)
    return () => ipcRenderer.removeListener(IPC.REGION_INFO, listener)
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

  getDefaultSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET_DEFAULTS),

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

  openGoogle: (mode: 'pron' | 'image', text: string, lang: AnyLanguage): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_GOOGLE, { mode, text, lang }),

  openNaverDict: (text: string, lang: AnyLanguage): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_NAVER_DICT, { text, lang }),

  // 채팅창 마크다운 링크(사전 출처 등) 클릭 시 구글/네이버와 동일한 방식으로 열기
  openExternalLink: (url: string): Promise<void> => ipcRenderer.invoke(IPC.OPEN_EXTERNAL_LINK, url),

  // 선택 표현 자동 복사 — navigator.clipboard 와 달리 문서 포커스가 필요 없다(채널 주석 참고).
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke(IPC.CLIPBOARD_COPY, text),

  // 팝업 원문 문맥의 가나 atom 병합용 일본어 형태소 분석 요청(엔진은 JA_ENGINE 설정값)
  tokenizeJapanese: (text: string): Promise<JaTokenizeResult> =>
    ipcRenderer.invoke(IPC.TOKENIZE_JA, text),

  // 팝업 원문 문맥의 중국어 단어 atom 구성용 형태소 분석 요청(zh-Hans/zh-Hant 별 엔진은
  // main/nlp/chinese.ts 가 결정)
  tokenizeChinese: (text: string, language: 'zh-Hans' | 'zh-Hant'): Promise<ZhWord[]> =>
    ipcRenderer.invoke(IPC.TOKENIZE_ZH, text, language),

  // 자체 문서 뷰어(pdf/epub/txt) — 파일 선택 다이얼로그를 띄우고 고른 파일로 뷰어 창을 연다.
  // 취소하면 false.
  openDocumentFile: (): Promise<boolean> => ipcRenderer.invoke(IPC.VIEWER_OPEN_FILE_DIALOG),

  // 뷰어 렌더러가 자기 창에 열린 파일 내용을 가져온다(txt 는 text, pdf/epub 는 bytes).
  getViewerFile: (): Promise<ViewerFilePayload | null> => ipcRenderer.invoke(IPC.VIEWER_GET_FILE),

  // 뷰어 문단의 CJK 형태소 분할 — 확장이 WebSocket 으로 하던 것과 같은 분할기(segmentCjk.ts).
  segmentViewerText: (text: string): Promise<WordSegment[]> =>
    ipcRenderer.invoke(IPC.VIEWER_SEGMENT, text),

  // 뷰어 뒤로가기 — 뷰어 창을 닫고 메인 창으로 돌아간다.
  viewerBack: (): Promise<void> => ipcRenderer.invoke(IPC.VIEWER_BACK),

  // 뷰어에서 단어 클릭 — 확장의 pageClick 과 같은 역할(메인이 팝업을 띄운다).
  viewerWordClicked: (hit: ViewerWordHit): Promise<void> =>
    ipcRenderer.invoke(IPC.VIEWER_WORD_CLICKED, hit),

  // 보기 설정이 바뀌었다고 알림 — 메인이 다른 뷰어 창들에 그대로 전달한다.
  viewerPrefsChanged: (prefs: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC.VIEWER_PREFS_CHANGED, prefs),

  // 다른 뷰어 창이 바꾼 보기 설정 수신.
  onViewerPrefsSync: (cb: (prefs: unknown) => void): (() => void) => {
    const listener = (_e: unknown, prefs: unknown) => cb(prefs)
    ipcRenderer.on(IPC.VIEWER_PREFS_SYNC, listener)
    return () => ipcRenderer.removeListener(IPC.VIEWER_PREFS_SYNC, listener)
  },
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
