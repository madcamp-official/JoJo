// 담당 B — 넷플릭스 매니페스트 응답을 가로채 전체 자막(WebVTT) 다운로드 URL을 확보한다.
// 넷플릭스는 유튜브와 달리 플레이어 매니페스트 요청/응답이 MSL로 암호화돼 있어 fetch/XHR을
// 패치해도(networkHook.ts 방식) 평문을 못 본다 — 대신 넷플릭스 자신의 플레이어 코드가 이미
// 복호화한 뒤 호출하는 JSON.parse 를 후킹하면 평문 객체를 그대로 받을 수 있다.
// 자막 파일 자체(webvtt)는 CDN에서 평문으로 오므로 이 URL만 확보하면 일반 fetch로 받는다.
// 이 스크립트는 manifest.json 에 "world":"MAIN"으로 등록해 페이지와 같은 JS 세계에서
// 실행한다(MAIN 월드는 chrome.runtime 을 못 써 postMessage 로 content.ts에 전달).
//
// **필드명 신/구 포맷(2026-07-29 실측)**: 예전 넷플릭스는 매니페스트에 `result.timedtexttracks`
// (트랙마다 `ttDownloadables`)를 실어 보냈지만, 지금은 `result.textTracks`(트랙마다
// `downloadables`)로 이름이 바뀌었다. 옛 이름만 보고 있어서 가로채기가 한 번도 성공하지
// 못했다 — 두 포맷을 모두 받아 구포맷 모양으로 정규화해 content.ts 로 넘긴다.
// 또 요청 쪽(JSON.stringify)에도 webvtt 프로파일뿐 아니라 showAllSubDubTracks/
// supportsPartialHydration 을 함께 켜줘야 자막 트랙이 "hydrated"(다운로드 URL 포함) 상태로
// 응답에 담긴다.
;(function () {
  const WEBVTT_PROFILE = 'webvtt-lssdh-ios8'
  console.log('[nuance netflixHook] 훅 등록됨 (MAIN world)')

  const origParse = JSON.parse
  const origStringify = JSON.stringify

  // 마지막으로 확보한 매니페스트를 캐시한다 — content script(isolated world)가 우리 훅보다
  // 늦게 캡처를 시작하면(선택 모드 진입 시점) 이미 postMessage 가 지나가 못 받는데, 캡처를
  // 켤 때 재전송을 요청하면 여기 캐시로 즉시 되돌려준다(새로고침 없이 문맥 확보).
  let lastManifest: { movieId: string; tracks: unknown } | null = null

  function post(movieId: string, tracks: unknown): void {
    lastManifest = { movieId, tracks }
    window.postMessage({ source: 'nuance-mainworld', kind: 'netflixManifest', movieId, tracks }, '*')
  }

  // content script 가 캡처 시작 시 캐시된 매니페스트 재전송을 요청한다.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return
    const d = ev.data as { source?: string; kind?: string } | undefined
    if (d?.source !== 'nuance-content' || d.kind !== 'requestNetflixManifest') return
    if (lastManifest) {
      console.log('[nuance netflixHook] 캐시된 매니페스트 재전송')
      window.postMessage(
        { source: 'nuance-mainworld', kind: 'netflixManifest', movieId: lastManifest.movieId, tracks: lastManifest.tracks },
        '*',
      )
    }
  })

  // 신포맷(textTracks/downloadables)을 구포맷(timedtexttracks/ttDownloadables) 모양으로 맞춘다.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function normalizeTracks(result: any): unknown[] | null {
    if (Array.isArray(result.timedtexttracks)) return result.timedtexttracks
    if (!Array.isArray(result.textTracks)) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.textTracks.map((t: any) => ({
      ...t,
      ttDownloadables: t.ttDownloadables ?? t.downloadables ?? {},
    }))
  }

  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown): unknown => {
    const data = origParse(text, reviver)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (data as any)?.result
      if (result && (result.timedtexttracks || result.textTracks)) {
        const tracks = normalizeTracks(result)
        if (tracks && result.movieId !== undefined) {
          console.log(`[nuance netflixHook] 매니페스트 확보 movieId=${result.movieId} tracks=${tracks.length}`)
          post(String(result.movieId), tracks)
        }
      }
    } catch (err) {
      console.log('[nuance netflixHook] JSON.parse 후킹 처리 중 오류:', (err as Error)?.message)
    }
    return data
  }) as typeof JSON.parse

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JSON.stringify = ((value: any, replacer?: any, space?: any): string => {
    try {
      if (value !== undefined) {
        // 넷플릭스 자신의 객체를 직접 변형하지 않도록 사본에만 주입한다.
        const copy = origParse(origStringify(value))
        const params = copy?.params
        let patched = false
        if (params) {
          // 부분 하이드레이션을 켜고 모든 자막/더빙 트랙을 요청해야, 응답 트랙에 실제
          // 다운로드 URL(hydrated)이 들어온다.
          if (params.supportsPartialHydration !== undefined) {
            params.supportsPartialHydration = true
            params.showAllSubDubTracks = true
            patched = true
          }
          if (Array.isArray(params.profiles) && !params.profiles.includes(WEBVTT_PROFILE)) {
            params.profiles.push(WEBVTT_PROFILE)
            patched = true
          }
        }
        if (patched) return origStringify(copy)
      }
    } catch {
      /* 무시 — 주입 실패해도 원래 직렬화 결과는 그대로 반환 */
    }
    return origStringify(value, replacer, space)
  }) as typeof JSON.stringify
})()
