// 담당 B — 유튜브 플레이어가 실제로 자막을 성공적으로 받아오는 네트워크 요청을 가로챈다.
// content script(격리된 세계)에서 직접 fetch를 재현하면 timedtext(json3)는 200+빈바디로
// 막히고, InnerTube get_transcript는 세션 검증(FAILED_PRECONDITION)에 막힌다 — 그런데도
// 화면엔 자막이 실제로 뜬다는 건 플레이어 자신의 요청은 성공한다는 뜻이다. 우리가 그
// 요청을 재현하는 대신, 페이지의 메인 JS 세계(플레이어 코드가 실제로 도는 곳)에서
// fetch/XHR을 패치해 그 성공한 응답을 그대로 엿듣는다. content script 는 격리된 세계라
// window.fetch 를 패치해도 페이지 자신의 fetch 호출엔 영향이 없어, 이 스크립트는
// manifest.json 에 "world": "MAIN" 으로 별도 등록해 페이지와 같은 JS 세계에서 실행한다.
// MAIN 월드는 chrome.runtime 을 못 쓰므로, window.postMessage 로 격리된 content script
// (content.ts)에 전달하고 거기서 background 로 중계한다.
;(function () {
  const CAPTION_URL_PATTERN = /timedtext|get_transcript/i

  // 마지막으로 가로챈 자막 응답을 캐시한다 — 플레이어가 캡션을 요청하는 시점은 보통 영상
  // 로드 극초반(선택 모드 진입보다 훨씬 전)인데, 그때 content script(isolated world)의
  // message 리스너가 아직 등록 전이면 postMessage 가 그냥 유실된다(넷플릭스와 달리 이
  // 훅엔 원래 재전송 수단이 없었다 — 2026-07-29 실사용 확인: 새로고침 없이 첫 선택 모드
  // 진입 시 유튜브만 항상 문맥 없이 한 줄로 뜨는 원인). 넷플릭스(netflixNetworkHook.ts)와
  // 같은 패턴으로, 캡처 시작 시 content script 가 재전송을 요청하면 캐시로 즉시 되돌려준다.
  let lastCaption: { url: string; text: string } | null = null

  function post(url: string, text: string): void {
    // 진단(임시, 2026-07-29): 위와 같은 이유 — 이 훅이 실제로 몇 번, 어떤 url 로 caption
    // 응답을 잡는지 눈으로 확인한다(원인 확정되면 이 로그와 위 로그 모두 제거).
    console.log(`[nuance networkHook] post 호출 url=${url} len=${text.length}`)
    lastCaption = { url, text }
    window.postMessage({ source: 'nuance-mainworld', kind: 'captionResponse', url, text }, '*')
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return
    const d = ev.data as { source?: string; kind?: string } | undefined
    if (d?.source !== 'nuance-content' || d.kind !== 'requestLastCaption') return
    // 진단(임시, 2026-07-29): "넷플릭스에서 유튜브로 탭 전환 시 새로고침 없이 한 줄만"
    // 재현 원인 특정용 — 재전송 요청 시점에 캐시가 애초에 있었는지 확인한다. 캐시가
    // 없다고 찍히면 이 훅이 그 영상의 timedtext 요청 자체를 한 번도 못 본 것.
    console.log(`[nuance networkHook] requestLastCaption 수신, 캐시=${lastCaption ? '있음(' + lastCaption.url + ')' : '없음'}`)
    if (lastCaption) post(lastCaption.url, lastCaption.text)
  })

  const origFetch = window.fetch
  window.fetch = function (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const p = origFetch.apply(this, args)
    try {
      const input = args[0]
      const url = typeof input === 'string' ? input : (input as Request).url
      if (CAPTION_URL_PATTERN.test(url)) {
        p.then((res) => res.clone().text())
          .then((text) => post(url, text))
          .catch(() => {})
      }
    } catch {
      /* 무시 — 가로채기 실패해도 원래 fetch 동작엔 영향 없음 */
    }
    return p
  }

  const OrigXHR = window.XMLHttpRequest
  const origOpen = OrigXHR.prototype.open
  const origSend = OrigXHR.prototype.send
  OrigXHR.prototype.open = function (
    this: XMLHttpRequest & { __nuanceUrl?: string },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__nuanceUrl = typeof url === 'string' ? url : url.toString()
    // eslint 스타일 걱정 없이 원본 시그니처 그대로 전달(가변 인자라 타입 단언 필요).
    return (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest])
  }
  OrigXHR.prototype.send = function (this: XMLHttpRequest & { __nuanceUrl?: string }, ...args: unknown[]) {
    const url = this.__nuanceUrl
    if (url && CAPTION_URL_PATTERN.test(url)) {
      this.addEventListener('load', () => post(url, this.responseText))
    }
    return (origSend as (...a: unknown[]) => void).apply(this, args)
  }
})()
