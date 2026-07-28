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
    console.log('[nuance] WS 연결됨 → hello 전송')
    send({ type: 'hello', version: EXT_VERSION })
    void reportActiveTab()
  }
  ws.onmessage = (ev) => onAppMessage(ev.data)
  ws.onclose = () => {
    if (socket === ws) socket = null
    console.log('[nuance] WS 끊김 → 재접속 예약')
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
      captureDesired = msg.active
      void syncCapture()
      break
    case 'setVideoPlayback':
      void sendPlaybackToActiveTab(msg.play)
      break
    case 'welcome':
      break
  }
}

// 팝업 열림/닫힘에 맞춰 활성 탭 영상을 정지/재생한다.
async function sendPlaybackToActiveTab(play: boolean): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'setPlayback', play })
  } catch {
    /* content 미로드/비대상 무시 */
  }
}

// 자막 캡처는 "현재 활성 탭 하나"에서만 돈다. 탭을 바꾸면(사이트가 같아도) 이전 탭은
// 끄고 새 활성 탭에 다시 켜줘야 자막이 계속 뜬다 — captureDesired(앱이 원하는 on/off)와
// capturedTabId(지금 켜둔 탭)를 추적해 활성 탭 변화 때마다 맞춘다.
let captureDesired = false
let capturedTabId: number | null = null

async function sendCapture(tabId: number, active: boolean): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'setCapture', active })
  } catch {
    // content script 미로드/비대상 페이지면 무시.
  }
}

async function syncCapture(): Promise<void> {
  if (!captureDesired) {
    if (capturedTabId !== null) {
      await sendCapture(capturedTabId, false)
      capturedTabId = null
    }
    return
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const activeId = tab?.id ?? null
  if (activeId === capturedTabId) return
  if (capturedTabId !== null) await sendCapture(capturedTabId, false) // 이전 탭 끄기
  if (activeId !== null) await sendCapture(activeId, true) // 새 활성 탭 켜기
  capturedTabId = activeId
}

// content script → background: 화면 자막 프레임/전체 자막을 받아 앱으로 중계한다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'subtitles') {
    send({ type: 'subtitles', snapshot: msg.snapshot ?? null })
  } else if (msg?.kind === 'transcript') {
    send({ type: 'transcript', videoId: msg.videoId, cues: msg.cues ?? [] })
  } else if (msg?.kind === 'subtitleClick') {
    send({
      type: 'subtitleClick',
      word: msg.word,
      lineText: msg.lineText,
      wordOffsetInLine: msg.wordOffsetInLine,
      currentTime: msg.currentTime,
    })
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

// 탭 전환 — 앱에 보고(재판정은 앱이 URL 비교로 결정) + 새 활성 탭에 자막 캡처 재동기화.
chrome.tabs.onActivated.addListener(() => {
  scheduleReport()
  void syncCapture()
})
// 같은 탭 안에서 URL 이 바뀌는 경우(유튜브 SPA 네비게이션 = /watch 이동 등은 url 갱신으로 잡힘)
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if ((info.url || info.status === 'complete') && tab.active) {
    scheduleReport()
    void syncCapture()
  }
})
// 브라우저 창 포커스 전환(다른 브라우저 창으로 이동)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleReport()
    void syncCapture()
  }
})

connect()

// MV3 서비스 워커는 유휴 시 종료되고, setTimeout 재접속 타이머도 함께 사라져 영영 재접속을
// 못 하는 문제가 있다 — chrome.alarms 로 주기적으로 워커를 깨워 연결을 보장한다(끊겨 있으면
// 재접속, 이미 연결돼 있으면 no-op). 앱이 확장보다 늦게 켜져도 이걸로 결국 연결된다.
chrome.alarms.create('nuance-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'nuance-reconnect') connect()
})
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
