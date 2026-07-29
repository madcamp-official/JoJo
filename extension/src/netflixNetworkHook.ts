// 담당 B — 넷플릭스 매니페스트 응답을 가로채 전체 자막(WebVTT) 다운로드 URL을 확보한다.
// 넷플릭스는 유튜브와 달리 플레이어 매니페스트 요청/응답이 MSL로 암호화돼 있어 fetch/XHR을
// 패치해도(networkHook.ts 방식) 평문을 못 본다 — 대신 넷플릭스 자신의 플레이어 코드가 이미
// 복호화한 뒤 호출하는 JSON.parse 를 후킹하면 평문 객체(result.timedtexttracks)를 그대로
// 받을 수 있다(Language Reactor 류 도구, 오픈소스 netflix-subtitle-loader에서 확인한 방식).
// 자막 파일 자체(webvtt)는 CDN에서 평문으로 오므로 이 URL만 확보하면 일반 fetch로 받을 수
// 있다. 단, 클라이언트가 매니페스트 요청 시 webvtt 프로파일을 요청 목록에 안 넣으면
// 응답에 다운로드 URL이 아예 없어서, 요청 직전(JSON.stringify) 단계에서 프로파일을 강제로
// 끼워 넣는다. 이 스크립트는 manifest.json 에 "world":"MAIN"으로 등록해 페이지와 같은 JS
// 세계에서 실행한다(MAIN 월드는 chrome.runtime 을 못 써 postMessage 로 content.ts에 전달).
;(function () {
  const WEBVTT_PROFILE = 'webvtt-lssdh-ios8'
  console.log('[nuance netflixHook] 훅 등록됨 (MAIN world)')

  function post(movieId: string, tracks: unknown): void {
    window.postMessage({ source: 'nuance-mainworld', kind: 'netflixManifest', movieId, tracks }, '*')
  }

  const origParse = JSON.parse
  JSON.parse = function (text: string, reviver?: (key: string, value: unknown) => unknown): unknown {
    const data = origParse(text, reviver)
    try {
      // 진단(임시): 실제 매니페스트 응답이 JSON.parse를 통해 우리 손에 들어오긴 하는지,
      // 들어온다면 실제 최상위 모양이 result.timedtexttracks 가정과 맞는지 확인한다 —
      // 넷플릭스가 Response.json() 등 JSON.parse를 안 거치는 경로로 파싱하면 이 후킹
      // 자체가 원천적으로 안 통한다.
      if (typeof text === 'string' && text.includes('timedtexttracks')) {
        const topKeys = data && typeof data === 'object' ? Object.keys(data as object) : []
        console.log('[nuance netflixHook] timedtexttracks 포함 응답 감지, 최상위 키:', topKeys)
      }
      const result = (data as { result?: { movieId?: number | string; timedtexttracks?: unknown } } | null)
        ?.result
      if (result && result.timedtexttracks && result.movieId !== undefined) {
        console.log(`[nuance netflixHook] 매니페스트 확보 movieId=${result.movieId}`)
        post(String(result.movieId), result.timedtexttracks)
      }
    } catch (err) {
      console.log('[nuance netflixHook] JSON.parse 후킹 처리 중 오류:', (err as Error)?.message)
    }
    return data
  }

  const origStringify = JSON.stringify
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JSON.stringify = function (value: any, replacer?: any, space?: any): string {
    try {
      const profiles = value?.params?.profiles
      if (Array.isArray(profiles) && !profiles.includes(WEBVTT_PROFILE)) {
        profiles.unshift(WEBVTT_PROFILE)
        console.log('[nuance netflixHook] webvtt 프로필 요청에 주입함')
      }
    } catch {
      /* 무시 */
    }
    return origStringify(value, replacer, space)
  }
})()
