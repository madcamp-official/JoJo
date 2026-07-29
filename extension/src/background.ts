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
    // 활성 탭 보고는 여기서 먼저 하지 않는다 — 앱(bridge.ts onConnection)이 새 연결마다
    // requestActiveTab 을 보내오므로 그 응답으로 한 번만 보고한다(중복 보고 방지).
  }
  ws.onmessage = (ev) => onAppMessage(ev.data)
  ws.onclose = () => {
    if (socket === ws) socket = null
    console.log('[nuance] WS 끊김 → 재접속 예약')
    scheduleReconnect()
    // 앱이 완전히 종료됐을 수도 있다 — 그 경우 다시는 연결이 안 돌아올 수 있는데, 여기서
    // 캡처를 끄지 않으면 확장은 마지막 상태(hover 박스 등)를 탭 새로고침 전까지 계속
    // 띄운다. 끊기면 일단 꺼두고, 재연결되면(bridge.ts) 앱이 원하는 상태를 다시 알려준다.
    captureDesired = false
    void syncCapture()
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
    case 'focusTab':
      void focusCapturedTab()
      break
    case 'wordSegments':
      void relayWordSegments(msg.lineText, msg.words)
      break
    case 'welcome':
      break
  }
}

// 앱이 CJK 자막 줄을 세그멘테이션한 결과를 캡처 중인 탭의 content script로 그대로 전달한다
// (hover 박스를 형태소 단위로 묶는 데 씀, highlight.ts).
async function relayWordSegments(lineText: string, words: { start: number; end: number }[]): Promise<void> {
  if (capturedTabId === null) return
  try {
    await chrome.tabs.sendMessage(capturedTabId, { kind: 'wordSegments', lineText, words })
  } catch {
    /* content script 미로드/비대상 무시 */
  }
}

// 탭 조회는 `windowType: 'normal'`만 본다 — `lastFocusedWindow: true`를 쓰면 개발자 도구를
// 별도 창으로 띄우고 거기 포커스가 가 있을 때(디버깅 중 새로고침 등) "마지막 포커스 창"이
// devtools 자신이 돼버려 매칭되는 탭이 없다고(null) 잘못 판정된다 — 그러면 앱이 브라우저를
// 놓쳤다고 보고 OCR로 폴백해 영역 선택을 요구하는 등 엉뚱하게 튄다.
async function activeNormalTab(): Promise<chrome.tabs.Tab | undefined> {
  // `chrome.tabs.query({active:true, windowType:'normal'})`만 쓰면 일반 창이 여러 개 열려
  // 있을 때 "창마다 활성 탭 하나씩" 여러 개를 반환하는데, 구조분해로 첫 번째만 취해서 —
  // 그게 우리가 원하는 창(예: 넷플릭스 탭이 있는 창)이 아니면 캡처가 엉뚱한 탭으로 간다
  // (실사용 제보: 이미 열어둔 탭을 새로고침 없이 선택 모드 진입 시 hover 박스 안 뜸,
  // 2026-07-29). 마지막으로 포커스된 일반 창을 먼저 특정해 그 창 안의 활성 탭만 본다.
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (win.id !== undefined) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
      if (tab) return tab
    }
  } catch {
    /* getLastFocused 실패(해당 창 없음 등) — 아래 폴백으로 */
  }
  const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' })
  return tab
}

// 팝업 열림/닫힘에 맞춰 활성 탭 영상을 정지/재생한다.
async function sendPlaybackToActiveTab(play: boolean): Promise<void> {
  const tab = await activeNormalTab()
  if (tab?.id === undefined) return
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'setPlayback', play })
  } catch {
    /* content 미로드/비대상 무시 */
  }
}

// 팝업(Electron 창)이 뜨는 동안 OS 포커스가 팝업으로 넘어가고, 닫혀도 OS가 원래 브라우저
// 창으로 포커스를 자동으로 되돌려준다는 보장이 없다(특히 macOS는 다음 앱을 임의로 고를 수
// 있음) — 팝업이 닫히면 앱이 이 메시지로 자막 캡처 중이던 탭/창에 명시적으로 포커스를
// 되돌려달라고 요청한다.
async function focusCapturedTab(): Promise<void> {
  const tabId = capturedTabId
  if (tabId === null) return
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    /* 탭이 이미 닫혔거나 무효 — 무시 */
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
    // content script 미로드/비대상 페이지면 정상적으로도 실패할 수 있음 — 무시.
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
  const tab = await activeNormalTab()
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
      videoId: msg.videoId ?? null,
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
  const tab = await activeNormalTab()
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
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if ((info.url || info.status === 'complete') && tab.active) {
    scheduleReport()
    // 페이지 새로고침(F5)은 같은 탭 id 를 유지한 채 content script 상태를 완전히 초기화한다
    // (capturing=false 로 리셋). syncCapture() 는 activeId 가 capturedTabId 와 같으면 "이미
    // 켜져 있다"고 보고 재전송을 건너뛰므로, 새로고침이 끝난 그 탭이 캡처 대상 탭이면
    // 여기서 명시적으로 다시 켜준다 — 안 그러면 선택 모드를 유지한 채 새로고침했을 때
    // hover 박스가 영영 안 뜬다.
    if (info.status === 'complete' && captureDesired && tabId === capturedTabId) {
      void sendCapture(tabId, true)
    }
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
