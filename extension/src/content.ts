// 담당 B — 확장 content script.
// 유튜브 화면 자막을 단어별 좌표와 함께 추출해(youtube.ts) background 로 보낸다.
// background 가 WS 로 앱에 중계한다. 자막 캡처는 앱이 선택 모드일 때만 켜진다(setCapture).
import { extractSubtitleSnapshot, isYoutubeWatch, observeSubtitles, videoCurrentTime } from './youtube'
import { currentVideoId } from './timedtext'
import { startHighlight, type WordHit } from './highlight'
import { parseAnyCaptionPayload } from './captionParse'
import type { SubLine } from '@shared/extension'

// content ↔ background 내부 메시지(확장 안에서만 씀).
type FromBackground =
  | { kind: 'setCapture'; active: boolean }
  | { kind: 'requestSnapshot' }
  | { kind: 'setPlayback'; play: boolean }

function setVideoPlayback(play: boolean): void {
  const v = document.querySelector<HTMLVideoElement>('video')
  if (!v) return
  if (play) void v.play().catch(() => {})
  else v.pause()
}

let capturing = false
let stopObserving: (() => void) | null = null
let stopHighlightUi: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastSent = ''
let lastDiag = -1

// hover/클릭 판정용 자막 줄+좌표를 그 순간 즉석에서 다시 측정한다(캐시 안 씀) — 컨트롤바
// 자동 표시/숨김으로 자막 위치가 바뀌어도(유튜브가 이때 childList/attribute 변화를 항상
// 안 내서 폴링 주기까지 지연될 수 있었음) getBoundingClientRect 기반이라 항상 최신이다.
function liveLines(): SubLine[] {
  return isYoutubeWatch() ? (extractSubtitleSnapshot()?.lines ?? []) : []
}

function onWordClicked(hit: WordHit): void {
  chrome.runtime.sendMessage({
    kind: 'subtitleClick',
    word: hit.text,
    lineText: hit.lineText,
    wordOffsetInLine: hit.wordOffsetInLine,
    currentTime: videoCurrentTime(),
  })
}

// 진단(임시): 화면에 자막 요소가 몇 개 보이는지 유튜브 탭 콘솔에 찍는다(개수 바뀔 때만).
function debugCounts(): void {
  const wins = document.querySelectorAll('.caption-window').length
  const segs = document.querySelectorAll('.ytp-caption-segment').length
  if (segs !== lastDiag) {
    lastDiag = segs
    console.log(`[nuance content] youtubeWatch=${isYoutubeWatch()} caption-window=${wins} ytp-caption-segment=${segs}`)
  }
}

// 페이지 메인 JS 세계(networkHook.ts, manifest.json "world":"MAIN")가 가로챈 자막 관련
// 네트워크 응답을 postMessage로 받는다. 플레이어 자신의 실제 timedtext 요청을 엿듣는
// 이 경로만 실제로 자막을 확보한다(native TextTrack/InnerTube 는 둘 다 실측으로 항상
// 실패해 폐기 — timedtext.ts 상단 주석 참고). 이게 도착하면 그대로 앱에 전달한다.
let lastInterceptedSig = ''
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return
  const data = ev.data as { source?: string; kind?: string; url?: string; text?: string } | undefined
  if (!data || data.source !== 'nuance-mainworld' || data.kind !== 'captionResponse') return
  const cues = parseAnyCaptionPayload(data.text ?? '')
  if (cues.length === 0) return
  const vid = currentVideoId()
  if (!vid) return
  const sig = `${vid}|${cues.length}|${cues[0]?.text ?? ''}`
  if (sig === lastInterceptedSig) return
  lastInterceptedSig = sig
  console.log(`[nuance content] 네트워크 가로채기로 자막 확보: ${cues.length} cues (url=${data.url})`)
  chrome.runtime.sendMessage({
    kind: 'transcript',
    videoId: vid,
    cues: cues.map((c) => ({ start: c.start, text: c.text })),
  })
})

function pushSnapshot(): void {
  if (!capturing) return
  debugCounts()
  const snapshot = isYoutubeWatch() ? extractSubtitleSnapshot() : null
  // 동일 프레임 중복 전송 방지(디버그 로그용, 좌표+텍스트가 같으면 스킵). null 도 한 번만 보낸다.
  const sig = snapshot ? JSON.stringify(snapshot) : 'null'
  if (sig === lastSent) return
  lastSent = sig
  chrome.runtime.sendMessage({ kind: 'subtitles', snapshot })
}

function startCapture(): void {
  console.log('[nuance content] startCapture 호출됨 (이미capturing=' + capturing + ')')
  if (capturing) return
  capturing = true
  lastSent = ''
  lastDiag = -1
  stopObserving = observeSubtitles(() => pushSnapshot())
  // MutationObserver 가 자막 등장/좌표 변화를 놓치는 경우를 대비한 폴링 폴백(중복은 dedup 됨,
  // 앱으로 보내는 디버그 스냅샷용 — hover/클릭 자체는 liveLines()로 즉석 측정이라 무관).
  pollTimer = setInterval(() => pushSnapshot(), 300)
  // hover 하이라이트 박스 + 클릭을 페이지 안에서 직접 처리(highlight.ts) — 매 이동마다
  // liveLines()로 즉석 재측정하므로 컨트롤바 표시/숨김으로 자막이 움직여도 항상 정확하다.
  stopHighlightUi = startHighlight(liveLines, onWordClicked)
  pushSnapshot()
}

function stopCapture(): void {
  if (!capturing) return
  capturing = false
  stopObserving?.()
  stopObserving = null
  stopHighlightUi?.()
  stopHighlightUi = null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  chrome.runtime.sendMessage({ kind: 'subtitles', snapshot: null })
}

chrome.runtime.onMessage.addListener((msg: FromBackground, _sender, sendResponse) => {
  if (msg?.kind === 'setCapture') {
    console.log(`[nuance content] setCapture 메시지 수신: active=${msg.active}`)
    if (msg.active) startCapture()
    else stopCapture()
  } else if (msg?.kind === 'setPlayback') {
    setVideoPlayback(msg.play)
  } else if (msg?.kind === 'requestSnapshot') {
    // 최신 좌표+재생시간으로 한 프레임 즉시 반환(hover/클릭 직전 앱 요청용).
    sendResponse({ snapshot: isYoutubeWatch() ? extractSubtitleSnapshot() : null })
    return true
  }
  return undefined
})
