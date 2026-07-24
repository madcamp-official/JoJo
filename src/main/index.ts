import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './windows'
import { registerIpc } from './ipc'
import { registerModeShortcut } from './pipelineA/shortcut'

// 앱 진입점 — 윈도우 생성, IPC 등록, 전역 단축키 등록
app.whenReady().then(() => {
  createMainWindow()
  registerIpc()
  registerModeShortcut()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
