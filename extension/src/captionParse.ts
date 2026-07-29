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

// 어떤 포맷인지 모르는 캡처된 응답 본문(text)을 JSON 파싱 후 두 포맷 다 시도해본다.
export function parseAnyCaptionPayload(text: string): TranscriptCue[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const innertube = parseInnertubeTranscript(data)
  if (innertube.length > 0) return innertube
  return parseJson3(data)
}
