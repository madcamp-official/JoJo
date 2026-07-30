import { useEffect, useRef, useState } from 'react'
import type { ViewerFilePayload } from '@shared/types'

// PDF — 원본 레이아웃을 그대로 보여준다(사용자 확정): pdf.js 가 페이지를 캔버스로 그리고,
// 그 위에 투명한 텍스트 레이어(span 절대배치)를 겹친다. 그림·수식·다단이 원본과 같게
// 보이면서, 텍스트 레이어가 진짜 DOM 이라 호버 스택이 그대로 붙는다.
//
// pdf.js 의 TextLayer 가 만드는 span 은 대략 한 줄(텍스트 런) 단위라, 뷰어에서는 그 span
// 하나를 "문단"으로 취급한다(useHoverHighlight 의 PARAGRAPH_SELECTOR).

const SCALE = 1.5

export function PdfView({ file }: { file: ViewerFilePayload }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

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

          const ctx = canvas.getContext('2d')
          if (ctx) await page.render({ canvasContext: ctx, viewport, canvas }).promise
          if (cancelled) return

          const textLayer = new pdfjs.TextLayer({
            textContentSource: await page.getTextContent(),
            container: textLayerEl,
            viewport,
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

  return (
    <>
      {error && <p className="hint">PDF를 열지 못했습니다: {error}</p>}
      <div className="pdf-host" ref={hostRef} />
    </>
  )
}
