// 담당 B — 유튜브 전체 자막(transcript) 확보.
// 화면 자막 DOM(youtube.ts)은 "지금 이 순간" 한 줄뿐이라, 클릭한 줄의 앞뒤 자막까지
// 팝업에 보여주려면 영상 전체의 타임코드 자막이 필요하다.
//
// native <video> TextTrack 읽기(실측: 유튜브는 자체 JS 렌더러로 자막을 그려서
// video.textTracks 가 항상 비어있음)와 InnerTube get_transcript 내부 API(실측: 세션
// 검증 FAILED_PRECONDITION 400 으로 항상 실패)를 둘 다 시도해봤으나 둘 다 죽은 경로라
// 폐기했다 — 실제로 자막을 확보하는 건 플레이어 자신의 실제 timedtext 요청을 가로채는
// networkHook.ts + content.ts 의 message 리스너뿐이다.

export interface TranscriptCue {
  start: number // 초
  text: string
}

export function currentVideoId(): string | null {
  const u = new URL(location.href)
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
  return m ? m[1] : null
}
