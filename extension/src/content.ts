// 담당 B — 확장 content script.
// 유튜브 화면 자막을 단어별 좌표와 함께 추출해(youtube.ts) background 로 보낸다.
// background 가 WS 로 앱에 중계한다. 자막 캡처는 앱이 선택 모드일 때만 켜진다(setCapture).
import { extractSubtitleSnapshot, isYoutubeWatch, observeSubtitles } from './youtube'

// content ↔ background 내부 메시지(확장 안에서만 씀).
type FromBackground = { kind: 'setCapture'; active: boolean } | { kind: 'requestSnapshot' }

let capturing = false
let stopObserving: (() => void) | null = null
let lastSent = ''

function pushSnapshot(): void {
  if (!capturing) return
  const snapshot = isYoutubeWatch() ? extractSubtitleSnapshot() : null
  // 동일 프레임 중복 전송 방지(좌표+텍스트가 같으면 스킵). null 도 한 번만 보낸다.
  const sig = snapshot ? JSON.stringify(snapshot) : 'null'
  if (sig === lastSent) return
  lastSent = sig
  chrome.runtime.sendMessage({ kind: 'subtitles', snapshot })
}

function startCapture(): void {
  if (capturing) return
  capturing = true
  lastSent = ''
  stopObserving = observeSubtitles(() => pushSnapshot())
  pushSnapshot()
}

function stopCapture(): void {
  if (!capturing) return
  capturing = false
  stopObserving?.()
  stopObserving = null
  chrome.runtime.sendMessage({ kind: 'subtitles', snapshot: null })
}

chrome.runtime.onMessage.addListener((msg: FromBackground, _sender, sendResponse) => {
  if (msg?.kind === 'setCapture') {
    if (msg.active) startCapture()
    else stopCapture()
  } else if (msg?.kind === 'requestSnapshot') {
    // 최신 좌표+재생시간으로 한 프레임 즉시 반환(hover/클릭 직전 앱 요청용).
    const snapshot = isYoutubeWatch() ? extractSubtitleSnapshot() : null
    sendResponse({ snapshot })
    return true
  }
  return undefined
})
