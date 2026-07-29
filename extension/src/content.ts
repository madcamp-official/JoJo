// 담당 B — 확장 content script.
// 유튜브/넷플릭스 화면 자막을 단어별 좌표와 함께 추출해(youtube.ts/netflix.ts) background 로
// 보낸다. background 가 WS 로 앱에 중계한다. 자막 캡처는 앱이 선택 모드일 때만 켜진다(setCapture).
import { extractSubtitleSnapshot, isYoutubeWatch, observeSubtitles } from './youtube'
import { extractNetflixSnapshot, isNetflixWatch, observeNetflixSubtitles, currentNetflixMovieId } from './netflix'
import { videoCurrentTime } from './domWords'
import { currentVideoId } from './timedtext'
import { startHighlight, setWordSegments, type WordHit } from './highlight'
import { parseAnyCaptionPayload, parseWebVtt } from './captionParse'
import type { SubLine, SubtitleSnapshot, WordSegment } from '@shared/extension'

// content ↔ background 내부 메시지(확장 안에서만 씀).
type FromBackground =
  | { kind: 'setCapture'; active: boolean }
  | { kind: 'requestSnapshot' }
  | { kind: 'setPlayback'; play: boolean }
  | { kind: 'wordSegments'; lineText: string; words: WordSegment[] }

function setVideoPlayback(play: boolean): void {
  const v = document.querySelector<HTMLVideoElement>('video')
  if (!v) return
  if (play) void v.play().catch(() => {})
  else v.pause()
}

// 지금 이 탭이 지원 대상 사이트(유튜브/넷플릭스) 중 어느 쪽인지, 그 사이트 기준으로 화면
// 자막 프레임을 즉석 추출한다. 두 사이트가 동시에 열려 있을 순 없으므로(탭 하나) 배타적이다.
function activeSnapshot(): SubtitleSnapshot | null {
  if (isYoutubeWatch()) return extractSubtitleSnapshot()
  if (isNetflixWatch()) return extractNetflixSnapshot()
  return null
}

let capturing = false
let stopObserving: (() => void) | null = null
let stopHighlightUi: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastSent = ''

// hover/클릭 판정용 자막 줄+좌표를 그 순간 즉석에서 다시 측정한다(캐시 안 씀) — 컨트롤바
// 자동 표시/숨김으로 자막 위치가 바뀌어도(유튜브가 이때 childList/attribute 변화를 항상
// 안 내서 폴링 주기까지 지연될 수 있었음) getBoundingClientRect 기반이라 항상 최신이다.
function liveLines(): SubLine[] {
  return activeSnapshot()?.lines ?? []
}

function currentMediaId(): string | null {
  if (isYoutubeWatch()) return currentVideoId()
  if (isNetflixWatch()) return currentNetflixMovieId()
  return null
}

function onWordClicked(hit: WordHit): void {
  chrome.runtime.sendMessage({
    kind: 'subtitleClick',
    word: hit.text,
    lineText: hit.lineText,
    wordOffsetInLine: hit.wordOffsetInLine,
    currentTime: videoCurrentTime(),
    videoId: currentMediaId(),
  })
}

// 페이지 메인 JS 세계(networkHook.ts, manifest.json "world":"MAIN")가 가로챈 유튜브 자막
// 관련 네트워크 응답을 postMessage로 받는다. 플레이어 자신의 실제 timedtext 요청을 엿듣는
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

// ── 넷플릭스 전체 자막(매니페스트 가로채기) ─────────────────────────────────
// netflixNetworkHook.ts(MAIN 월드)가 JSON.parse 후킹으로 매니페스트의 timedtexttracks를
// postMessage로 넘겨준다. 여기서 화면에 뜬 자막 언어와 맞는 트랙을 골라 WebVTT 다운로드
// URL을 fetch(일반 CORS, MSL 암호화 안 걸림)해서 파싱한 뒤 유튜브와 같은 'transcript'
// 메시지로 앱에 보낸다 — 이후 흐름(anchorInTranscript 등)은 유튜브와 완전히 동일하다.
const WEBVTT_PROFILE = 'webvtt-lssdh-ios8'
// 넷플릭스 자막 다운로드 정보. downloadUrls(신) 와 urls(구) 두 형태 모두 실측됨(Language
// Reactor 코드 확인, 2026-07-29) — 어느 쪽이든 첫 URL을 쓴다.
interface NetflixDownloadable {
  downloadUrls?: Record<string, string>
  urls?: { url: string }[]
}
interface NetflixTrack {
  language?: string
  isNoneTrack?: boolean
  isForcedNarrative?: boolean
  rawTrackType?: string // 실측: 대문자 'SUBTITLES' / 'CLOSEDCAPTIONS'
  hydrated?: boolean
  ttDownloadables?: Record<string, NetflixDownloadable>
}

// movieId 만이 아니라 "movieId|언어" 단위로 확보 여부를 기억한다 — 같은 영상을 보다가
// 넷플릭스 자막 언어를 바꾸면(영어→일본어 등) 화면 자막 언어가 바뀌므로, movieId만 잠그면
// 재요청이 아예 안 돼 예전 언어 문맥이 계속 팝업에 뜬다(2026-07-29 사용자 제보). 매니페스트
// 는 이미 pendingNetflix.tracks 에 모든 언어 트랙이 다 들어있으므로, 언어가 바뀐 걸
// 감지하면 새 네트워크 요청 없이(캐시된 트랙 목록에서 다시 고르기만) 재확보한다.
let lastNetflixKey = ''
// 매니페스트로 받은 트랙 목록을 저장해뒀다가, 화면에 자막이 실제로 떠서 언어를 판정할 수
// 있을 때 그 언어에 맞는 트랙을 골라 fetch 한다 — 매니페스트는 재생 극초반(자막 아직 안
// 뜸)에 오므로, 그 시점에 언어를 정하면 화면 자막이 뭐든 항상 기본값(en)으로 잘못 고른다.
let pendingNetflix: { movieId: string; tracks: NetflixTrack[] } | null = null

// 화면 자막 텍스트로 언어를 대략 추정한다(subtitleSource.ts의 휴리스틱과 같은 목적) —
// 넷플릭스 트랙 language 코드와 매칭해 화면에 보이는 언어의 트랙을 고른다.
function detectDomLanguagePrefix(text: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja'
  if (/[一-鿿]/.test(text)) return 'zh'
  if (/[가-힣]/.test(text)) return 'ko'
  return 'en'
}

function trackWebvttUrl(t: NetflixTrack): string | undefined {
  const d = t.ttDownloadables?.[WEBVTT_PROFILE]
  if (!d) return undefined
  if (d.downloadUrls) return Object.values(d.downloadUrls)[0]
  if (d.urls && d.urls.length) return d.urls[0]!.url
  return undefined
}

function pickNetflixTrack(tracks: NetflixTrack[], domText: string): NetflixTrack | null {
  // rawTrackType 은 대소문자가 포맷에 따라 달라(SUBTITLES/subtitles) 소문자로 맞춰 비교하고,
  // 강제 자막(isForcedNarrative)·끄기 트랙(isNoneTrack)은 제외한다. 실제 다운로드 URL이
  // 있는(=hydrated) 트랙만 후보로 본다.
  const candidates = tracks.filter((t) => {
    if (t.isNoneTrack || t.isForcedNarrative) return false
    const type = (t.rawTrackType ?? '').toLowerCase()
    if (type !== 'subtitles' && type !== 'closedcaptions') return false
    return !!trackWebvttUrl(t)
  })
  if (candidates.length === 0) return null
  // 화면에 보이는 자막 언어와 맞는 트랙을 우선한다 — 매칭 실패 시에만 첫 트랙으로 폴백.
  const prefix = detectDomLanguagePrefix(domText)
  return candidates.find((t) => t.language?.startsWith(prefix)) ?? candidates[0]!
}

// pendingNetflix(매니페스트)가 있고 화면에 자막이 떠 있으면, 그 언어로 트랙을 골라 확보한다.
// 화면 자막이 아직 없으면(재생 초반) 언어 판정을 못 하니 다음 스냅샷에서 재시도한다.
// movieId 뿐 아니라 화면 자막 언어까지 키에 넣어서, 같은 영상에서 자막 언어를 바꾸면
// (캐시된 매니페스트 안에서) 새 언어 트랙으로 다시 확보하도록 한다.
function maybeFetchNetflixTranscript(): void {
  const p = pendingNetflix
  if (!p) return
  const domText = extractNetflixSnapshot()?.lines.map((l) => l.text).join(' ') ?? ''
  if (!domText.trim()) return // 화면 자막이 아직 없음 — 언어 판정 불가, 다음 프레임 대기
  const key = `${p.movieId}|${detectDomLanguagePrefix(domText)}`
  if (key === lastNetflixKey) return
  void fetchNetflixTranscript(p.movieId, p.tracks, domText, key)
}

async function fetchNetflixTranscript(
  movieId: string,
  tracks: NetflixTrack[],
  domText: string,
  key: string,
): Promise<void> {
  const track = pickNetflixTrack(tracks, domText)
  const url = track ? trackWebvttUrl(track) : undefined
  if (!url) {
    const withUrl = tracks.filter((t) => !!trackWebvttUrl(t)).length
    console.log(
      `[nuance content] 넷플릭스 webvtt 트랙 선택 실패(tracks=${tracks.length}, url보유=${withUrl}) — 다음 매니페스트 대기`,
    )
    return
  }
  try {
    const res = await fetch(url)
    const text = await res.text()
    const cues = parseWebVtt(text)
    if (cues.length === 0) {
      console.log('[nuance content] 넷플릭스 WebVTT 파싱 결과 0 cues')
      return
    }
    lastNetflixKey = key // 성공했을 때만 잠가 같은 영화·언어 조합의 재시도를 막는다.
    console.log(`[nuance content] 넷플릭스 매니페스트로 자막 확보: ${cues.length} cues (lang=${track?.language})`)
    chrome.runtime.sendMessage({ kind: 'transcript', videoId: movieId, cues })
  } catch (err) {
    console.log('[nuance content] 넷플릭스 WebVTT fetch 실패:', (err as Error)?.message)
  }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return
  const data = ev.data as { source?: string; kind?: string; movieId?: string; tracks?: NetflixTrack[] } | undefined
  if (!data || data.source !== 'nuance-mainworld' || data.kind !== 'netflixManifest') return
  if (!data.movieId || !data.tracks) return
  console.log(`[nuance content] 넷플릭스 매니페스트 수신: movieId=${data.movieId} tracks=${data.tracks.length}`)
  // 즉시 fetch 하지 않고 저장만 — 화면 자막이 떠서 언어를 판정할 수 있을 때(pushSnapshot →
  // maybeFetchNetflixTranscript) 그 언어로 트랙을 골라 확보한다.
  pendingNetflix = { movieId: data.movieId, tracks: data.tracks }
  maybeFetchNetflixTranscript()
})

// 선택 모드에 들어가기 전(capturing=false)이어도, 유튜브/넷플릭스 영상 탭에 있는 동안은
// 백그라운드에서 계속 전체 자막 확보를 미리 시도해둔다(사용자 요청, 2026-07-29 — "새로고침
// 안 해도 알아서 미리 받아올 수 없냐") — 그래야 나중에 실제로 선택 모드에 들어가 클릭할
// 때는 이미 도착해 있을 확률이 훨씬 높아진다. 유튜브는 이 폴링이 필요 없다 — 네트워크
// 가로채기(`networkHook.ts`)가 capturing 여부와 무관하게 이미 항상 켜져 있어서 별도
// 트리거가 없어도 된다.
//
// **성능 버그 수정(2026-07-29, "팝업이 다시 느려졌다" 제보)**: `maybeFetchNetflixTranscript`
// 는 `lastNetflixKey` 로 "이미 확보했으면 스킵"하지만, 그 체크 전에 매번
// `extractNetflixSnapshot()`(DOM 순회 + `getClientRects()` layout 강제)을 먼저 돌려서
// domText 를 만들었다 — 이미 확보를 끝낸 뒤에도 이 비싼 스캔을 초당 한 번씩 무한히
// 반복하고 있었다. 이 패시브 폴링의 목적은 "선택 모드 진입 전 한 번 미리 받아두기"뿐이라,
// 이 영화(movieId)에 대해 이미 뭔가(어느 언어든) 확보돼 있으면 스캔 자체를 건너뛴다 —
// 활성 캡처(`pushSnapshot`, 선택 모드 중)는 이 가드 없이 그대로 매 틱 재확인해 자막 언어
// 전환도 계속 감지한다(기존 동작 그대로).
const PREFETCH_INTERVAL_MS = 1000
setInterval(() => {
  if (!isNetflixWatch()) return
  if (pendingNetflix && lastNetflixKey.startsWith(`${pendingNetflix.movieId}|`)) return
  maybeFetchNetflixTranscript()
}, PREFETCH_INTERVAL_MS)

function pushSnapshot(): void {
  if (!capturing) return
  const snapshot = activeSnapshot()
  // 넷플릭스: 화면 자막이 떴으면 그 언어로 전체 자막을 확보한다(매니페스트가 이미 저장돼
  // 있고 아직 이 영화 자막을 안 보냈을 때만 실제 fetch, 나머지는 즉시 반환이라 저렴).
  if (isNetflixWatch()) maybeFetchNetflixTranscript()
  // 동일 프레임 중복 전송 방지(디버그 로그용, 좌표+텍스트가 같으면 스킵). null 도 한 번만 보낸다.
  const sig = snapshot ? JSON.stringify(snapshot) : 'null'
  if (sig === lastSent) return
  lastSent = sig
  chrome.runtime.sendMessage({ kind: 'subtitles', snapshot })
}

// 캡처를 (재)시작할 때마다 전체 자막을 앱에 다시 확보시킨다 — MAIN world 훅들이 캐시해둔
// 마지막 응답(유튜브 requestLastCaption / 넷플릭스 requestNetflixManifest)을 재전송받는다.
// 자막 네트워크 응답은 보통 영상 로드 극초반(선택 모드 진입보다 훨씬 전)에 한 번만 오므로,
// 이 재전송이 없으면 새로고침 없이는 문맥을 영영 못 받는다(2026-07-29).
// **dedup 캐시도 여기서 반드시 리셋한다**: `lastInterceptedSig`(유튜브)/`lastNetflixKey`
// (넷플릭스)는 "이미 앱에 보냈으니 같은 걸 또 안 보낸다"는 표시인데, 앱이 재시작됐거나
// 선택 모드를 껐다 켠 경우 앱 쪽 상태는 그 사이 어떻게 됐는지 모른다 — 리셋 없이는 훅이
// 재전송해줘도 여기서 "이미 보냄"으로 삼켜 앱에 영영 안 넘어가는 구멍이 있었다(2026-07-29,
// "여전히 한 줄만" 재보고 후 발견).
function resyncTranscript(netflix: boolean): void {
  if (netflix) {
    lastNetflixKey = ''
    window.postMessage({ source: 'nuance-content', kind: 'requestNetflixManifest' }, '*')
  } else {
    lastInterceptedSig = ''
    window.postMessage({ source: 'nuance-content', kind: 'requestLastCaption' }, '*')
  }
}

function startCapture(): void {
  const netflix = isNetflixWatch()
  // 이미 캡처 중이어도(예: 앱 재시작 후 WS 재접속으로 setCapture 가 다시 옴) 전체 자막
  // 재확보는 다시 해준다 — 앱 쪽 캐시는 재시작으로 비어있을 수 있다.
  resyncTranscript(netflix)
  if (capturing) return
  capturing = true
  lastSent = ''
  const observe = netflix ? observeNetflixSubtitles : observeSubtitles
  stopObserving = observe(() => pushSnapshot())
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
    if (msg.active) startCapture()
    else stopCapture()
  } else if (msg?.kind === 'setPlayback') {
    setVideoPlayback(msg.play)
  } else if (msg?.kind === 'requestSnapshot') {
    // 최신 좌표+재생시간으로 한 프레임 즉시 반환(hover/클릭 직전 앱 요청용).
    sendResponse({ snapshot: activeSnapshot() })
    return true
  } else if (msg?.kind === 'wordSegments') {
    // 앱이 CJK 자막 줄을 형태소 분석한 결과 — hover 박스를 글자 단위가 아니라 단어
    // 단위로 묶는 데 쓴다(highlight.ts).
    setWordSegments(msg.lineText, msg.words)
  }
  return undefined
})
