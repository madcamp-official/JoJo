import { ipcMain } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AppSettings,
  CaptureSource,
  ExtractedSelection,
  Language,
  LlmProvider,
  ProviderValidation,
  QuestionRequest,
  SelectionContext,
} from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'
import { getSelectedWindowId, listWindows, setSelectedWindowId } from './selection/capture'
import { invalidateExtractionCache } from './selection/extractionCache'
import {
  createPopupWindow,
  getMainWindow,
  getOverlayMode,
  getPopupContext,
  showMacSelectionOverlay,
  setMainWindowRoute,
  setOverlayInteractive,
  trackSelectionOverlay,
  type MainRoute,
} from './windows'
import { resetToNormalMode, updateModeShortcut } from './selection/shortcut'
import { getSettings, setSettings } from './settingsStore'
import { getFrequent, setFrequent } from './frequentStore'
import { deleteApiKey, getApiKey, setApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { validateProvider } from './question/llm/validate'
import { googleImageUrl, googlePronunciationUrl, openGoogleSearchInNewWindow } from './question/google'

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
    invalidateExtractionCache() // 이전 창(재선택 포함)의 캐시가 새 창으로 넘어가지 않게
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

  ipcMain.handle(IPC.GET_MODE, async () => getOverlayMode())

  ipcMain.handle(IPC.OVERLAY_SET_INTERACTIVE, async (_e, interactive: boolean) => {
    setOverlayInteractive(interactive)
  })

  // 담당 A: 팝업 직전 추출 결과(ExtractedSelection) 생성 → 팝업(담당 B) 오픈 + 전달
  ipcMain.handle(IPC.SELECTION_EXTRACTED, async (_e, point: { x: number; y: number }) => {
    const extracted: ExtractedSelection = await runSelectionPipeline(point)
    createPopupWindow(extracted)
    return extracted
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

  // 담당 B: 자주 쓰는 질문 조회/저장 (userData/frequent.json, frequentStore.ts)
  ipcMain.handle(IPC.FREQUENT_GET, async (): Promise<string[]> => {
    return getFrequent()
  })

  ipcMain.handle(IPC.FREQUENT_SET, async (_e, list: string[]): Promise<string[]> => {
    return setFrequent(list)
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

  // 담당 B: provider 키 검증 + 사용 가능 모델 조회 (무과금 GET, validate.ts)
  ipcMain.handle(
    IPC.PROVIDER_VALIDATE,
    async (_e, provider: LlmProvider, apiKey: string): Promise<ProviderValidation> => {
      return validateProvider(provider, apiKey)
    },
  )

  // 담당 B: 팝업 열기 (데모용 — ctx 없이 열면 렌더러가 목업으로 fallback)
  // 담당 A 통합 시엔 선택 파이프라인이 createPopupWindow(ctx) 를 직접 호출한다.
  ipcMain.handle(IPC.OPEN_POPUP, async () => {
    createPopupWindow(null)
  })

  // 담당 B: 팝업 렌더러가 마운트 시 현재 ExtractedSelection 을 조회
  ipcMain.handle(IPC.POPUP_GET_CONTEXT, async (): Promise<ExtractedSelection | null> => {
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
      await openGoogleSearchInNewWindow(url)
    },
  )
}
