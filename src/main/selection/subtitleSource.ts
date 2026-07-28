import type { ExtractedSelection, Language } from '@shared/types'
import { extensionBridge } from '../extension/bridge'
import { getBrowserSource } from '../extension/activeTab'
import { createPopupWindow } from '../windows'

// 담당 B — 유튜브/넷플릭스 자막 추출 경로 (OCR 대체).
// hover 하이라이트와 클릭은 확장이 페이지 안에서 직접 처리한다(extension/src/highlight.ts) —
// 실제 마우스는 브라우저 페이지가 받으므로, 좌표를 앱(오버레이)으로 릴레이하면 크로스
// 프로세스 지연 때문에 자막이 조금만 움직여도 hover/클릭이 어긋났다. 페이지 안에서 그리면
// 지연이 없고 좌표 보정도 필요 없다. 앱은 클릭 이벤트(단어+줄+offset+재생시간)만 받아
// 전체 자막(timedtext)에서 앞뒤 문맥을 붙인 ExtractedSelection 을 만들어 팝업을 연다.

let active = false
let unsubscribeClick: (() => void) | null = null
let pausedForPopup = false

export function isSubtitleModeActive(): boolean {
  return active
}

export function startSubtitleMode(): void {
  if (active) return
  active = true
  extensionBridge.setSubtitleCapture(true)
  const handler = (hit: SubtitleClickHit): void => onSubtitleClick(hit)
  extensionBridge.on('subtitleClick', handler)
  unsubscribeClick = () => extensionBridge.off('subtitleClick', handler)
}

export function stopSubtitleMode(): void {
  if (!active) return
  active = false
  unsubscribeClick?.()
  unsubscribeClick = null
  extensionBridge.setSubtitleCapture(false)
}

interface SubtitleClickHit {
  word: string
  lineText: string
  wordOffsetInLine: number
  currentTime: number
}

function onSubtitleClick(hit: SubtitleClickHit): void {
  const selection = buildSelection(hit)
  if (!selection.text.trim()) return
  const win = createPopupWindow(selection)
  // 팝업 뜨는 동안 영상을 멈추고, 닫히면 다시 재생한다.
  extensionBridge.setVideoPlayback(false)
  if (!pausedForPopup) {
    pausedForPopup = true
    win.once('closed', () => {
      pausedForPopup = false
      extensionBridge.setVideoPlayback(true)
    })
  }
}

function buildSelection(hit: SubtitleClickHit): ExtractedSelection {
  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }
  const transcript = extensionBridge.getTranscript()

  // 전체 자막(timedtext)이 있으면 그걸 통째로 text 로 주고 anchor 만 클릭 단어에 맞춘다 —
  // 팝업이 설정 바이트(contextBytesBefore/After)만큼 앞뒤를 알아서 보여준다(OCR/텍스트와 동일).
  if (transcript && transcript.cues.length > 0) {
    const anchored = anchorInTranscript(
      transcript.cues,
      hit.currentTime,
      hit.lineText,
      hit.word,
      hit.wordOffsetInLine,
    )
    if (anchored) {
      return {
        text: anchored.text,
        anchor: { start: anchored.start, end: anchored.end },
        words: [],
        language: detectSubtitleLanguage(hit.lineText || anchored.text),
        source,
        extraction: 'direct',
      }
    }
  }

  // 전체 자막이 아직 없으면(로드 전/트랙 없음) 현재 줄만이라도 보여준다.
  return {
    text: hit.lineText,
    anchor: { start: hit.wordOffsetInLine, end: hit.wordOffsetInLine + hit.word.length },
    words: [],
    language: detectSubtitleLanguage(hit.lineText),
    source,
    extraction: 'direct',
  }
}

// 화면 자막 텍스트로 언어를 추정한다(자막엔 OCR OSD 를 못 쓰므로 유니코드 블록 휴리스틱).
function detectSubtitleLanguage(text: string): Language {
  if (/[぀-ヿ]/.test(text)) return 'ja' // 가나
  if (/[一-鿿]/.test(text)) {
    // 간체 전용 글자가 보이면 zh-Hans, 아니면 기본 zh-Hant(번체) — 정밀 판별은 추후.
    return /[们么这来国对时会说无个开关问题东买卖车马语门]/.test(text) ? 'zh-Hans' : 'zh-Hant'
  }
  return 'en'
}

// 전체 자막 cue 들을 이어 붙여 팝업용 text 를 만들고, 클릭 단어의 offset(anchor)을 찾는다.
function anchorInTranscript(
  cues: { start: number; text: string }[],
  currentTime: number,
  currentLine: string,
  wordText: string,
  wordOffsetInLine: number,
): { text: string; start: number; end: number } | null {
  // 각 cue 를 줄바꿈으로 이어 붙이며 시작 offset 을 기록.
  const offsets: number[] = []
  let full = ''
  for (let i = 0; i < cues.length; i++) {
    offsets[i] = full.length
    full += cues[i].text
    if (i < cues.length - 1) full += '\n'
  }

  // 현재 재생 시각이 속한(또는 직전) cue.
  let idx = -1
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= currentTime + 0.25) idx = i
    else break
  }
  if (idx < 0) idx = 0

  // cue 안에서 클릭 단어 위치: 화면 줄이 cue 안 어디에 있는지 먼저 찾고 그 안의 단어 offset 을 더한다.
  const cueText = cues[idx].text
  let inCue: number
  const lineBase = currentLine ? cueText.indexOf(currentLine) : -1
  if (lineBase >= 0) {
    inCue = lineBase + wordOffsetInLine
  } else {
    const wi = cueText.indexOf(wordText)
    inCue = wi >= 0 ? wi : 0
  }
  const start = offsets[idx] + Math.min(inCue, cueText.length)
  const end = Math.min(start + wordText.length, offsets[idx] + cueText.length)
  return { text: full, start, end }
}
