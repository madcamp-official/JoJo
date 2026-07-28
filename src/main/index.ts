import { app, BrowserWindow } from 'electron'
import { IPC } from '@shared/channels'
import { createMainWindow, getMainWindow, setQuitting } from './windows'
import { createTray } from './tray'
import { registerIpc } from './ipc'
import { registerModeShortcut, registerSettingsShortcut } from './selection/shortcut'
import { seedApiKeysFromEnv } from './devSeed'
import { loadSettings } from './settingsStore'
import { getApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { registerContextMenu } from './contextMenu'
import { warmJapaneseTokenizer } from './nlp/japanese'
import { warmChineseSegmenter } from './nlp/chinese'
import { cleanupOrphanedPythonServers, killAllPythonServers } from './selection/pythonServer'
import { startWarmUp } from './selection/warmup'
import { startExtensionBridge } from './extension/bridge'
import { startActiveTabTracker } from './extension/activeTab'
import { registerRejudgeOnTabChange } from './extension/reevaluate'

// 앱 진입점 — 윈도우 생성, IPC 등록, 전역 단축키 등록
app.whenReady().then(() => {
  // 지난 실행이 비정상 종료돼서(강제 종료 등) 못 지운 python 워커가 있으면 새로
  // 워커를 스폰하기 전에 먼저 정리한다(pythonServer.ts: cleanupOrphanedPythonServers
  // 주석 참고) — 실사용 중 반복 확인: 정상적인 before-quit 을 못 타는 종료가 쌓이면
  // 프로세스가 계속 늘어나 CPU 오버서브스크립션으로 이어짐.
  cleanupOrphanedPythonServers()

  // 개발 전용: .env(MAIN_VITE_*)의 API 키를 keyStore 에 주입
  if (import.meta.env.DEV) seedApiKeysFromEnv()

  const settings = loadSettings()
  // 저장된 provider 의 키가 있으면 재실행 시에도 바로 활성화(사용자가 매번 설정에서 다시 고를 필요 없게).
  if (settings.llm && getApiKey(settings.llm)) setActiveProvider(settings.llm)

  registerContextMenu()
  createMainWindow()
  createTray()
  registerIpc()
  startExtensionBridge() // 크롬 확장이 접속할 로컬 WebSocket 서버 시작
  startActiveTabTracker() // 확장이 보고하는 활성 탭을 분류(유튜브/넷플릭스/웹)
  registerRejudgeOnTabChange() // 선택 모드 중 탭/URL 변화 시 추출 방식 재판정
  registerModeShortcut(settings.modeShortcut)
  registerSettingsShortcut(settings.settingsShortcut)
  warmJapaneseTokenizer() // 일본어 형태소 분석 엔진 로드를 미리 시작 — 첫 사용 시 지연 없게
  warmChineseSegmenter() // ZH_HANT_ENGINE 이 chinese-tokenizer 면 CC-CEDICT 파싱(~350ms) 예열

  // 담당 A — 실험용 브랜치(experiment/doclayout-yolo). DocLayout-YOLO/PaddleOCR/
  // manga-ocr 은 Python 서브프로세스라 첫 호출에 모델 로딩만 8~20초씩 걸린다(실측
  // 확인) — 사용자가 실제로 선택 모드에 들어가서 처음 쓸 때 이 지연을 겪지 않도록,
  // 앱이 뜨자마자(창을 아직 안 골랐어도) 백그라운드로 미리 예열해둔다. 완료 시점을
  // 메인 창(창 선택 화면)에 알려서, 예열 중엔 창 선택 버튼을 막아둔다(MainScreen.tsx)
  // — 안 그러면 예열이 덜 끝난 채로 선택 모드에 들어가서 결국 같은 대기를 겪는다.
  // await 는 안 한다 — 실패해도(Python 환경 없음 등) startWarmUp() 자체는 각 엔진의
  // warmUp() 이 에러를 내부에서 삼키므로 곧 resolve 되고, 앱 시작 자체를 막지 않는다.
  void startWarmUp().then(() => {
    getMainWindow()?.webContents.send(IPC.WARMUP_READY)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// 메인 창은 X 버튼으로 실제로 닫히지 않고 트레이로 숨는다(windows.ts) — 진짜 종료는
// 트레이 "종료" 메뉴(app.quit)로만. before-quit 에서 그 플래그를 세워 close 핸들러가
// 이번엔 숨기지 말고 실제로 닫히게 통과시킨다.
//
// 담당 A — 실험용 브랜치. layout_detect.py/ocr_paddle.py 는 Node 의 child_process.spawn
// 으로 띄우는데, 이 자식 프로세스는 부모(Electron)가 죽어도 자동으로 안 죽는다 — 실측
// 확인: 진단 스크립트를 반복 실행했더니 이전 실행의 프로세스가 고아로 계속 쌓여서
// 예상보다 2배(레이아웃 1→2개, PaddleOCR 3→6개, 약 2.8GB) 메모리를 낭비하고 있었다.
// 실제 사용자도 앱을 여러 번 껐다 켜면 같은 식으로 쌓일 수 있어서, 종료 시 반드시
// 정리한다.
app.on('before-quit', () => {
  setQuitting(true)
  killAllPythonServers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
