// 담당 B — 유튜브 timedtext 전체 자막 버퍼 (앞뒤 범위 문맥용).
// 화면 자막 DOM(youtube.ts)은 "지금 이 순간" 한 줄뿐이라, 클릭한 줄의 앞뒤 자막까지
// 팝업에 보여주려면 전체 타임코드 자막이 필요하다. Language Reactor 와 동일하게
// watch 페이지 HTML 의 ytInitialPlayerResponse 에서 자막 트랙 URL 을 얻어 timedtext(json3)
// 를 받아 캐시한다. content script 는 페이지와 동일 출처라 쿠키 포함 fetch 가 가능하다.

export interface TranscriptCue {
  start: number // 초
  end: number
  text: string
}

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string // 'asr' = 자동 생성 자막
}

const cache = new Map<string, Promise<TranscriptCue[]>>()

export function currentVideoId(): string | null {
  const u = new URL(location.href)
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
  return m ? m[1] : null
}

export function loadTranscript(videoId: string): Promise<TranscriptCue[]> {
  const cached = cache.get(videoId)
  if (cached) return cached
  const p = fetchTranscript(videoId).catch((err) => {
    cache.delete(videoId) // 실패는 캐시하지 않아 다음 시도에서 재요청
    throw err
  })
  cache.set(videoId, p)
  return p
}

async function fetchTranscript(videoId: string): Promise<TranscriptCue[]> {
  const tracks = await fetchCaptionTracks(videoId)
  if (tracks.length === 0) return []
  const track = pickOriginalTrack(tracks)
  const url = new URL(track.baseUrl)
  url.searchParams.set('fmt', 'json3')
  const res = await fetch(url.toString(), { credentials: 'include' })
  if (!res.ok) return []
  const data = (await res.json()) as { events?: TimedTextEvent[] }
  return parseJson3(data.events ?? [])
}

interface TimedTextEvent {
  tStartMs?: number
  dDurationMs?: number
  segs?: { utf8?: string }[]
}

function parseJson3(events: TimedTextEvent[]): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  for (const ev of events) {
    if (ev.tStartMs === undefined || !ev.segs) continue
    const text = ev.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const start = ev.tStartMs / 1000
    const end = start + (ev.dDurationMs ?? 0) / 1000
    cues.push({ start, end, text })
  }
  return cues
}

// watch 페이지 HTML 에서 ytInitialPlayerResponse 를 뽑아 captionTracks 를 얻는다.
// SPA 네비게이션 후 DOM 의 초기 스크립트는 낡을 수 있어, videoId 로 직접 fetch 한다.
async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'include',
  })
  if (!res.ok) return []
  const html = await res.text()
  const player = extractPlayerResponse(html)
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  return Array.isArray(tracks) ? tracks : []
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[]
      audioTracks?: { defaultCaptionTrackIndices?: number[] }[]
    }
  }
}

function extractPlayerResponse(html: string): PlayerResponse | null {
  const marker = 'ytInitialPlayerResponse'
  const idx = html.indexOf(marker)
  if (idx === -1) return null
  const braceStart = html.indexOf('{', idx)
  if (braceStart === -1) return null
  const json = sliceBalancedJson(html, braceStart)
  if (!json) return null
  try {
    return JSON.parse(json) as PlayerResponse
  } catch {
    return null
  }
}

// 문자열/이스케이프를 인식하며 균형 잡힌 { ... } 한 덩어리를 잘라낸다.
function sliceBalancedJson(s: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

// 원어(비번역) 트랙을 고른다. 번역 트랙은 baseUrl 에 tlang 이 붙는데 여기 목록엔 원본만
// 있으므로, 수동 자막(kind!=='asr')을 우선하고 없으면 자동 생성 자막을 쓴다.
function pickOriginalTrack(tracks: CaptionTrack[]): CaptionTrack {
  return tracks.find((t) => t.kind !== 'asr') ?? tracks[0]
}

// 현재 재생 위치 기준 앞/뒤 자막을 모은다.
export function surroundingCues(
  cues: TranscriptCue[],
  currentTime: number,
  before: number,
  after: number,
): { before: string[]; current: string | null; after: string[] } {
  if (cues.length === 0) return { before: [], current: null, after: [] }
  // 현재 시간이 속한(또는 직전) cue 인덱스를 찾는다.
  let idx = -1
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= currentTime + 0.25) idx = i
    else break
  }
  if (idx === -1) idx = 0
  const beforeLines = cues.slice(Math.max(0, idx - before), idx).map((c) => c.text)
  const afterLines = cues.slice(idx + 1, idx + 1 + after).map((c) => c.text)
  return { before: beforeLines, current: cues[idx]?.text ?? null, after: afterLines }
}
