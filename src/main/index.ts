import { app, BrowserWindow } from 'electron'
import { createMainWindow, setQuitting } from './windows'
import { createTray } from './tray'
import { registerIpc } from './ipc'
import { registerModeShortcut } from './selection/shortcut'
import { seedApiKeysFromEnv } from './devSeed'
import { loadSettings } from './settingsStore'
import { getApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import { registerContextMenu } from './contextMenu'

// 앱 진입점 — 윈도우 생성, IPC 등록, 전역 단축키 등록
app.whenReady().then(() => {
  // 개발 전용: .env(MAIN_VITE_*)의 API 키를 keyStore 에 주입
  if (import.meta.env.DEV) seedApiKeysFromEnv()

  const settings = loadSettings()
  // 저장된 provider 의 키가 있으면 재실행 시에도 바로 활성화(사용자가 매번 설정에서 다시 고를 필요 없게).
  if (settings.llm && getApiKey(settings.llm)) setActiveProvider(settings.llm)

  registerContextMenu()
  createMainWindow()
  createTray()
  registerIpc()
  registerModeShortcut(settings.modeShortcut)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// 메인 창은 X 버튼으로 실제로 닫히지 않고 트레이로 숨는다(windows.ts) — 진짜 종료는
// 트레이 "종료" 메뉴(app.quit)로만. before-quit 에서 그 플래그를 세워 close 핸들러가
// 이번엔 숨기지 말고 실제로 닫히게 통과시킨다.
app.on('before-quit', () => {
  setQuitting(true)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
