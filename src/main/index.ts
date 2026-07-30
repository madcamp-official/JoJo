import { app, BrowserWindow } from 'electron'
import { startAutoUpdateCheck } from './autoUpdate'
import { createMainWindow, getMainWindow, setQuitting } from './windows'
import { createTray } from './tray'
import { registerIpc } from './ipc'
import { applyExtractionDecision, registerModeShortcut } from './selection/shortcut'
import { seedApiKeysFromEnv } from './devSeed'
import { loadSettings } from './settingsStore'
import { getApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { registerContextMenu } from './contextMenu'
import { warmJapaneseTokenizer } from './nlp/japanese'
import { warmChineseSegmenter } from './nlp/chinese'
import { cleanupOrphanedPythonServers, killAllPythonServers } from './selection/pythonServer'
import { ensureCjkEngineWarm, startGeneralWarmUp } from './selection/warmup'
import { startExtensionBridge } from './extension/bridge'
import { startActiveTabTracker } from './extension/activeTab'
import { registerRejudgeOnTabChange, reevaluator } from './extension/reevaluate'

// 싱글 인스턴스 강제 — electron-vite dev 는 Electron 본체를 자식 프로세스로 spawn 하는데,
// 부모(node) 가 죽어도(터미널 종료, 이전 dev 세션 비정상 종료 등) 자식은 자동으로 안
// 죽는다(pythonServer.ts 의 동일 문제가 한 단계 위에서도 발생). 이렇게 고아가 된
// 인스턴스가 쌓이면 트레이 아이콘이 여러 개 뜨고, 그중 하나에서 "종료"를 눌러도 다른
// 인스턴스는 그대로 남아 "안 꺼지는 것처럼" 보인다(실사용 중 확인: dev 세션을 여러 번
// 켜서 고아 인스턴스가 남아있었음). 락을 못 얻으면(이미 인스턴스가 떠있으면) 새 인스턴스는
// 바로 종료하고, 기존 인스턴스는 두 번째 실행 시도를 감지해 메인 창을 앞으로 가져온다.
// 담당 A — Windows 네이티브 창 가림(occlusion) 계산 비활성화(2026-07-31, 사용자 제보 —
// Kindle 뷰어에서 재추출이 끝나도 오버레이의 배너/영역/텍스트 박스가 화면에 안 나타나다가
// 다른 앱 클릭/모드 토글 순간 한꺼번에 나타남). Chromium 은 Windows 에서 창이 다른 창에
// 가려졌는지를 자체 계산(CalculateNativeWinOcclusion)해서 가려진 창의 렌더러를 페인트
// 중단 상태로 보내는데, 우리 오버레이(투명·클릭스루)는 이 계산이 "가려짐"으로 오판하기
// 쉬운 전형적 케이스다 — 렌더 상태 로그로 React state 는 제때 바뀌는데 화면만 안 그려짐을
// 확인했고, invalidate()/setBounds 재적용 같은 페인트 강제로는 안 고쳐졌다(렌더러 자체가
// hidden 취급이라). 오버레이 창의 backgroundThrottling:false(windows.ts)와 한 쌍의 수정.
// app ready 전에 설정해야 적용된다. **Windows 전용 스위치**(macOS 는 이 기능 자체가 없음
// — 무해하지만 명시적으로 win32 에서만 건다).
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const main = getMainWindow()
    if (main) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
  })

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
    reevaluator.on('decision', applyExtractionDecision) // 재판정 결과를 파이프라인에 적용(자막↔OCR 전환)
    registerModeShortcut(settings.modeShortcut)
    // settingsShortcut(설정 화면 열기)은 더 이상 여기서 전역 등록하지 않는다 — 각
    // 렌더러(App.tsx)가 로컬 keydown 으로 직접 판정한다(shortcut.ts 주석 참고).
    warmJapaneseTokenizer() // 일본어 형태소 분석 엔진 로드를 미리 시작 — 첫 사용 시 지연 없게
    warmChineseSegmenter() // ZH_HANT_ENGINE 이 chinese-tokenizer 면 CC-CEDICT 파싱(~350ms) 예열

    // 담당 A — changeWatcher.ts 의 화면 변화 감지(픽셀 diff)가 스크롤/클릭/키보드와
    // 무관한 변화(hover 밑줄 등)에도 반응하던 문제 보완 — 저수준 전역 입력 후크로 마지막
    // 입력 시각을 기록해둔다(inputHook.ts 주석 참고). **Windows 전용**(win32Capture.ts 와
    // 같은 이유로 동적 import — 다른 플랫폼에선 이 파일을 아예 안 불러서 koffi.load 도
    // 안 돈다).
    if (process.platform === 'win32') {
      void import('./selection/inputHook').then(({ startInputHook }) => startInputHook())
    }

    // 담당 A — 최소화 창 썸네일 상시 캐시(2026-07-31, 사용자 요청 — capture.ts:
    // startForegroundThumbnailCapture 주석 참고). 창 선택 화면을 열 때만 캡처하면, 어떤
    // 창을 띄웠다가 목록을 한 번도 안 연 채로 최소화해버린 경우 캐시가 영영 안 생기는
    // 빈틈이 있어서, 앱이 켜져 있는 동안 항상 포그라운드 전환을 감시해 그 순간을 놓치지
    // 않는다. **Windows 전용**(win32Capture.ts 와 같은 이유로 동적 import).
    if (process.platform === 'win32') {
      void import('./selection/capture').then(({ startForegroundThumbnailCapture }) =>
        startForegroundThumbnailCapture(),
      )
    }

    // 담당 A — 예열 시점/방식 재설계(2026-07-31, 사용자 요청 — warmup.ts 상단 주석 참고).
    // DocLayout-YOLO(범용 엔진)는 언어와 무관하게 항상 필요해 앱이 뜨자마자 백그라운드로
    // 예열을 시작한다 — 끝나기를 기다리지 않고 창 선택도 바로 허용한다(예전처럼 버튼을
    // 막지 않음). 아직 예열 중일 때 선택 모드에 들어가면 그 대기 시간만큼
    // extractionCache.ts 가 "엔진 예열 중..." 알림을 띄운다.
    void startGeneralWarmUp()
    // 언어가 이미 일본어/중국어로 수동 고정돼 있으면 그 CJK 엔진도 지금 바로 예열을
    // 시작한다 — 처음 선택 모드에 들어갈 때까지 기다리지 않는다(설정에서 방금 고정한
    // 경우의 즉시 예열은 ipc.ts: SETTINGS_SET 핸들러가 담당).
    if (settings.language === 'ja' || settings.language === 'zh-Hans' || settings.language === 'zh-Hant') {
      void ensureCjkEngineWarm(settings.language)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })

    // 담당 A — 자동 업데이트(2026-07-31, 사용자 요청, autoUpdate.ts 상단 주석 참고) —
    // 패키징된 빌드에서만 동작(개발 모드는 내부에서 바로 무시). 시작 직후 다른 예열
    // 작업들과 몰리지 않게 살짝 늦춰서 확인한다.
    setTimeout(startAutoUpdateCheck, 10_000)
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
    if (process.platform === 'win32') {
      void import('./selection/inputHook').then(({ stopInputHook }) => stopInputHook())
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
