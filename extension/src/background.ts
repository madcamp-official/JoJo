// 담당 B — 확장 백그라운드 (service worker).
// Electron 앱의 로컬 WebSocket 서버에 접속해 활성 탭 변화·자막 등을 보낸다.
// MV3 서비스 워커는 유휴 시 종료되므로, 앱이 보내는 ping 으로 생존을 유지하고
// 끊기면 백오프 재접속한다. content script 와는 chrome.runtime 메시지로 중계한다.
import { extWsUrl, type AppToExt, type ExtActiveTab, type ExtToApp } from '@shared/extension'

const EXT_VERSION = chrome.runtime.getManifest().version

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 1000
const MAX_BACKOFF_MS = 30_000

function send(msg: ExtToApp): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  let ws: WebSocket
  try {
    ws = new WebSocket(extWsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    backoffMs = 1000
    send({ type: 'hello', version: EXT_VERSION })
    void reportActiveTab()
  }
  ws.onmessage = (ev) => onAppMessage(ev.data)
  ws.onclose = () => {
    if (socket === ws) socket = null
    scheduleReconnect()
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      /* 무시 */
    }
  }
}

function onAppMessage(raw: unknown): void {
  let msg: AppToExt
  try {
    msg = JSON.parse(String(raw)) as AppToExt
  } catch {
    return
  }
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong' })
      break
    case 'requestActiveTab':
      void reportActiveTab()
      break
    case 'setSubtitleCapture':
      void setCaptureOnActiveTab(msg.active)
      break
    case 'welcome':
      break
  }
}

// 앱이 선택 모드를 켜고 끌 때, 활성 탭의 content script 에 자막 캡처 on/off 를 전달한다.
async function setCaptureOnActiveTab(active: boolean): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'setCapture', active })
  } catch {
    // content script 가 아직 없거나(로드 전) 대상 페이지가 아니면 무시.
  }
}

// content script → background: 화면 자막 프레임을 받아 앱으로 중계한다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'subtitles') {
    send({ type: 'subtitles', snapshot: msg.snapshot ?? null })
  }
  return undefined
})

// 현재 활성 탭을 앱에 보고한다. (탭/URL 변화 감지 트리거는 task 3에서 확장)
async function reportActiveTab(): Promise<void> {
  const tab = await currentActiveTab()
  send({ type: 'activeTab', tab })
}

async function currentActiveTab(): Promise<ExtActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || tab.id === undefined || !tab.url) return null
  return { tabId: tab.id, url: tab.url, title: tab.title }
}

// 탭 변화가 짧은 시간에 여러 번 튀는 경우(activated+updated 동시 등) 마지막 한 번만 보고한다.
let reportTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReport(): void {
  if (reportTimer) clearTimeout(reportTimer)
  reportTimer = setTimeout(() => {
    reportTimer = null
    void reportActiveTab()
  }, 150)
}

// 탭 전환
chrome.tabs.onActivated.addListener(() => scheduleReport())
// 같은 탭 안에서 URL 이 바뀌는 경우(유튜브 SPA 네비게이션 = /watch 이동 등은 url 갱신으로 잡힘)
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if ((info.url || info.status === 'complete') && tab.active) scheduleReport()
})
// 브라우저 창 포커스 전환(다른 브라우저 창으로 이동)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleReport()
})

connect()
