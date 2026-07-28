// 담당 B — 유튜브 <video> 요소의 native TextTrack에서 자막 큐를 직접 읽는다.
// 유튜브는 자체 DOM(.ytp-caption-segment)으로 화면에 자막을 그리지만, 그 데이터 원본은
// <video> 태그 안의 <track kind="captions"> 로도 함께 존재한다(브라우저가 자동 로드).
// 이걸 읽으면 네트워크 요청을 우리가 전혀 만들지 않고 유튜브가 이미 로드해놓은 전체
// 자막을 그대로 얻을 수 있어, InnerTube 비공개 API(세션/토큰 요구사항이 계속 바뀌어
// 깨지기 쉬움)보다 훨씬 안정적이다.
import type { TranscriptCue } from './timedtext'

function findVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video.html5-main-video, video')
}

function pickTrack(tracks: TextTrackList, langHint: string | null): TextTrack | null {
  const list = Array.from(tracks)
  if (list.length === 0) return null
  if (langHint) {
    const match = list.find((t) => (t.language || '').toLowerCase().startsWith(langHint))
    if (match) return match
  }
  return list[0]
}

function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// track.cues 는 mode 가 'disabled' 면 브라우저가 채우지 않고, 로드 자체도 비동기라 바로
// 안 채워져 있을 수 있다 — mode 를 켜고 잠깐 폴링해서 기다린다.
async function waitForCues(track: TextTrack, timeoutMs = 2000): Promise<TextTrackCueList | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (track.cues && track.cues.length > 0) return track.cues
    await new Promise((r) => setTimeout(r, 100))
  }
  return track.cues && track.cues.length > 0 ? track.cues : null
}

export async function loadTranscriptFromVideoTrack(langHint: string | null): Promise<TranscriptCue[]> {
  const video = findVideo()
  if (!video) {
    console.log('[nuance nativeTrack] video 요소 없음')
    return []
  }
  const tracks = video.textTracks
  console.log(
    `[nuance nativeTrack] textTracks=${tracks.length}`,
    Array.from(tracks)
      .map((t) => `${t.language || '?'}(${t.kind})`)
      .join(','),
  )
  const track = pickTrack(tracks, langHint)
  if (!track) return []

  const prevMode = track.mode
  // 'hidden' = 큐는 채워지되 브라우저가 화면에 그리진 않음(우리가 이미 자체 렌더링 중이라
  // 'showing'까지 갈 필요 없음). 원래 상태로 나중에 복구한다.
  track.mode = 'hidden'
  const cueList = await waitForCues(track)
  track.mode = prevMode

  if (!cueList || cueList.length === 0) {
    console.log('[nuance nativeTrack] cues 비어있음(트랙은 있으나 로드 안 됨)')
    return []
  }
  const cues: TranscriptCue[] = []
  for (const c of Array.from(cueList)) {
    const text = stripMarkup((c as VTTCue).text ?? '')
    if (text) cues.push({ start: c.startTime, text })
  }
  console.log(`[nuance nativeTrack] cues=${cues.length}`)
  return cues
}
