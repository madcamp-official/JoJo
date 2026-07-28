// 담당 B — 확장 content script.
// 유튜브 화면 자막을 단어별 좌표와 함께 추출해(youtube.ts) background 로 보낸다.
// background 가 WS 로 앱에 중계한다. 자막 캡처는 앱이 선택 모드일 때만 켜진다(setCapture).
import { extractSubtitleSnapshot, isYoutubeWatch, observeSubtitles } from './youtube'
import {
  currentVideoId,
  loadTranscript,
  subtitleLangHint,
  surroundingCues,
  type TranscriptCue,
} from './timedtext'
import type { SubtitleSnapshot } from '@shared/extension'

// content ↔ background 내부 메시지(확장 안에서만 씀).
type FromBackground = { kind: 'setCapture'; active: boolean } | { kind: 'requestSnapshot' }

// 앞뒤 범위 자막 개수(클릭한 줄 기준). 팝업 문맥용.
const CONTEXT_BEFORE = 3
const CONTEXT_AFTER = 3

let capturing = false
let stopObserving: (() => void) | null = null
let lastSent = ''
let transcriptCues: TranscriptCue[] | null = null
let transcriptKey: string | null = null // `${videoId}|${langHint}`

// timedtext 전체 자막을 미리 로드해 캐시(앞뒤 문맥용). 화면 자막 언어(langHint)까지 키에
// 넣어, 같은 영상이라도 자막 언어가 바뀌면 그 언어 트랙을 새로 받아 문맥 언어를 일치시킨다.
// langHint 는 지금 화면 자막 텍스트에서 뽑는다(없으면 로드 보류). 실패해도 화면 자막은 동작.
function ensureTranscript(screenText: string): void {
  const vid = currentVideoId()
  const hint = subtitleLangHint(screenText)
  if (!vid || !hint) return
  const key = `${vid}|${hint}`
  if (key === transcriptKey) return
  transcriptKey = key
  transcriptCues = null
  loadTranscript(vid, hint)
    .then((cues) => {
      if (transcriptKey === key) {
        transcriptCues = cues
        pushSnapshot() // 문맥이 준비됐으니 한 번 더 보낸다
      }
    })
    .catch(() => {
      /* 자막 트랙 없음/차단 — 화면 자막만으로 진행 */
    })
}

function withContext(snapshot: SubtitleSnapshot): SubtitleSnapshot {
  if (!transcriptCues || transcriptCues.length === 0) return snapshot
  const context = surroundingCues(transcriptCues, snapshot.currentTime, CONTEXT_BEFORE, CONTEXT_AFTER)
  return { ...snapshot, context }
}

function pushSnapshot(): void {
  if (!capturing) return
  const base = isYoutubeWatch() ? extractSubtitleSnapshot() : null
  if (base) {
    // 화면 자막 언어에 맞는 timedtext 트랙을 (필요 시) 로드한다(영상 전환·자막 언어 변경 대응).
    ensureTranscript(base.lines.map((l) => l.text).join(' '))
  }
  const snapshot = base ? withContext(base) : null
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
    // 최신 좌표+재생시간+앞뒤 문맥으로 한 프레임 즉시 반환(hover/클릭 직전 앱 요청용).
    const base = isYoutubeWatch() ? extractSubtitleSnapshot() : null
    sendResponse({ snapshot: base ? withContext(base) : null })
    return true
  }
  return undefined
})
