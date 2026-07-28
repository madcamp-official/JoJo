// 담당 B — 유튜브 전체 자막(transcript) 로드.
// 화면 자막 DOM(youtube.ts)은 "지금 이 순간" 한 줄뿐이라, 클릭한 줄의 앞뒤 자막까지
// 팝업에 보여주려면 영상 전체의 타임코드 자막이 필요하다.
//
// 예전엔 ytInitialPlayerResponse 의 captionTracks.baseUrl(timedtext, json3)을 직접 호출했는데,
// 유튜브가 이 구식 엔드포인트를 최근 정책으로 막아(200 응답에 빈 바디만 줌 — 여러 오픈소스
// 자막 추출 라이브러리가 2024~2025년 사이 이 문제로 깨졌다) 더 이상 안정적으로 동작하지
// 않는다. 대신 유튜브 페이지 자체가 "스크립트 표시(Show transcript)" 패널에 쓰는 내부
// InnerTube `get_transcript` API(Language Reactor 등 현행 도구들이 쓰는 방식)를 그대로 쓴다.
// watch 페이지 HTML에서 그 패널의 continuation params 를 찾아 같은 오리진(www.youtube.com)
// 으로 POST 하면 되므로 CORS 문제도 없다.

export interface TranscriptCue {
  start: number // 초
  text: string
}

const cache = new Map<string, Promise<TranscriptCue[]>>()

export function currentVideoId(): string | null {
  const u = new URL(location.href)
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
  return m ? m[1] : null
}

// 화면 자막 텍스트의 스크립트로 언어 힌트를 잡는다(앱 지원 범위 en/ja/zh). get_transcript
// 는 기본 트랙(패널에 뜨는 트랙) 자막만 주므로 캐시 키에만 쓰고 트랙 선택엔 관여하지 않는다.
export function subtitleLangHint(text: string): string | null {
  if (/[぀-ヿ]/.test(text)) return 'ja'
  if (/[一-鿿]/.test(text)) return 'zh'
  if (/[A-Za-z]/.test(text)) return 'en'
  return null
}

export function loadTranscript(videoId: string, langHint: string | null): Promise<TranscriptCue[]> {
  const key = `${videoId}|${langHint ?? ''}`
  const cached = cache.get(key)
  if (cached) return cached
  const p = fetchTranscript(videoId).catch((err) => {
    cache.delete(key) // 실패는 캐시하지 않아 다음 시도에서 재요청
    throw err
  })
  cache.set(key, p)
  return p
}

async function fetchWatchHtml(videoId: string): Promise<string | null> {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'include',
  })
  console.log(`[nuance timedtext] watch fetch status=${res.status}`)
  if (!res.ok) return null
  return res.text()
}

async function fetchTranscript(videoId: string): Promise<TranscriptCue[]> {
  const html = await fetchWatchHtml(videoId)
  if (!html) return []
  const cues = await fetchViaInnertube(html)
  console.log(`[nuance timedtext] get_transcript cues=${cues.length}`)
  return cues
}

// 유튜브 웹 클라이언트 공개 API 키(비밀 키 아님, 클라이언트 식별용) — ytcfg 스크레이핑이
// 실패했을 때만 쓰는 폴백. 실제 요청은 아래에서 watch 페이지가 그 순간 쓰는 진짜 apiKey/
// context 를 그대로 긁어 보낸다 — 하드코딩된 clientVersion 은 유튜브 서버가 오래된
// 버전을 400으로 거부해(실측 확인) 더 이상 안정적이지 않다.
const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const FALLBACK_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } }

// watch 페이지 HTML에서 "스크립트 표시" 패널의 get_transcript continuation params(base64)를 찾는다.
function extractTranscriptParams(html: string): string | null {
  const m = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)
  return m ? m[1] : null
}

function extractApiKey(html: string): string | null {
  const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
  return m ? m[1] : null
}

// ytcfg.set({...}) 안의 INNERTUBE_CONTEXT 객체를 그대로 뽑는다 — clientVersion/hl/gl/
// visitorData 등이 지금 이 페이지 세션과 정확히 일치해야 서버가 400으로 거부하지 않는다.
function extractInnertubeContext(html: string): unknown | null {
  const marker = '"INNERTUBE_CONTEXT":'
  const idx = html.indexOf(marker)
  if (idx === -1) return null
  const braceStart = html.indexOf('{', idx + marker.length)
  if (braceStart === -1) return null
  const json = sliceBalancedJson(html, braceStart)
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

async function fetchViaInnertube(html: string): Promise<TranscriptCue[]> {
  const params = extractTranscriptParams(html)
  if (!params) {
    console.log('[nuance timedtext] get_transcript params 없음(자막 패널 없음 — 자막 트랙 자체가 없을 수 있음)')
    return []
  }
  const apiKey = extractApiKey(html) ?? FALLBACK_API_KEY
  const context = extractInnertubeContext(html) ?? FALLBACK_CONTEXT
  console.log(`[nuance timedtext] apiKey=${extractApiKey(html) ? 'scraped' : 'fallback'} context=${extractInnertubeContext(html) ? 'scraped' : 'fallback'}`)
  const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context, params }),
  })
  console.log(`[nuance timedtext] get_transcript status=${res.status}`)
  if (!res.ok) {
    console.log('[nuance timedtext] get_transcript 실패 응답:', (await res.text()).slice(0, 300))
    return []
  }
  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    console.log('[nuance timedtext] get_transcript JSON 파싱 실패:', (err as Error).message)
    return []
  }
  return parseTranscriptResponse(data)
}

// 응답 구조(2023+ 포맷): actions[0].updateEngagementPanelAction.content.transcriptRenderer
//   .content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments[]
//   각 원소: transcriptSegmentRenderer.{ startMs, snippet.runs[].text }
function parseTranscriptResponse(data: unknown): TranscriptCue[] {
  const segments = dig(data, [
    'actions',
    0,
    'updateEngagementPanelAction',
    'content',
    'transcriptRenderer',
    'content',
    'transcriptSearchPanelRenderer',
    'body',
    'transcriptSegmentListRenderer',
    'initialSegments',
  ])
  if (!Array.isArray(segments)) return []
  const cues: TranscriptCue[] = []
  for (const seg of segments) {
    const r = (seg as Record<string, unknown>)?.transcriptSegmentRenderer as
      | { startMs?: string; snippet?: { runs?: { text?: string }[] } }
      | undefined
    if (!r) continue
    const text = (r.snippet?.runs ?? [])
      .map((run) => run.text ?? '')
      .join('')
      .trim()
    if (!text) continue
    cues.push({ start: Number(r.startMs ?? 0) / 1000, text })
  }
  return cues
}

function dig(obj: unknown, path: (string | number)[]): unknown {
  let cur = obj
  for (const key of path) {
    if (cur == null) return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
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
