import { useEffect } from 'react'
import type { ViewerFilePayload, ViewerKind } from '@shared/types'
import { extractArticleText } from '@shared/hover/webArticle'
import { startArticleHighlight, type ArticleWordHit } from '@shared/hover/articleHighlight'

// 뷰어 DOM 에 확장과 **같은** 호버 스택(@shared/hover)을 붙인다. 확장의 content.ts 가
// startArticleHighlight(container, extraction, onClick, requestSegments) 를 부르는 것과
// 완전히 같은 배선이고, 다르게 주는 건 두 가지뿐이다:
//  - 컨테이너: 웹페이지는 findMainContent() 로 본문을 추측해야 하지만 뷰어는 자기가 그린
//    DOM 이라 이미 알고 있다.
//  - 문단 선택자: txt/epub 은 <p>(기본), PDF 는 pdf.js 텍스트 레이어가 만드는 span.

/** PDF 는 pdf.js 텍스트 레이어의 span 이 한 줄(텍스트 런) 단위라 그게 곧 문단이 된다. */
const PARAGRAPH_SELECTOR: Record<ViewerKind, string> = {
  txt: 'p',
  epub: 'p',
  pdf: '.textLayer span',
}

/** epub 은 epubjs 가 내용을 iframe 안에 띄운다 — 그 iframe 문서의 body 가 진짜 컨테이너다. */
function resolveContainer(root: HTMLElement, kind: ViewerKind): HTMLElement | null {
  if (kind !== 'epub') return root
  const iframe = root.querySelector('iframe')
  return iframe?.contentDocument?.body ?? null
}

export function useHoverHighlight({
  file,
  containerRef,
  requestSegments,
  deps,
}: {
  file: ViewerFilePayload | null
  containerRef: React.RefObject<HTMLElement | null>
  requestSegments: (text: string) => void
  deps: unknown[]
}): void {
  useEffect(() => {
    const root = containerRef.current
    if (!file || !root) return

    const selector = PARAGRAPH_SELECTOR[file.kind]
    let stop: (() => void) | null = null

    // 렌더가 실제로 끝나 문단이 DOM 에 생긴 뒤에 붙여야 한다(pdf.js/epubjs 는 비동기라
    // 첫 프레임엔 아직 비어 있다) — 문단이 하나라도 잡힐 때까지 짧게 재시도한다.
    let tries = 0
    const attach = (): void => {
      const container = resolveContainer(root, file.kind)
      const extraction = container ? extractArticleText(container, selector) : null
      if (!container || !extraction || extraction.paragraphs.length === 0) {
        if (tries++ < 40) timer = window.setTimeout(attach, 100)
        return
      }
      stop = startArticleHighlight(
        container,
        extraction,
        (hit: ArticleWordHit) => {
          void window.nuance.viewerWordClicked({
            text: hit.fullText,
            anchorStart: hit.anchorStart,
            anchorEnd: hit.anchorEnd,
            kind: file.kind,
            name: file.name,
          })
        },
        requestSegments,
        { paragraphSelector: selector },
      )
    }
    let timer = window.setTimeout(attach, 0)

    return () => {
      window.clearTimeout(timer)
      stop?.()
    }
    // deps 에 폰트 크기 등이 들어온다 — 레이아웃이 바뀌면 문단 오프셋/좌표를 다시 잡아야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, requestSegments, ...deps])
}
