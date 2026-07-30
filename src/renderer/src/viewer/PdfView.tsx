import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import type { PageState, PagerHandle, ViewerMode } from './pager'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'

// PDF — 원본 레이아웃을 그대로 보여준다(사용자 확정): pdf.js 가 페이지를 캔버스로 그리고,
// 그 위에 투명한 텍스트 레이어(span 절대배치)를 겹친다. 그림·수식·다단이 원본과 같게
// 보이면서, 텍스트 레이어가 진짜 DOM 이라 호버 스택이 그대로 붙는다.
//
// pdf.js 의 TextLayer 가 만드는 span 은 대략 한 줄(텍스트 런) 단위라, 뷰어에서는 그 span
// 하나를 "문단"으로 취급한다(useHoverHighlight 의 PARAGRAPH_SELECTOR).

const SCALE = 1.5

export function PdfView({
  file,
  mode,
  pagerRef,
  onPageState,
}: {
  file: ViewerFilePayload
  mode: ViewerMode
  pagerRef: RefObject<PagerHandle | null>
  onPageState: (s: PageState) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    if (!file.bytes) return
    const host = hostRef.current
    if (!host) return
    let cancelled = false

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        // 워커는 번들러가 URL 로 뽑아준 것을 쓴다(별도 정적 복사 불필요).
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

        // getDocument 는 넘긴 버퍼를 소유(detach)하므로 복사본을 준다 — 원본을 재사용하면
        // 재렌더 시 "detached ArrayBuffer" 로 깨진다.
        const doc = await pdfjs.getDocument({ data: file.bytes!.slice() }).promise
        if (cancelled) return
        setTotal(doc.numPages)

        // 1단계 — 모든 페이지의 자리(정확한 크기의 빈 상자)를 먼저 만들어 붙인다.
        // 예전엔 한 장 그릴 때마다 하나씩 append 했는데, 그러면 문서를 다 그릴 때까지
        // 스크롤 높이가 계속 늘어나서 스크롤바가 전체 분량을 반영하지 못했다(사용자 제보
        // — "전체 PDF 중 현재 페이지 위치를 제대로 반영하지 않음"). 자리를 먼저 다 잡으면
        // 첫 화면부터 스크롤바 길이·위치가 실제 문서 기준으로 정확해진다.
        const slots: { page: PDFPageProxy; viewport: PageViewport; canvas: HTMLCanvasElement; textLayerEl: HTMLDivElement }[] = []
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          if (cancelled) return
          const viewport = page.getViewport({ scale: SCALE })

          const pageEl = document.createElement('div')
          pageEl.className = 'pdf-page'
          pageEl.style.width = `${viewport.width}px`
          pageEl.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          pageEl.appendChild(canvas)

          const textLayerEl = document.createElement('div')
          textLayerEl.className = 'textLayer'
          pageEl.appendChild(textLayerEl)
          host.appendChild(pageEl)

          slots.push({ page, viewport, canvas, textLayerEl })
        }

        // 2단계 — 자리마다 실제 내용을 채운다. 이 사이에 스크롤 높이는 더 이상 변하지 않는다.
        for (const slot of slots) {
          if (cancelled) return
          const ctx = slot.canvas.getContext('2d')
          if (ctx) await slot.page.render({ canvasContext: ctx, viewport: slot.viewport }).promise
          if (cancelled) return

          const textLayer = new pdfjs.TextLayer({
            textContentSource: await slot.page.getTextContent(),
            container: slot.textLayerEl,
            viewport: slot.viewport,
          })
          await textLayer.render()
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()

    return () => {
      cancelled = true
      host.replaceChildren()
    }
  }, [file])

  // 페이지 모드 — 현재 장만 남기고 나머지는 감춘다. 감춰진 페이지의 텍스트는
  // extractArticleText 의 가시성 필터에서 자연히 빠지므로(webArticle.ts), 팝업 문맥도
  // 지금 보고 있는 장 기준으로 잡히고 수백 장짜리 문서에서 호버 계산도 가벼워진다.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const pages = Array.from(host.querySelectorAll<HTMLElement>('.pdf-page'))
    pages.forEach((el, i) => {
      el.style.display = mode === 'page' && i !== page ? 'none' : ''
    })
    if (mode === 'page') host.scrollIntoView({ block: 'start' })
  }, [mode, page, total])

  useImperativeHandle(
    pagerRef,
    () => ({
      next: () => setPage((p) => Math.min(p + 1, Math.max(0, total - 1))),
      prev: () => setPage((p) => Math.max(0, p - 1)),
    }),
    [total],
  )

  useEffect(() => {
    if (mode !== 'page') return
    onPageState({ current: page + 1, total, canPrev: page > 0, canNext: page < total - 1 })
  }, [page, total, mode, onPageState])

  return (
    <>
      {error && <p className="hint">PDF를 열지 못했습니다: {error}</p>}
      <div className="pdf-host" ref={hostRef} />
    </>
  )
}
