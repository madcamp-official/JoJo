import { useEffect, useRef, useState } from 'react'
import ePub, { type Rendition } from 'epubjs'
import type { ViewerFilePayload } from '@shared/types'

// epub — epubjs 가 페이지네이션·CSS·폰트를 처리한다(사용자 확정). 내용은 iframe 안에 뜨는데,
// 호버 스택이 컨테이너의 ownerDocument/defaultView 를 쓰도록 일반화돼 있어(articleHighlight.ts)
// 그 iframe 문서를 그대로 넘기면 리스너·히트테스트·박스가 전부 같은 좌표계로 맞는다.

export function EpubView({ file, fontSize }: { file: ViewerFilePayload; fontSize: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file.bytes) return
    const host = hostRef.current
    if (!host) return
    let cancelled = false

    // slice() 로 복사본을 준다 — 원본 Uint8Array 를 그대로 넘기면 재마운트 때 이미
    // 소비된 버퍼를 다시 읽게 될 수 있다.
    const book = ePub(file.bytes.slice().buffer as ArrayBuffer)
    const rendition = book.renderTo(host, { width: '100%', height: '100%', spread: 'none' })
    renditionRef.current = rendition
    rendition.display().catch((e: Error) => {
      if (!cancelled) setError(e.message)
    })

    return () => {
      cancelled = true
      renditionRef.current = null
      rendition.destroy()
      book.destroy()
    }
  }, [file])

  // 글자 크기 — epubjs 는 iframe 안 문서에 테마로 주입해야 한다(바깥 CSS 는 안 닿는다).
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}px`)
  }, [fontSize])

  return (
    <>
      {error && <p className="hint">epub을 열지 못했습니다: {error}</p>}
      <div className="epub-host" ref={hostRef} />
    </>
  )
}
