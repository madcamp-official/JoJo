import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import ePub, { type Rendition } from 'epubjs'
import type { ViewerFilePayload } from '@shared/types'
import type { PageState, PagerHandle, ViewerMode } from './pager'

// epub — epubjs 가 페이지네이션·CSS·폰트를 처리한다(사용자 확정). 내용은 iframe 안에 뜨는데,
// 호버 스택이 컨테이너의 ownerDocument/defaultView 를 쓰도록 일반화돼 있어(articleHighlight.ts)
// 그 iframe 문서를 그대로 넘기면 리스너·히트테스트·박스가 전부 같은 좌표계로 맞는다.
//
// 페이지/스크롤 전환은 epubjs 자체 flow 를 쓴다('paginated' vs 'scrolled-doc'). flow 는
// 렌더 시작 시점에 정해지므로 모드가 바뀌면 rendition 을 다시 만든다.

export function EpubView({
  file,
  fontSize,
  margin,
  dark,
  mode,
  pagerRef,
  onPageState,
}: {
  file: ViewerFilePayload
  fontSize: number
  margin: number
  dark: boolean
  mode: ViewerMode
  pagerRef: RefObject<PagerHandle | null>
  onPageState: (s: PageState) => void
}) {
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
    const rendition = book.renderTo(host, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: mode === 'page' ? 'paginated' : 'scrolled-doc',
    })
    renditionRef.current = rendition

    // 페이지 총 개수는 epubjs 가 locations 를 다 계산해야 나오는데(책 전체 훑기라 느리다)
    // 화살표를 켜고 끄는 데는 지금 위치가 처음/끝인지만 알면 충분하다 — relocated 이벤트가
    // 그 둘을 그대로 준다. 그래서 total 은 0(=표시 안 함)으로 두고 화살표만 제어한다.
    rendition.on('relocated', (loc: { atStart?: boolean; atEnd?: boolean }) => {
      if (cancelled) return
      onPageState({ current: 0, total: 0, canPrev: !loc?.atStart, canNext: !loc?.atEnd })
    })

    rendition.display().catch((e: Error) => {
      if (!cancelled) setError(e.message)
    })

    return () => {
      cancelled = true
      renditionRef.current = null
      rendition.destroy()
      book.destroy()
    }
  }, [file, mode, onPageState])

  // 글자 크기·배색 — epubjs 는 내용이 iframe 안에 있어 바깥 CSS 가 안 닿는다. 테마로
  // 직접 주입해야 한다.
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}px`)
  }, [fontSize, mode])

  useEffect(() => {
    const themes = renditionRef.current?.themes
    if (!themes) return
    themes.override('color', dark ? '#e5e7eb' : '#111827')
    themes.override('background', dark ? '#1f2430' : '#ffffff')
  }, [dark, mode])

  // 여백이 바뀌면 iframe 크기가 달라지므로 epubjs 에 재배치를 알린다(안 하면 이전 폭
  // 기준 페이지 계산이 남아 글이 잘려 보인다).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // resize() 는 크기를 명시로 받는다 — 여백을 뺀 실제 렌더 영역을 넘긴다.
    renditionRef.current?.resize(host.clientWidth, host.clientHeight)
  }, [margin])

  useImperativeHandle(pagerRef, () => ({
    next: () => void renditionRef.current?.next(),
    prev: () => void renditionRef.current?.prev(),
  }), [])

  return (
    <>
      {error && <p className="hint">epub을 열지 못했습니다: {error}</p>}
      {/* 여백은 iframe 바깥(호스트)에 준다 — epubjs 가 iframe 을 호스트 크기에 맞추므로
          그만큼 본문 폭이 줄어 줄바꿈이 여백 기준으로 다시 잡힌다. 안쪽 body 에 padding 을
          주면 epubjs 자체 페이지네이션 계산과 어긋난다. */}
      <div className="epub-host" ref={hostRef} style={{ paddingLeft: margin, paddingRight: margin }} />
    </>
  )
}
