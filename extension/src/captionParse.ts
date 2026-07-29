// 담당 B — 유튜브 자막 응답 파서(포맷 무관 공용). InnerTube get_transcript 응답과, 네트워크
// 가로채기(networkHook.ts)로 잡은 임의의 자막 응답 payload를 같은 로직으로 해석한다.
import type { TranscriptCue } from './timedtext'

function dig(obj: unknown, path: (string | number)[]): unknown {
  let cur = obj
  for (const key of path) {
    if (cur == null) return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

// InnerTube get_transcript 응답(2023+ 포맷): actions[0].updateEngagementPanelAction.content
//   .transcriptRenderer.content.transcriptSearchPanelRenderer.body
//   .transcriptSegmentListRenderer.initialSegments[].transcriptSegmentRenderer.{startMs, snippet.runs[].text}
export function parseInnertubeTranscript(data: unknown): TranscriptCue[] {
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

// 구식 timedtext json3 포맷: { events: [{ tStartMs, segs: [{ utf8 }] }] }
interface Json3Event {
  tStartMs?: number
  segs?: { utf8?: string }[]
}
export function parseJson3(data: unknown): TranscriptCue[] {
  const events = (data as { events?: Json3Event[] })?.events
  if (!Array.isArray(events)) return []
  const cues: TranscriptCue[] = []
  for (const ev of events) {
    if (ev.tStartMs === undefined || !ev.segs) continue
    const text = ev.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    cues.push({ start: ev.tStartMs / 1000, text })
  }
  return cues
}

// srv3 포맷(유튜브 플레이어 자신이 실제로 받는 기본 포맷 — fmt=json3 를 우리가 붙이지
// 않는 한 XML로 온다): <timedtext format="3"><body><p t="ms" d="ms">word<s t="ms"> word</s>...</p></body></timedtext>
// <p> 하위의 텍스트(자신+<s> 자식들)를 이어 붙이면 그 큐의 전체 텍스트가 된다(카라오케용
// 단어별 타이밍(<s t=".."/>)은 무시하고 큐 단위 start/text만 취한다).
function parseSrv3Xml(doc: Document): TranscriptCue[] {
  const ps = Array.from(doc.getElementsByTagName('p'))
  const cues: TranscriptCue[] = []
  for (const p of ps) {
    const startMs = Number(p.getAttribute('t') ?? '')
    if (!Number.isFinite(startMs)) continue
    const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    cues.push({ start: startMs / 1000, text })
  }
  return cues
}

// srv1 포맷(구식): <transcript><text start="0.34" dur="4.3">...</text>...</transcript>
function parseSrv1Xml(doc: Document): TranscriptCue[] {
  const texts = Array.from(doc.getElementsByTagName('text'))
  const cues: TranscriptCue[] = []
  for (const t of texts) {
    const start = Number(t.getAttribute('start') ?? '')
    if (!Number.isFinite(start)) continue
    const text = (t.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    cues.push({ start, text })
  }
  return cues
}

function parseXml(text: string): TranscriptCue[] {
  if (typeof DOMParser === 'undefined') return [] // 안전망(서비스 워커 등 DOM 없는 컨텍스트)
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return []
  const srv3 = parseSrv3Xml(doc)
  if (srv3.length > 0) return srv3
  return parseSrv1Xml(doc)
}

// 어떤 포맷인지 모르는 캡처된 응답 본문(text)을 파싱한다. 유튜브 플레이어 자신의 실제
// timedtext 요청은 보통 XML(srv3, 드물게 srv1)로 오고, 우리가 InnerTube에 직접 물어본
// get_transcript 응답만 JSON이라 둘 다 시도한다.
export function parseAnyCaptionPayload(text: string): TranscriptCue[] {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) return parseXml(text)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return parseXml(text) // JSON도 아니고 '<' 로 시작 안 해도(BOM 등) 마지막으로 XML 시도
  }
  const innertube = parseInnertubeTranscript(data)
  if (innertube.length > 0) return innertube
  const json3 = parseJson3(data)
  if (json3.length > 0) return json3
  return parseXml(text)
}
