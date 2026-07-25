import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AppSettings,
  CaptureSource,
  ExtractedSelection,
  Language,
  LlmProvider,
  QuestionRequest,
  SelectionContext,
} from '@shared/types'
import { runSelectionPipeline } from './selection'
import { runQuestion } from './question'
import { listWindows, setSelectedWindowId } from './selection/capture'
import {
  createPopupWindow,
  getMainWindow,
  getOverlayMode,
  getPopupContext,
  hideSelectionOverlay,
  setMainWindowRoute,
  setOverlayInteractive,
  trackSelectionOverlay,
  type MainRoute,
} from './windows'
import { updateModeShortcut } from './selection/shortcut'
import { getSettings, setSettings } from './settingsStore'
import { deleteApiKey, getApiKey, setApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { googleImageUrl, googlePronunciationUrl } from './question/google'

// IPC 허브 (공동) — A→B 연결점.
// 렌더러는 preload 를 통해서만 이 채널들에 접근한다.
export function registerIpc(): void {
  // 담당 A: 창 목록 조회
  ipcMain.handle(IPC.WINDOW_LIST, async (): Promise<CaptureSource[]> => {
    return listWindows()
  })

  // 메인/피커/설정 전환 — 렌더러가 이미 해시를 바꿨으므로 창 크기만 맞춘다(navigate.ts: goto()).
  ipcMain.handle(IPC.WINDOW_SET_ROUTE, async (_e, route: MainRoute): Promise<void> => {
    setMainWindowRoute(route)
  })

  ipcMain.handle(IPC.SELECT_WINDOW, async (_e, source: CaptureSource) => {
    setSelectedWindowId(source.id)
    getMainWindow()?.webContents.send(IPC.WINDOW_SELECTED, source)

    if (process.platform === 'win32') {
      const hwnd = BigInt(source.id)
      // win32Capture 는 koffi 로 DLL 을 로드하므로 Windows 경로에서만 동적 import.
      const { bringWindowToForeground } = await import('./selection/win32Capture')
      bringWindowToForeground(hwnd) // 가려진 채로 선택되면 테두리와 실제 화면이 어긋나 보임
      await trackSelectionOverlay(hwnd) // 대상 창 이동/리사이즈를 따라 오버레이도 갱신
    } else {
      hideSelectionOverlay()
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
      await shell.openExternal(url)
    },
  )

  // TODO: SET_MODE 핸들러 연결
}
