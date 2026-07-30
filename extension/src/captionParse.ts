// 담당 B — 유튜브/넷플릭스 자막 응답 파서(포맷 무관 공용). InnerTube get_transcript 응답,
// 네트워크 가로채기(networkHook.ts)로 잡은 유튜브 자막, 넷플릭스 WebVTT(netflixNetworkHook.ts
// 로 확보한 다운로드 URL을 fetch한 결과)를 같은 로직으로 해석한다.
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

// TTML(dfxp) 타이밍 값 파싱 — tick("12345678t", ttp:tickRate 기준), 초("1.5s"),
// 밀리초("1500ms"), 시계 표기("00:00:01.500")를 모두 받는다.
function parseTtmlTime(v: string | null, tickRate: number): number | null {
  if (!v) return null
  const ticks = /^(\d+)t$/.exec(v)
  if (ticks) return Number(ticks[1]) / tickRate
  const secs = /^([\d.]+)s$/.exec(v)
  if (secs) return Number(secs[1])
  const ms = /^([\d.]+)ms$/.exec(v)
  if (ms) return Number(ms[1]) / 1000
  const clock = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(v)
  if (clock) {
    const frac = clock[4] ? Number(`0.${clock[4]}`) : 0
    return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) + frac
  }
  return null
}

// 넷플릭스 자막 파일 포맷 — TTML(Timed Text Markup Language, 넷플릭스는 dfxp 프로파일 +
// nttm: 자체 네임스페이스 확장). 타이밍은 보통 tick 단위(ttp:tickRate="10000000")로 온다.
// <p begin="..." end="...">텍스트<br/>텍스트</p> 구조 — <br/>은 공백으로 바꿔 이어붙인다.
export function parseTtml(text: string): TranscriptCue[] {
  if (typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(text.replace(/<br\s*\/?>/gi, ' '), 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return []
  const root = doc.documentElement
  if (!root || root.localName !== 'tt') return []
  const rawRate = root.getAttribute('ttp:tickRate') ?? root.getAttribute('tickRate')
  const tickRate = Number(rawRate) || 10_000_000
  const cues: TranscriptCue[] = []
  for (const p of Array.from(doc.getElementsByTagName('p'))) {
    const start = parseTtmlTime(p.getAttribute('begin'), tickRate)
    if (start === null) continue
    const cueText = cleanCaptionText(p.textContent ?? '')
    if (!cueText) continue
    cues.push({ start, text: cueText })
  }
  return cues
}

function parseXml(text: string): TranscriptCue[] {
  if (typeof DOMParser === 'undefined') return [] // 안전망(서비스 워커 등 DOM 없는 컨텍스트)
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return []
  const srv3 = parseSrv3Xml(doc)
  if (srv3.length > 0) return srv3
  const srv1 = parseSrv1Xml(doc)
  if (srv1.length > 0) return srv1
  return parseTtml(text) // 넷플릭스 TTML(<p begin=...>) — srv3/srv1 과 태그가 겹쳐 마지막에 시도
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

// WebVTT/TTML 자막 텍스트 정리 — 태그 제거, WebVTT가 쓰는 HTML 엔티티 디코드, 방향 제어
// 문자 제거. 넷플릭스 자막은 `&lrm;`(LEFT-TO-RIGHT MARK) 같은 엔티티를 그대로 담아 보내서,
// 디코드를 안 하면 팝업에 "&lrm;"이 문자 그대로 노출된다(2026-07-29 실측).
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&lrm;': '', // U+200E LEFT-TO-RIGHT MARK — 화면엔 안 보이는 방향 제어라 제거
  '&rlm;': '', // U+200F RIGHT-TO-LEFT MARK — 동일
}
function cleanCaptionText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '') // <i>, <c.xxx>, <b> 등 서식 태그
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (e) => HTML_ENTITIES[e.toLowerCase()] ?? e)
    .replace(/[‎‏‪-‮]/g, '') // 방향 제어 문자(엔티티가 아닌 실제 문자로 온 경우)
    // 넷플릭스 자막 원문은 후리가나를 <rt>가 아니라 "漢字(かな)" 식 괄호 표기로 텍스트에
    // 직접 박아 보낸다(화면엔 루비로 렌더되지만 자막 파일 자체엔 괄호 그대로 들어있음,
    // 2026-07-29 실측 — 예: "篤(あつ)くて"). 한자 뒤에 바로 붙은, 내용이 가나뿐인 괄호만
    // 후리가나로 보고 제거한다(한자는 남김).
    .replace(/([一-鿿々]+)\(([぀-ヿー]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// 넷플릭스 자막(webvtt-lssdh-ios8 프로파일) 파서. 표준 WebVTT — cue 타임코드 줄 다음에
// 오는 빈 줄 전까지를 cue 텍스트로 본다. 화면 태그(<i>, <c.xxx> 등)와 위치 지정 cue
// setting은 무시하고 텍스트만 취한다. 타임코드는 HH:MM:SS.mmm 과 MM:SS.mmm(시간 생략) 둘 다 허용.
const VTT_TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->/
export function parseWebVtt(text: string): TranscriptCue[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const cues: TranscriptCue[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i]?.match(VTT_TIME_RE)
    if (!m) {
      i += 1
      continue
    }
    const hours = m[1] ? Number(m[1]) : 0
    const start = hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
    i += 1
    const textLines: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '') {
      textLines.push(lines[i]!)
      i += 1
    }
    const cueText = cleanCaptionText(textLines.join(' '))
    if (cueText) cues.push({ start, text: cueText })
  }
  return cues
}
