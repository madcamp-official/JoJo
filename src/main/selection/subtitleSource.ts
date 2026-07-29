import type { ExtractedSelection, Language } from '@shared/types'
import { endsWithSentenceEnder } from '@shared/context'
import { extensionBridge } from '../extension/bridge'
import { getBrowserSource } from '../extension/activeTab'
import { createPopupWindow, sendOverlayWords } from '../windows'

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
  // 자막 경로는 OCR처럼 시간이 걸리지 않는다(확장이 이미 화면에 있는 자막을 즉시 씀) —
  // hover 하이라이트도 확장이 페이지 안에서 직접 그린다. 그런데 오버레이(Overlay.tsx)는
  // 선택 모드 진입 시 기본으로 "텍스트 추출 중…" 배너를 켜고 EXTRACTION_WORDS 가 와야
  // 끄는 구조라, 자막 경로에선 그 신호를 안 보내 배너가 계속 떠 있었다 — 빈 배열을 보내
  // 기존 배선을 그대로 재사용해 배너를 즉시 끈다(오버레이가 자체 하이라이트를 그리지
  // 않게 되는 효과도 겸함 — 자막은 확장이 그리므로 의도한 동작).
  sendOverlayWords([])
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
  videoId: string | null
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
      // 팝업이 떠 있는 동안 OS 포커스가 Electron으로 넘어갔다가, 닫혀도 브라우저 창으로
      // 자동으로 돌아온다는 보장이 없다(특히 macOS) — 명시적으로 캡처 중이던 탭/창에
      // 포커스를 되돌려 hover/클릭을 바로 이어갈 수 있게 한다.
      extensionBridge.focusTab()
    })
  }
}

function buildSelection(hit: SubtitleClickHit): ExtractedSelection {
  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }
  const transcript = extensionBridge.getTranscript()
  console.log(
    `[subtitleSource] click hit.videoId=${hit.videoId} transcript.videoId=${transcript?.videoId ?? 'null'} cues=${transcript?.cues.length ?? 'null'}`,
  )

  // 전체 자막(timedtext)이 있으면 그걸 통째로 text 로 주고 anchor 만 클릭 단어에 맞춘다 —
  // 팝업이 설정 바이트(contextBytesBefore/After)만큼 앞뒤를 알아서 보여준다(OCR/텍스트와 동일).
  // 선택 모드를 유지한 채 탭/사이트(또는 같은 사이트 안에서 영상)를 바꾸면, 새 영상의
  // transcript가 아직 도착하기 전(네트워크 가로채기는 비동기) 캐시엔 이전 영상 것이 그대로
  // 남아있다 — videoId가 일치할 때만 신뢰해서 엉뚱한(이전) 영상 자막이 문맥으로 새는 걸 막는다.
  if (transcript && hit.videoId !== null && transcript.videoId === hit.videoId && transcript.cues.length > 0) {
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
  // 각 cue 를 이어 붙이며 시작 offset 을 기록한다. 자막은 한 문장이 여러 cue(화면 줄)에
  // 걸쳐 나뉘는 경우가 흔해서(줄바꿈 위치가 문장 경계와 무관), 매 cue 뒤에 무조건 줄바꿈을
  // 넣으면 한 문장이 팝업에서 여러 줄로 쪼개져 보인다 — 직전 cue 가 문장 종결부호로 끝날
  // 때만 줄바꿈(새 문단)을 넣고, 그렇지 않으면 공백으로 이어 자연스럽게 흐르게 한다.
  //
  // 이 판단은 "문장부호가 하나라도 있는가"가 아니라 **비율**로 한다 — 넷플릭스 대사
  // 자막처럼 거의 모든 cue 에 문장부호가 없고 가끔 "…" 정도만 섞여 있으면(실측, 2026-07-29)
  // "하나라도 있으면"이라는 기준은 문장부호 판단을 쓰기로 결정해버려서, 문장부호 없는
  // 절대다수 cue 들이 전부 공백으로만 이어붙어 문단 하나가 되는 문제가 있었다. cue의
  // 상당수가 실제로 문장부호로 끝날 때만(=진짜 "구두점 있는 자막") 그 기준을 쓰고,
  // 그렇지 않으면(대부분 구두점 없는 대사 단위 자막) cue(화면 줄/대사) 단위로 줄바꿈한다.
  const PUNCTUATED_RATIO_THRESHOLD = 0.3
  const punctuatedCount = cues.filter((c) => endsWithSentenceEnder(c.text)).length
  const looksPunctuated = punctuatedCount / cues.length >= PUNCTUATED_RATIO_THRESHOLD
  const offsets: number[] = []
  let full = ''
  for (let i = 0; i < cues.length; i++) {
    offsets[i] = full.length
    full += cues[i].text
    if (i < cues.length - 1) {
      const breakHere = !looksPunctuated || endsWithSentenceEnder(cues[i].text)
      full += breakHere ? '\n' : ' '
    }
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
