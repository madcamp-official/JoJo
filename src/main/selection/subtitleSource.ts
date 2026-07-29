import { Notification } from 'electron'
import type { ExtractedSelection } from '@shared/types'
import { endsWithSentenceEnder } from '@shared/context'
import { detectSupportedLanguage } from '@shared/languageDetect'
import { extensionBridge, type Transcript } from '../extension/bridge'
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
  const handler = (hit: SubtitleClickHit): void => void onSubtitleClick(hit)
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

// 선택 모드 진입 직후 첫 클릭은, 진짜 전체 자막(transcript)이 아직 도착하기 전일 수 있다
// — 넷플릭스는 캡처를 켤 때 매니페스트 재요청→WebVTT fetch(비동기 네트워크 왕복)로 전체
// 자막을 새로 받아오고, 유튜브도 플레이어 자신의 timedtext 요청이 확장→백그라운드→WS로
// 릴레이되는 데 약간의 시간이 걸린다. 이 사이에 클릭하면 transcript.videoId 가 아직
// null/이전 값이라 "화면 자막 한 줄만" 으로 폴백해버린다(실사용 확인, 2026-07-29) — 팝업을
// 열기 전 짧게(최대 TRANSCRIPT_WAIT_MS) 일치하는 transcript 가 도착하는지 기다려본다.
// 이미 도착해 있으면 대기 없이 즉시 진행되고, 끝내 안 오면 기존처럼 한 줄 폴백으로 연다.
// **800ms 로는 부족함을 실사용 로그로 확인(2026-07-29)** — 탭 전환 직후 첫 클릭은 거의
// 항상 이 타임아웃 안에 못 들어와 한 줄로 뜨고, 그 직후(로그상 짧으면 수백 ms~1초 남짓)
// transcript 가 도착해 "두 번째 클릭부터는 정상"이 되는 패턴이 반복 확인됨 — 탭 활성화
// →재요청(postMessage)→네트워크 fetch→content→background(서비스 워커 깨우기 포함)→WS
// 릴레이까지 홉이 많아 800ms 로는 못 따라갔다. 2500ms 로 늘림 — 이미 도착해 있으면 여전히
// 대기 없이 즉시 열리므로(위 얼리 리턴), 일반적인 클릭엔 영향 없고 "막 전환한 직후 첫
// 클릭"처럼 정말 기다려야 하는 경우에만 최대 2.5초 더 기다린다.
const TRANSCRIPT_WAIT_MS = 2500

// 어떤 이유로든(자막 자체가 없는 영상, 계속 실패하는 네트워크 등) 끝내 안 오는 videoId는
// 클릭할 때마다 매번 2.5초를 기다리게 되면 "팝업이 갑자기 확 느려졌다"처럼 느껴진다
// (실사용 확인, 2026-07-29) — 한 번 타임아웃까지 다 기다려본 videoId는 표시해두고, 그
// 다음부터는 대기 없이 바로(기존처럼 한 줄 폴백으로) 열리게 한다. 이후 배경에서 그
// videoId의 transcript가 뒤늦게 도착하면(리스너는 계속 살아있음, bridge.ts) 정상적으로
// 캐시되므로 다음 클릭부터는 이 표시와 무관하게 바로 매칭되어 문맥이 뜬다.
const timedOutVideoIds = new Set<string>()

function waitForMatchingTranscript(videoId: string | null): Promise<void> {
  if (!videoId) return Promise.resolve()
  const current = extensionBridge.getTranscript(videoId)
  if (current && current.cues.length > 0) return Promise.resolve()
  if (timedOutVideoIds.has(videoId)) return Promise.resolve()
  return new Promise((resolve) => {
    const onTranscript = (t: Transcript): void => {
      if (t.videoId !== videoId || t.cues.length === 0) return
      clearTimeout(timer)
      extensionBridge.off('transcript', onTranscript)
      resolve()
    }
    const timer = setTimeout(() => {
      extensionBridge.off('transcript', onTranscript)
      timedOutVideoIds.add(videoId)
      resolve()
    }, TRANSCRIPT_WAIT_MS)
    extensionBridge.on('transcript', onTranscript)
  })
}

// tier3(감지는 되거나 아예 안 되거나 상관없이 앱이 대응 못 하는 언어) 클릭 시 팝업 대신
// 짧은 OS 알림만 띄운다(2026-07-30, 사용자 결정 — "짧은 토스트만"). 기존 배너/오버레이
// 인프라는 이 용도로 안 맞아서(선택 모드 진입 배너는 계속 떠 있는 상태용) 새로 만들지 않고
// Electron 기본 Notification을 그대로 씀.
function notifyUnsupportedLanguage(): void {
  new Notification({ title: 'Nuance', body: '이 언어는 아직 지원하지 않습니다.' }).show()
}

async function onSubtitleClick(hit: SubtitleClickHit): Promise<void> {
  await waitForMatchingTranscript(hit.videoId)
  const selection = buildSelection(hit)
  if (selection === null) {
    notifyUnsupportedLanguage()
    return
  }
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

// null = tier3(미지원 언어) — 호출부가 팝업 대신 토스트로 처리한다.
function buildSelection(hit: SubtitleClickHit): ExtractedSelection | null {
  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }
  // videoId별 캐시(bridge.ts transcripts Map)라 탭/영상을 오가도 서로 덮어쓰지 않는다 —
  // 이 영상 것이 있으면 그대로 신뢰하면 된다(엉뚱한 영상 자막이 섞일 일 자체가 없음).
  const transcript = hit.videoId !== null ? extensionBridge.getTranscript(hit.videoId) : null

  // 전체 자막(timedtext)이 있으면 그걸 통째로 text 로 주고 anchor 만 클릭 단어에 맞춘다 —
  // 팝업이 설정 바이트(contextBytesBefore/After)만큼 앞뒤를 알아서 보여준다(OCR/텍스트와 동일).
  if (transcript && transcript.cues.length > 0) {
    // transcript.language 는 bridge.ts 가 전체 cue를 이어붙인 텍스트로 이미 1회 판별해
    // 캐시해둔 값이다(자막 줄 하나보다 훨씬 큰 표본이라 더 정확, 클릭마다 재판별 불필요,
    // 2026-07-29). null이면 tier3 — 앵커 계산도 할 필요 없이 바로 미지원 처리한다.
    if (transcript.language === null) return null
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
        language: transcript.language,
        source,
        extraction: 'direct',
      }
    }
  }

  // 전체 자막이 아직 없으면(로드 전/트랙 없음) 현재 줄만이라도 보여준다 — 이 경우엔
  // 캐시된 language 가 없으니 그 줄만으로 판별한다.
  const language = detectSupportedLanguage(hit.lineText)
  if (language === null) return null
  return {
    text: hit.lineText,
    anchor: { start: hit.wordOffsetInLine, end: hit.wordOffsetInLine + hit.word.length },
    words: [],
    language,
    source,
    extraction: 'direct',
  }
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
  //
  // **시도했다 되돌림(2026-07-29)**: 유튜브 나레이션류 영상에서 문장 중간에 강제
  // 줄바꿈되는 문제(cue 컷이 문장 경계와 안 맞아 비율이 낮게 나와 "구두점 없음"으로
  // 오판)를 고치려고 "전체 텍스트 안 문장부호 밀도"로 바꿔봤는데, 그러면 정작 넷플릭스
  // 대사 자막처럼 cue(대사 한 마디)마다 "?"/"." 등으로 자주 끝나는 콘텐츠도 밀도가
  // 높게 나와 "나레이션"으로 오판, 원래 cue 단위로 줄바꿈되던 게 문장 단위로 죽 이어져
  // 버렸다(사용자 제보 — 중국어 대사 자막 스크린샷). 비율 기준으로 되돌리고, 나레이션
  // 케이스는 진단 로그로 원인을 다시 확인한 뒤 별도로 고친다(아래 콘솔 로그 참고).
  const PUNCTUATED_RATIO_THRESHOLD = 0.3
  const punctuatedCount = cues.filter((c) => endsWithSentenceEnder(c.text)).length
  const looksPunctuated = punctuatedCount / cues.length >= PUNCTUATED_RATIO_THRESHOLD
  // 임시 진단 로그(2026-07-29, 나레이션류 오판 원인 재확인용) — 자막 원문은 안 찍고
  // 구조적 통계만 남긴다.
  console.log(
    `[subtitleSource] cues=${cues.length} punctuated=${punctuatedCount} ratio=${(punctuatedCount / cues.length).toFixed(2)} looksPunctuated=${looksPunctuated}`,
  )
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
