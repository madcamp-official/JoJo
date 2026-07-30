import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import { setWordSegments } from '@shared/hover/wordSegments'
import { TxtView } from '../viewer/TxtView'
import { PdfView } from '../viewer/PdfView'
import { EpubView } from '../viewer/EpubView'
import { useHoverHighlight } from '../viewer/useHoverHighlight'
import { ArrowLeftIcon, MinusIcon, PlusIcon, SearchIcon } from './icons'
import { PageNav } from '../viewer/PageNav'
import { Progress } from '../viewer/Progress'
import { PageJump } from '../viewer/PageJump'
import { SearchPanel } from '../viewer/SearchPanel'
import { searchEpub, searchPdf, searchTxt } from '../viewer/searchProviders'
import type { SearchHit } from '../viewer/search'
import type { Book } from 'epubjs'
import { Toc, type TocEntry } from '../viewer/Toc'
import { ListIcon } from './icons'
import {
  EMPTY_PAGE_STATE,
  PAGE_TURN_TIMING,
  pageTurnKeyframes,
  type PageState,
  type PageTransition,
  type PagerHandle,
  type ViewerMode,
} from '../viewer/pager'
import {
  loadViewerPrefs,
  saveViewerPrefs,
  ViewerSettings,
  type ViewerStyle,
} from '../viewer/ViewerSettings'
import { SlidersIcon } from './icons'

// 자체 문서 뷰어(pdf/epub/txt) — 외부 뷰어(크롬 내장 PDF 뷰어·Kindle 등)는 텍스트나 좌표를
// 신뢰할 수 있게 주지 않아서(TODO.md 96~111 조사) 우리가 직접 파싱·렌더링한다. 우리 DOM
// 위에서 확장이 웹페이지에 쓰는 것과 **같은 소스**(@shared/hover)로 호버박스를 띄우므로
// 접근성 API 도 OCR 도 필요 없고 mac/Windows 가 동일하게 동작한다.


/** 툴바 높이를 아직 못 잰 첫 프레임에만 쓰는 대체값. */
const TOOLBAR_FALLBACK_PX = 46
/** 툴바 높이에 얹는 여유 — 딱 높이까지만 인정하면 경계에서 깜빡여 집기 힘들다(사용자 요청). */
const TOOLBAR_REVEAL_SLACK_PX = 24

export function ViewerScreen() {
  const [file, setFile] = useState<ViewerFilePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 글자 크기/자간/줄 간격/여백을 한 덩어리로 — 툴바의 "보기 설정" 버튼 뒤 패널에서 만진다.
  // 마지막에 쓰던 설정으로 시작한다(ViewerSettings.loadViewerPrefs — localStorage).
  const [prefs0] = useState(loadViewerPrefs)
  const [style, setStyle] = useState<ViewerStyle>(prefs0.style)
  const [styleOpen, setStyleOpen] = useState(false)
  // PDF 확대 배율(1 = 100%).
  const [zoom, setZoom] = useState(1)
  // 일반/선택 모드 — 선택 모드일 때만 호버박스·팝업이 동작한다. 뷰어는 읽으면서 바로
  // 찾아보는 용도라 선택 모드를 기본으로 둔다(사용자 지정).
  const [selectMode, setSelectMode] = useState(true)
  const [dark, setDark] = useState(prefs0.dark)
  const [mode, setMode] = useState<ViewerMode>(prefs0.mode)
  const [pageState, setPageState] = useState<PageState>(EMPTY_PAGE_STATE)
  const containerRef = useRef<HTMLDivElement>(null)
  // 각 뷰(pdf/epub/txt)가 자기 방식대로 채워 넣는 "넘기기" 핸들 — 넘기는 방법은 포맷마다
  // 다르지만(pager.ts 주석) 화살표 버튼·방향키는 이 핸들 하나만 부른다.
  const pagerRef = useRef<PagerHandle | null>(null)
  const [transition, setTransition] = useState<PageTransition>(prefs0.transition)
  const animRef = useRef<HTMLDivElement>(null)
  // 목차 — 문서에 들어 있을 때만 채워진다(PDF 아웃라인 / epub navigation). 비어 있으면
  // 버튼 자체를 띄우지 않는다.
  const [toc, setToc] = useState<TocEntry[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // epub 만 책 전체 검색에 book 객체가 필요하다(나머지는 DOM 만으로 찾는다).
  const epubSearchRef = useRef<{ book: Book; display: (href: string) => Promise<unknown>; host: () => HTMLElement | null } | null>(null)

  // **반드시 안정적인 함수여야 한다.** 인라인 화살표로 넘기면 렌더마다 새 identity 가 되고,
  // 이 값을 의존성에 쓰는 EpubView 의 렌더링 effect 가 매 렌더 재실행돼 book 이 계속
  // 파괴·재생성된다 — 그러면 book.destroy() 가 spineItems 를 비워 책 전체 검색이 항상
  // 0건이 나온다(2026-07-31 epub 검색 미동작의 원인).
  const setEpubSearchable = useCallback((v: typeof epubSearchRef.current) => {
    epubSearchRef.current = v
  }, [])

  const runSearch = useCallback(
    async (q: string): Promise<SearchHit[]> => {
      const root = containerRef.current
      if (file?.kind === 'txt') return searchTxt(root, q)
      if (file?.kind === 'pdf') return searchPdf(root, q)
      const e = epubSearchRef.current
      if (file?.kind === 'epub' && e) return searchEpub(e.book, e.display, e.host, q)
      return []
    },
    [file],
  )
  // 넘김 방향과 "몇 번째 넘김인지".
  // key 로 리마운트시키는 방법은 쓰면 안 된다 — PDF/epub 뷰가 통째로 다시 그려진다.
  const [turn, setTurn] = useState({ dir: 'next' as 'next' | 'prev', tick: 0 })

  // 넘길 때마다 새 애니메이션을 만들어 재생한다(pager.ts 주석 — CSS 클래스 방식으로는
  // 같은 방향 연속 넘김에서 재생이 안 되는 함정을 못 피한다).
  useLayoutEffect(() => {
    if (turn.tick === 0) return
    const frames = pageTurnKeyframes(transition, turn.dir)
    if (!frames) return
    animRef.current?.animate(frames, PAGE_TURN_TIMING)
  }, [turn, transition])

  useEffect(() => {
    saveViewerPrefs({ style, mode, transition, dark })
  }, [style, mode, transition, dark])

  // 툴바 자동 숨김 — 읽는 동안 화면을 가리지 않게 평소엔 숨기고, 커서를 창 위쪽으로
  // 가져가면 나타난다. 설정 패널이 열려 있는 동안은 계속 띄워둔다(조작 중에 사라지면
  // 안 되므로).
  const [barShown, setBarShown] = useState(true)
  const barRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // 기준선은 툴바가 실제로 차지하는 높이 그 자체다 — 넉넉한 고정값을 쓰면 툴바가 없는
    // 빈 띠에서도 튀어나와 "왜 지금 뜨지?" 싶어진다(사용자 지적). 숨은 상태에서도
    // visibility 로만 감추므로 offsetHeight 는 그대로 살아 있다.
    const limit = (): number =>
      (barRef.current?.offsetHeight || TOOLBAR_FALLBACK_PX) + TOOLBAR_REVEAL_SLACK_PX
    const onMove = (e: MouseEvent) => setBarShown(e.clientY <= limit())
    window.addEventListener('mousemove', onMove)

    // epub 본문은 iframe 안이라 그 위에서 움직이면 부모 창에 mousemove 가 오지 않는다 —
    // 툴바가 뜬 채로 남아 있던 이유다(2026-07-31 사용자 제보). iframe 좌표는 그 창 기준이라
    // 프레임의 화면상 위치를 더해 창 좌표로 옮긴 뒤 같은 기준선으로 판정한다.
    const bound: Array<[Document, (e: MouseEvent) => void]> = []
    const attach = (): void => {
      for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('.viewer-body iframe'))) {
        const d = f.contentDocument
        if (!d || bound.some(([doc]) => doc === d)) continue
        const onFrameMove = (e: MouseEvent): void => {
          setBarShown(e.clientY + f.getBoundingClientRect().top <= limit())
        }
        d.addEventListener('mousemove', onFrameMove)
        bound.push([d, onFrameMove])
      }
    }
    // iframe 은 나중에(챕터 로드 때마다) 새로 생기므로 주기적으로 다시 붙인다.
    attach()
    const timer = window.setInterval(attach, 600)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.clearInterval(timer)
      for (const [d, fn] of bound) d.removeEventListener('mousemove', fn)
    }
  }, [])

  const goPage = useCallback((dir: 'next' | 'prev') => {
    setTurn((t) => ({ dir, tick: t.tick + 1 }))
    if (dir === 'next') pagerRef.current?.next()
    else pagerRef.current?.prev()
  }, [])

  useEffect(() => {
    window.nuance
      .getViewerFile()
      .then((f) => {
        if (!f) setError('열린 파일이 없습니다.')
        else setFile(f)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  // 확장이 background 를 거쳐 받던 형태소 분할 결과를, 뷰어는 IPC 로 직접 받아 같은
  // 저장소(wordSegments.ts)에 넣는다 — 그 뒤 그룹핑은 확장과 완전히 같은 코드가 처리한다.
  const requestSegments = useCallback((text: string) => {
    void window.nuance.segmentViewerText(text).then((words) => {
      if (words.length > 0) setWordSegments(text, words)
    })
  }, [])

  // PDF 는 원본 레이아웃(캔버스)을 그대로 보여주는 게 목적이라 글자 크기·배경을 우리가
  // 바꾸지 않는다 — txt/epub 만 조절 UI 를 띄운다.
  const isReflowable = file?.kind === 'txt' || file?.kind === 'epub'

  // 페이지 모드에서 좌우 방향키로 넘긴다. 입력 칸(글자 크기 슬라이더 등)에 포커스가 있을
  // 땐 그쪽이 화살표를 써야 하므로 넘기지 않는다.
  useEffect(() => {
    if (mode !== 'page') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPage('prev')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goPage('next')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, goPage])

  // 모드를 바꾸면 이전 모드의 페이지 상태(화살표 활성 여부 등)는 의미가 없다.
  useEffect(() => setPageState(EMPTY_PAGE_STATE), [mode, file])
  // 파일이 바뀌면 이전 문서의 목차는 버린다.
  useEffect(() => {
    setToc([])
    setTocOpen(false)
  }, [file])

  return (
    <div className={`screen viewer-screen${dark && isReflowable ? ' dark' : ''}`}>
      <header ref={barRef} className={`viewer-toolbar${barShown || styleOpen || tocOpen || searchOpen ? '' : ' hidden'}`}>
        <button className="viewer-back" title="메인으로" onClick={() => void window.nuance.viewerBack()}>
          <ArrowLeftIcon />
        </button>
        {toc.length > 0 && (
          <button className="viewer-back" title="목차" onClick={() => setTocOpen((v) => !v)}>
            <ListIcon />
          </button>
        )}
        <span className="viewer-title" title={file?.path}>
          {file?.name ?? '문서'}
        </span>
        <div className="viewer-controls">
          {/* 일반/선택 모드는 읽는 중에 자주 바꾸는 스위치라 설정 패널에 넣지 않고
              메뉴바에 그대로 노출한다(사용자 지정). */}
          <div className="style-toggle bar-toggle">
            <button className={!selectMode ? 'on' : ''} onClick={() => setSelectMode(false)}>
              일반
            </button>
            <button className={selectMode ? 'on' : ''} onClick={() => setSelectMode(true)}>
              선택
            </button>
          </div>
          {file?.kind === 'pdf' && (
            <>
              <PageJump state={pageState} onJump={(n) => pagerRef.current?.goTo?.(n - 1)} />
              <div className="style-toggle bar-toggle">
                <button title="축소" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}>
                  <MinusIcon />
                </button>
                <button title="확대" onClick={() => setZoom((z) => Math.min(3, +(z + 0.1).toFixed(2)))}>
                  <PlusIcon />
                </button>
              </div>
              <span className="viewer-zoom-value">{Math.round(zoom * 100)}%</span>
            </>
          )}
          {/* 검색은 설정 버튼 바로 왼쪽에 붙인다(사용자 지정) — 둘 다 "패널을 여는"
              버튼이라 같은 자리에 모아두는 편이 찾기 쉽다. */}
          <button className="viewer-style-btn" title="검색" onClick={() => setSearchOpen((v) => !v)}>
            <SearchIcon />
          </button>
          {/* 읽기 방식·테마·글자 설정·넘김 효과를 전부 이 버튼 뒤 패널로 접었다 —
              툴바에 컨트롤을 늘어놓으면 금방 지저분해진다(사용자 요청). */}
          <button
            className={`viewer-style-btn${styleOpen ? ' on' : ''}`}
            title="보기 설정"
            onClick={() => setStyleOpen((v) => !v)}
          >
            <SlidersIcon />
          </button>
          <ViewerSettings
            open={styleOpen}
            onClose={() => setStyleOpen(false)}
            style={style}
            onChange={setStyle}
            showTextStyle={isReflowable}
            showTransition={mode === 'page'}
            transition={transition}
            onTransitionChange={setTransition}
            mode={mode}
            onModeChange={setMode}
            showTheme={isReflowable}
            dark={dark}
            onDarkChange={setDark}
          />
        </div>
      </header>

      <div className="viewer-body" ref={containerRef}>
        {error && <p className="hint">{error}</p>}
        {!file && !error && <p className="hint">불러오는 중...</p>}
        <div ref={animRef} className="viewer-anim">
        {file?.kind === 'txt' && (
          <TxtView file={file} style={style} mode={mode} pagerRef={pagerRef} onPageState={setPageState} />
        )}
        {file?.kind === 'pdf' && (
          <PdfView file={file} mode={mode} zoom={zoom} pagerRef={pagerRef} onPageState={setPageState} onToc={setToc} />
        )}
        {file?.kind === 'epub' && (
          <EpubView
            file={file}
            style={style}
            dark={dark}
            mode={mode}
            pagerRef={pagerRef}
            onPageState={setPageState}
            onToc={setToc}
            onTurn={goPage}
            onSearchable={setEpubSearchable}
          />
        )}
        </div>
        <Toc entries={toc} open={tocOpen} onClose={() => setTocOpen(false)} />
        <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} onSearch={runSearch} />
        {mode === 'page' && (
          <PageNav state={pageState} onPrev={() => goPage('prev')} onNext={() => goPage('next')} />
        )}
      </div>
      {/* 진도 표시는 페이지 모드에서만 — 스크롤로 읽을 때는 스크롤바가 이미 위치를
          알려주므로 아래 바가 겹쳐 보인다(사용자 요청). */}
      {mode === 'page' && <Progress pageState={pageState} />}
      <HoverBinding
        file={file}
        containerRef={containerRef}
        requestSegments={requestSegments}
        enabled={selectMode}
        deps={[style, dark, mode, pageState]}
      />
    </div>
  )
}

// 호버 스택 배선만 담당하는 빈 컴포넌트 — 훅 하나로 끝나지만, 렌더 트리 안에서 file/폰트
// 크기 변화에 맞춰 재부착 타이밍을 잡기 위해 분리했다.
function HoverBinding({
  file,
  containerRef,
  requestSegments,
  enabled,
  deps,
}: {
  file: ViewerFilePayload | null
  containerRef: React.RefObject<HTMLDivElement | null>
  requestSegments: (text: string) => void
  enabled: boolean
  deps: unknown[]
}) {
  useHoverHighlight({ file, containerRef, requestSegments, enabled, deps })
  return null
}
