import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import ePub, { type Book, type Rendition } from 'epubjs'
import type { ViewerFilePayload } from '@shared/types'
import type { PageState, PagerHandle, ViewerMode } from './pager'
import type { TocEntry } from './Toc'
import type { ViewerStyle } from './ViewerSettings'

// epub — epubjs 가 페이지네이션·CSS·폰트를 처리한다(사용자 확정). 내용은 iframe 안에 뜨는데,
// 호버 스택이 컨테이너의 ownerDocument/defaultView 를 쓰도록 일반화돼 있어(articleHighlight.ts)
// 그 iframe 문서를 그대로 넘기면 리스너·히트테스트·박스가 전부 같은 좌표계로 맞는다.
//
// 페이지/스크롤 전환은 epubjs 자체 flow 를 쓴다('paginated' vs 'scrolled-doc'). flow 는
// 렌더 시작 시점에 정해지므로 모드가 바뀌면 rendition 을 다시 만든다.

/** epubjs 가 만드는 스크롤 컨테이너(스크롤 모드에서 실제로 스크롤되는 요소). */
const EPUB_CONTAINER = '.epub-container'
/** 우리가 iframe 문서에 넣는 글자 크기 스타일 노드의 id — 매번 갈아끼운다. */
const FONT_STYLE_ID = 'nuance-epub-font'

// epubjs 의 themes.fontSize() 는 iframe **body 의 인라인 스타일**에 font-size 를 얹을 뿐이라,
// 책 자체 CSS 가 본문에 절대 크기(`p { font-size: 12pt }` 등)를 지정해 두면 상속이 끊겨
// 본문은 그대로고 상대 단위(em)로 잡힌 제목만 커졌다 작아졌다 한다(2026-07-31 사용자 제보).
// 그래서 본문 요소에 rem 기준 크기를 직접 덮어씌운다 — 기준점인 html 의 font-size 만
// 슬라이더 값으로 바꾸면 제목/본문 비율은 아래 표대로 유지된 채 전체가 같이 커진다.
// inset: 좌우 여백을 iframe **안쪽**에 줄지 여부. 스크롤 모드에서는 iframe 이 창 폭을
// 다 차지해야 스크롤바가 창 오른쪽 끝에 붙으므로, 여백을 바깥 padding 이 아니라 여기서 준다.
function fontCss(st: ViewerStyle, inset: boolean): string {
  return `
    ${inset ? `body { padding-left: ${st.margin}px !important; padding-right: ${st.margin}px !important; box-sizing: border-box !important; }` : ''}
    html { font-size: ${st.fontSize}px !important; }
    body, p, div, span, li, dd, dt, td, th, blockquote, a, em, strong, i, b, small {
      font-size: 1rem !important;
      letter-spacing: ${st.letterSpacing}px !important;
      line-height: ${st.lineHeight} !important;
    }
    /* 정렬은 본문 블록에만 — 제목까지 끌려가면 가운데 맞춘 표제가 틀어진다. */
    p, li, dd, blockquote { text-align: ${st.textAlign} !important; }
    h1 { font-size: 1.9rem !important; }
    h2 { font-size: 1.6rem !important; }
    h3 { font-size: 1.35rem !important; }
    h4, h5, h6 { font-size: 1.15rem !important; }
    sup, sub { font-size: 0.7rem !important; }
  `
}

function applyFontSize(doc: Document | null | undefined, st: ViewerStyle, inset: boolean): void {
  if (!doc?.head) return
  let el = doc.getElementById(FONT_STYLE_ID)
  if (!el) {
    el = doc.createElement('style')
    el.id = FONT_STYLE_ID
    doc.head.appendChild(el)
  }
  el.textContent = fontCss(st, inset)
}

/** 챕터 연타 이동 방지용 잠금 — 휠 핸들러 여러 개(iframe 문서 + 호스트)가 공유한다. */
interface TurnLock {
  locked: boolean
}

/**
 * epubjs 는 스크롤 모드에서도 내용 iframe 에 `scrolling="no"` 를 박고, 스크롤은 그 바깥
 * 컨테이너(`.epub-container`)가 담당한다. 그래서 휠을 받는 쪽이 직접 그 컨테이너를 굴려
 * 줘야 한다. 붙이는 곳이 **두 군데**인 게 중요하다:
 *  - iframe 문서: 커서가 본문 위에 있을 때(안쪽이 이벤트를 먹고 바깥으로 안 넘긴다)
 *  - 호스트 요소: 커서가 좌우 여백 위에 있을 때. 여백은 우리가 준 패딩이라 iframe 밖이고,
 *    그 위에서는 휠이 아무 데도 안 닿아 스크롤이 통째로 죽었다(2026-07-31 실측 재현 —
 *    여백 위에서 굴리면 scrollTop 이 1600 에서 꼼짝 안 함).
 */
function makeWheelHandler(
  host: HTMLElement,
  rendition: Rendition,
  lock: TurnLock,
): (e: WheelEvent) => void {
  return (e: WheelEvent) => {
    const box = host.querySelector<HTMLElement>(EPUB_CONTAINER)
    if (!box) return
    const before = box.scrollTop
    box.scrollTop += e.deltaY
    e.preventDefault()
    // 더 안 굴러가면 챕터의 끝(또는 처음)이다 — 스크롤 모드는 챕터 하나만 싣기 때문에,
    // 여기서 다음/이전 챕터로 넘겨주지 않으면 책이 거기서 끝난 것처럼 보인다.
    if (box.scrollTop !== before || lock.locked) return
    if (e.deltaY > 0) {
      lock.locked = true
      void rendition.next()
    } else if (e.deltaY < 0) {
      lock.locked = true
      void rendition.prev()
    }
    if (lock.locked) setTimeout(() => (lock.locked = false), 500)
  }
}

export function EpubView({
  file,
  style,
  dark,
  mode,
  pagerRef,
  onPageState,
  onToc,
  onTurn,
  onSearchable,
}: {
  file: ViewerFilePayload
  style: ViewerStyle
  dark: boolean
  mode: ViewerMode
  pagerRef: RefObject<PagerHandle | null>
  onPageState: (s: PageState) => void
  onToc: (entries: TocEntry[]) => void
  /** 방향키로 넘기기 — iframe 안에서 누른 키는 부모 창까지 안 오므로 여기서 직접 전달한다. */
  onTurn: (dir: 'next' | 'prev') => void
  /** 책 전체 검색에 필요한 것들을 화면에 넘겨준다(EpubView 만 book 을 들고 있다). */
  onSearchable: (s: { book: Book; display: (href: string) => Promise<unknown>; host: () => HTMLElement | null } | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  // display() 가 끝나기 전에는 rendition 내부(manager)가 아직 없어서 resize() 가 그 안에서
  // 터진다(실측: "Cannot read properties of undefined (reading 'resize')"). 준비 완료를
  // 표시해두고 그 뒤에만 건드린다.
  const readyRef = useRef(false)
  // 새로 로드되는 챕터에도 같은 글자 크기를 바로 입혀야 하는데, 그 시점(content 훅)은
  // rendition 생성 effect 안에 갇혀 있어 최신 prop 을 못 본다 — ref 로 흘려보낸다.
  const styleRef = useRef(style)
  styleRef.current = style
  // content 훅은 rendition 생성 effect 안에 갇혀 있어 최신 prop 을 못 본다 — ref 로 흘린다.
  const onTurnRef = useRef(onTurn)
  onTurnRef.current = onTurn
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file.bytes) return
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const lock: TurnLock = { locked: false }
    readyRef.current = false

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
    onSearchable({
      book,
      display: (href) => rendition.display(href) as Promise<unknown>,
      host: () => hostRef.current,
    })

    // 챕터(섹션)가 iframe 에 실릴 때마다 불린다 — 새 문서에도 글자 크기를 입히고,
    // 스크롤 모드면 휠을 바깥 스크롤 컨테이너로 넘겨준다(바로 아래 주석).
    rendition.hooks.content.register((contents: { document: Document }) => {
      const doc = contents.document
      applyFontSize(doc, styleRef.current, mode === 'scroll')
      if (mode !== 'scroll') return

      doc.addEventListener('wheel', makeWheelHandler(host, rendition, lock), { passive: false })

      // 좌우 방향키 — 커서가 본문(iframe) 안에 있으면 keydown 이 그 문서에서 끝나고 부모
      // 창까지 오지 않아서, ViewerScreen 의 전역 리스너로는 안 잡힌다(2026-07-31 사용자
      // 제보: "방향키로 페이지 넘기는 게 안 먹힘"). 여기서 직접 받아 넘겨준다.
      doc.addEventListener('keydown', (e: KeyboardEvent) => {
        if (modeRef.current !== 'page') return
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          onTurnRef.current('next')
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onTurnRef.current('prev')
        }
      })
    })

    // 페이지 총 개수는 epubjs 가 locations 를 다 계산해야 나오는데(책 전체 훑기라 느리다)
    // 화살표를 켜고 끄는 데는 지금 위치가 처음/끝인지만 알면 충분하다 — relocated 이벤트가
    // 그 둘을 그대로 준다. 그래서 total 은 0(=표시 안 함)으로 두고 화살표만 제어한다.
    rendition.on('relocated', (loc: { atStart?: boolean; atEnd?: boolean }) => {
      if (cancelled) return
      onPageState({ current: 0, total: 0, canPrev: !loc?.atStart, canNext: !loc?.atEnd })
    })

    // 목차 — epub 은 navigation(toc)에 들어 있다. 항목의 href 로 그 위치를 띄운다.
    void book.loaded.navigation
      .then((nav) => {
        if (cancelled) return
        const build = (items: { label?: string; href?: string; subitems?: unknown[] }[]): TocEntry[] =>
          items.map((it) => ({
            label: (it.label ?? '').trim() || '(제목 없음)',
            go: () => void (it.href ? rendition.display(it.href) : undefined),
            children: Array.isArray(it.subitems) ? build(it.subitems as typeof items) : [],
          }))
        const entries = build((nav.toc ?? []) as Parameters<typeof build>[0])
        onToc(entries)
      })
      // 목차가 없는 epub 도 흔하다 — 실패해도 조용히 넘어간다(버튼이 안 뜰 뿐).
      .catch(() => {})

    // 여백 위에서 굴릴 때를 위해 호스트에도 같은 핸들러를 붙인다(위 makeWheelHandler 주석).
    const hostWheel = makeWheelHandler(host, rendition, lock)
    if (mode === 'scroll') host.addEventListener('wheel', hostWheel, { passive: false })

    rendition
      .display()
      .then(() => {
        if (!cancelled) readyRef.current = true
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })

    return () => {
      cancelled = true
      renditionRef.current = null
      rendition.destroy()
      book.destroy()
    }
  }, [file, mode, onPageState, onToc, onSearchable])

  // 글자 크기·배색 — epubjs 는 내용이 iframe 안에 있어 바깥 CSS 가 안 닿는다. 직접
  // 주입해야 한다(글자 크기는 위 fontCss 주석 참고 — themes.fontSize() 는 책 CSS 에
  // 밀려서 본문에 안 먹힌다). 지금 떠 있는 챕터들에 즉시 반영한다.
  useEffect(() => {
    // 타입 정의는 Contents 하나를 반환한다고 돼 있지만 실제 구현은 배열을 준다.
    const contents = renditionRef.current?.getContents() as unknown as { document: Document }[] | undefined
    for (const c of contents ?? []) applyFontSize(c?.document, style, mode === 'scroll')
  }, [style, mode])

  useEffect(() => {
    const themes = renditionRef.current?.themes
    if (!themes) return
    themes.override('color', dark ? '#e5e7eb' : '#111827')
    themes.override('background', dark ? '#1f2430' : '#ffffff')
  }, [dark, mode])

  // 여백이 바뀌면 iframe 크기가 달라지므로 epubjs 에 재배치를 알린다(안 하면 이전 폭
  // 기준 페이지 계산이 남아 글이 잘려 보인다).
  // 여백이 바뀌거나 창 크기가 바뀌면 렌더 영역을 다시 알려준다.
  //
  // 넘기는 값은 여백을 뺀 **실제 내용 폭**이다. 스크롤러(.epub-container)는 창 전체 폭을
  // 유지한 채 padding 으로 내용만 밀기 때문에(스크롤바를 창 끝에 붙이려는 목적), epubjs 에
  // 전체 폭을 그대로 주면 좁은 상자에 넓은 조판을 해 내용이 크게 넘친다(실측: 여백 240 일 때
  // iframe 11340px, 내부 넘침 10903px).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const apply = (): void => {
      if (!readyRef.current) return
      try {
        // 스크롤 모드는 iframe 이 창 폭을 그대로 쓴다(여백은 iframe 안쪽 padding).
        const w = mode === 'scroll' ? host.clientWidth : host.clientWidth - style.margin * 2
        renditionRef.current?.resize(Math.max(1, w), host.clientHeight)
      } catch {
        // 재배치 실패는 치명적이지 않다(다음 페이지 이동 때 어차피 다시 잡힌다).
      }
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [style.margin, mode])

  useImperativeHandle(pagerRef, () => ({
    next: () => void renditionRef.current?.next(),
    prev: () => void renditionRef.current?.prev(),
  }), [])

  return (
    <>
      {error && <p className="hint">epub을 열지 못했습니다: {error}</p>}
      {/* 페이지 모드의 여백은 iframe 바깥(호스트)의 padding 으로 준다 — epubjs 가 iframe 을
          호스트 크기에 맞추므로 그만큼 본문 폭이 줄어 줄바꿈이 여백 기준으로 다시 잡힌다.
          스크롤 모드는 반대로 여백을 iframe 안쪽(body padding, fontCss)으로 넣는다: 여백을
          바깥에 두면 iframe 이 그만큼 좁아지고 스크롤바도 같이 안쪽으로 밀려 들어와, 창
          오른쪽 끝에 붙지 않는다(사용자 요청). 조판 폭은 어느 쪽이든 resize() 로 맞춘다. */}
      <div
        className="epub-host"
        ref={hostRef}
        style={mode === 'scroll' ? undefined : { paddingLeft: style.margin, paddingRight: style.margin }}
      />
    </>
  )
}
