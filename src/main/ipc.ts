import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type {
  ApiKeyId,
  AppSettings,
  CaptureSource,
  DictionarySourceOption,
  ExtractedSelection,
  Language,
  LlmProvider,
  ProviderValidation,
  QuestionRequest,
  Rect,
  SelectionContext,
} from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'
import { listAvailableDictionarySources } from './question/dictionary/registry'
import { startChangeWatcher } from './selection/changeWatcher'
import {
  getSelectedWindowId,
  listWindows,
  setSelectedWindowId,
  setSelectedWindowName,
} from './selection/capture'
import { invalidateExtractionCache, refreshExtractionCache } from './selection/extractionCache'
import { clearRegion, submitRegionFromOverlay } from './selection/regionSelection'
import { isWarmedUp } from './selection/warmup'
import {
  createPopupWindow,
  getMainWindow,
  getOverlayMode,
  getPopupContext,
  getPopupBounds,
  openSettingsWindow,
  showMacSelectionOverlay,
  setMainWindowRoute,
  setOverlayInteractive,
  signalPopupContentReady,
  trackSelectionOverlay,
  type MainRoute,
} from './windows'
import {
  clearRegionEscapeShortcut,
  resetToNormalMode,
  updateModeShortcut,
  updateNamedShortcut,
} from './selection/shortcut'
import { getSettings, setSettings } from './settingsStore'
import { getFrequent, setFrequent } from './frequentStore'
import { deleteApiKey, getApiKey, setApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { validateProvider, testModel } from './question/llm/validate'
import { googleImageUrl, googlePronunciationUrl } from './question/google'
import { naverDictionaryUrl } from './question/naver'
import { openUrlInNewWindow } from './question/browser'
import { JA_ENGINE, tokenizeJapanese } from './nlp/japanese'
import { segmentChineseWords } from './nlp/chinese'

// IPC 허브 (공동) — A→B 연결점.
// 렌더러는 preload 를 통해서만 이 채널들에 접근한다.
export function registerIpc(): void {
  // 담당 A: 창 목록 조회
  ipcMain.handle(IPC.WINDOW_LIST, async (): Promise<CaptureSource[]> => {
    return listWindows()
  })

  // 담당 A: 현재 선택된 창 id 조회 (재선택 시 목록에서 표시용)
  ipcMain.handle(IPC.GET_SELECTED_WINDOW_ID, async (): Promise<string | null> => {
    return getSelectedWindowId()
  })

  // 메인/피커/설정 전환 — 렌더러가 이미 해시를 바꿨으므로 창 크기만 맞춘다(navigate.ts: goto()).
  ipcMain.handle(IPC.WINDOW_SET_ROUTE, async (_e, route: MainRoute): Promise<void> => {
    setMainWindowRoute(route)
  })

  ipcMain.handle(IPC.SELECT_WINDOW, async (_e, source: CaptureSource) => {
    setSelectedWindowId(source.id)
    setSelectedWindowName(source.name)
    invalidateExtractionCache() // 이전 창(재선택 포함)의 캐시가 새 창으로 넘어가지 않게
    clearRegion() // 이전 창 기준 좌표라 새 창에 그대로 쓰면 안 맞음
    resetToNormalMode() // 재선택 시 선택 모드였다면 일반 모드로 — 새 창엔 아직 캐시된 단어가 없음
    getMainWindow()?.webContents.send(IPC.WINDOW_SELECTED, source)

    // 대상 창을 맨 앞으로 올리고(가려진 채 선택되면 테두리와 실제 화면이 어긋나 보임)
    // 선택 오버레이 테두리를 정렬한다. 메인 창을 숨기기 전에 먼저 처리한다.
    if (process.platform === 'win32') {
      const hwnd = BigInt(source.id)
      // win32Capture 는 koffi 로 DLL 을 로드하므로 Windows 경로에서만 동적 import.
      const { bringWindowToForeground } = await import('./selection/win32Capture')
      bringWindowToForeground(hwnd)
      await trackSelectionOverlay(hwnd) // 대상 창 이동/리사이즈를 따라 오버레이도 갱신
    } else {
      // macOS: desktopCapturer 소스 id("window:12345:0")의 CGWindowID 로 대상 창을 앞으로
      // 올리고 그 위치에 테두리 오버레이를 띄운다(CoreGraphics, selection/macWindow.ts).
      const windowId = Number(/^window:(\d+)/.exec(source.id)?.[1])
      if (Number.isFinite(windowId)) await showMacSelectionOverlay(windowId)
    }

    // PLAN.md §3: 창 선택 → 백그라운드 실행. 메인 창은 X 가 아니라 여기서 숨기고,
    // 트레이 메뉴(선택 해제/재선택/설정/종료)로만 다시 꺼낸다(windows.ts, tray.ts).
    getMainWindow()?.hide()
  })

  // 실험용 브랜치(experiment/doclayout-yolo) — DocLayout/PaddleOCR 예열
  // 완료 여부. MainScreen 이 마운트 시 조회하고(예열 도중 창을 새로고침/재오픈해도
  // 상태를 다시 알 수 있게), 이후 변화는 WARMUP_READY push(main/index.ts)로 받는다.
  ipcMain.handle(IPC.WARMUP_GET, async (): Promise<boolean> => {
    return isWarmedUp()
  })

  ipcMain.handle(IPC.GET_MODE, async () => getOverlayMode())

  ipcMain.handle(IPC.OVERLAY_SET_INTERACTIVE, async (_e, interactive: boolean) => {
    setOverlayInteractive(interactive)
  })

  // 담당 A: 팝업 직전 추출 결과(ExtractedSelection) 생성 → 팝업(담당 B) 오픈 + 전달
  // (자막 경로는 이 핸들러를 타지 않는다 — 확장이 페이지 안에서 직접 클릭을 처리해
  // subtitleSource.ts 가 자체적으로 팝업을 연다)
  ipcMain.handle(IPC.SELECTION_EXTRACTED, async (_e, point: { x: number; y: number }) => {
    const extracted: ExtractedSelection = await runSelectionPipeline(point)
    // 빈 곳 클릭(자막 단어를 못 짚음)이면 빈 팝업을 띄우지 않는다.
    if (extracted.text.trim()) createPopupWindow(extracted)
    return extracted
  })

  // 담당 A: 오버레이에서 드래그로 그린 OCR 대상 영역을 저장하고, 바로 그 영역으로 추출 시작
  ipcMain.handle(IPC.SUBMIT_REGION, async (_e, rect: Rect) => {
    await submitRegionFromOverlay(rect)
    refreshExtractionCache()
    startChangeWatcher() // 영역이 확정됐으니 이 영역 안 내용 변화 감지를 시작(changeWatcher.ts)
    clearRegionEscapeShortcut() // 드래그로 영역을 확정했으니 Esc 임시 단축키(shortcut.ts)도 해제
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

  // 사전 어댑터 병렬 구현 디버깅용 임시 채널 — 이 언어에 실제로 구현된(파일이 존재하는)
  // 소스 목록을 폴백 순위대로 내려준다(registry.ts).
  ipcMain.handle(
    IPC.DICTIONARY_SOURCES_GET,
    async (_e, language: Language): Promise<DictionarySourceOption[]> => {
      return listAvailableDictionarySources(language)
    },
  )

  // 담당 B: 설정 조회/변경
  ipcMain.handle(IPC.SETTINGS_GET, async (): Promise<AppSettings> => {
    return getSettings()
  })

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = setSettings(patch)
    if (patch.llm) setActiveProvider(patch.llm)
    if (patch.modeShortcut !== undefined) updateModeShortcut(patch.modeShortcut)
    if (patch.windowSelectShortcut !== undefined) updateNamedShortcut('windowSelect', patch.windowSelectShortcut)
    if (patch.windowDeselectShortcut !== undefined)
      updateNamedShortcut('windowDeselect', patch.windowDeselectShortcut)
    if (patch.manualRegionShortcut !== undefined) updateNamedShortcut('manualRegion', patch.manualRegionShortcut)
    // settingsShortcut 은 더 이상 메인 프로세스에 등록할 게 없다 — 각 렌더러가 로컬
    // keydown 으로 직접 판정하며, 매 keydown 마다 window.nuance.getSettings() 로 최신
    // 값을 그때그때 조회하므로(App.tsx) 저장만 해두면 된다.
    return next
  })

  // 담당 B: 자주 쓰는 질문 조회/저장 (userData/frequent.json, frequentStore.ts)
  ipcMain.handle(IPC.FREQUENT_GET, async (): Promise<string[]> => {
    return getFrequent()
  })

  ipcMain.handle(IPC.FREQUENT_SET, async (_e, list: string[]): Promise<string[]> => {
    return setFrequent(list)
  })

  // 담당 B: API 키 조회/저장/삭제 (safeStorage 암호화, keyStore.ts) — LLM 3종 + MW 사전 키
  ipcMain.handle(IPC.APIKEY_GET, async (_e, id: ApiKeyId): Promise<string | null> => {
    return getApiKey(id)
  })

  ipcMain.handle(IPC.APIKEY_SET, async (_e, id: ApiKeyId, key: string): Promise<void> => {
    setApiKey(id, key)
  })

  ipcMain.handle(IPC.APIKEY_DELETE, async (_e, id: ApiKeyId): Promise<void> => {
    deleteApiKey(id)
  })

  // 담당 B: provider 키 검증 + 사용 가능 모델 조회 (무과금 GET, validate.ts)
  ipcMain.handle(
    IPC.PROVIDER_VALIDATE,
    async (_e, provider: LlmProvider, apiKey: string): Promise<ProviderValidation> => {
      return validateProvider(provider, apiKey)
    },
  )

  // 담당 B: 모델 드롭다운에서 특정 모델을 고를 때 실제 호출 1회로 동작 여부 검증(validate.ts)
  ipcMain.handle(
    IPC.PROVIDER_TEST_MODEL,
    async (_e, provider: LlmProvider, apiKey: string, model: string) => {
      return testModel(provider, apiKey, model)
    },
  )

  // 담당 B: 팝업 열기 (데모용 — ctx 없이 열면 렌더러가 목업으로 fallback)
  // 담당 A 통합 시엔 선택 파이프라인이 createPopupWindow(ctx) 를 직접 호출한다.
  ipcMain.handle(IPC.OPEN_POPUP, async (_e, demo?: string) => {
    createPopupWindow(null, demo)
  })

  // "설정 화면 열기" 단축키 — 각 렌더러(App.tsx)가 로컬 keydown으로 직접 판정한 뒤
  // 여기엔 그냥 열어달라고만 요청한다(2026-07-29, shortcut.ts 주석 참고 — globalShortcut
  // 이 Cmd+, 같은 흔한 조합을 OS 레벨에서 통째로 가로채 다른 앱에서 같은 단축키가
  // 먹통이 되는 문제가 있어 전역 후킹을 걷어냈다).
  ipcMain.handle(IPC.OPEN_SETTINGS, async () => {
    openSettingsWindow()
  })

  // 담당 B: 팝업 렌더러가 마운트 시 현재 ExtractedSelection 을 조회
  ipcMain.handle(IPC.POPUP_GET_CONTEXT, async (): Promise<ExtractedSelection | null> => {
    const ctx = getPopupContext()
    // 임시 진단 로그(2026-07-29, "가끔 빈 팝업이 뜬다" 제보 확인용).
    console.log(`[ipc] POPUP_GET_CONTEXT -> ${ctx ? `len=${ctx.text.length} source=${ctx.source.kind}` : 'null'}`)
    return ctx
  })

  // 팝업이 실제 내용을 그리고 첫 페인트까지 끝냈을 때 통지 — 그때까지 숨겨뒀던 창을 보여준다.
  ipcMain.on(IPC.POPUP_CONTENT_READY, () => {
    signalPopupContentReady()
  })

  // 담당 B: 구글 발음/이미지 검색 — 기본 브라우저의 새 창으로(팝업과 같은 위치·크기) 연다(google.ts)
  ipcMain.handle(
    IPC.OPEN_GOOGLE,
    async (_e, payload: { mode: 'pron' | 'image'; text: string; lang: Language }) => {
      const url =
        payload.mode === 'pron'
          ? googlePronunciationUrl(payload.text, payload.lang)
          : googleImageUrl(payload.text)
      await openUrlInNewWindow(url, getPopupBounds() ?? undefined)
    },
  )

  // 담당 B: 네이버 사전 — 언어별 서브도메인 사전을 기본 브라우저의 새 창으로 연다(naver.ts)
  ipcMain.handle(
    IPC.OPEN_NAVER_DICT,
    async (_e, payload: { text: string; lang: Language }) => {
      const url = naverDictionaryUrl(payload.text, payload.lang)
      await openUrlInNewWindow(url, getPopupBounds() ?? undefined)
    },
  )

  // 담당 B: 채팅창 마크다운 링크(사전 출처 등, senseSelect.ts formatDictionaryAnswer가
  // 만든 완성된 URL) — 구글/네이버와 똑같이 기본 브라우저 새 창으로 연다. 렌더러가 이미
  // 완성된 URL을 그대로 넘기므로(위 둘처럼 여기서 URL을 조립하지 않음) payload는 문자열 하나.
  ipcMain.handle(IPC.OPEN_EXTERNAL_LINK, async (_e, url: string) => {
    await openUrlInNewWindow(url, getPopupBounds() ?? undefined)
  })

  // 담당 B: 팝업 원문 문맥의 가나 조각 병합용 일본어 형태소 분석 (nlp/japanese.ts).
  // 렌더러가 병합 함수를 고를 수 있도록 engine 태그를 같이 내려준다.
  ipcMain.handle(IPC.TOKENIZE_JA, async (_e, text: string) => {
    return { engine: JA_ENGINE, tokens: await tokenizeJapanese(text) }
  })

  // 담당 B: 팝업 원문 문맥의 중국어 단어 atom 구성용 형태소 분석 (nlp/chinese.ts —
  // zh-Hans 는 jieba 고정, zh-Hant 는 ZH_HANT_ENGINE 스위치)
  ipcMain.handle(IPC.TOKENIZE_ZH, async (_e, text: string, language: 'zh-Hans' | 'zh-Hant') => {
    return segmentChineseWords(text, language)
  })
}
