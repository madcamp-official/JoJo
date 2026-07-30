import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import { setWordSegments } from '@shared/hover/wordSegments'
import { TxtView } from '../viewer/TxtView'
import { PdfView } from '../viewer/PdfView'
import { EpubView } from '../viewer/EpubView'
import { useHoverHighlight } from '../viewer/useHoverHighlight'
import { ArrowLeftIcon } from './icons'
import { PageNav } from '../viewer/PageNav'
import { Progress } from '../viewer/Progress'
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


/** 커서가 창 위쪽 이 범위 안에 들어오면 툴바를 보여준다. */
const TOOLBAR_REVEAL_PX = 90

export function ViewerScreen() {
  const [file, setFile] = useState<ViewerFilePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 글자 크기/자간/줄 간격/여백을 한 덩어리로 — 툴바의 "보기 설정" 버튼 뒤 패널에서 만진다.
  // 마지막에 쓰던 설정으로 시작한다(ViewerSettings.loadViewerPrefs — localStorage).
  const [prefs0] = useState(loadViewerPrefs)
  const [style, setStyle] = useState<ViewerStyle>(prefs0.style)
  const [styleOpen, setStyleOpen] = useState(false)
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
  useEffect(() => {
    const onMove = (e: MouseEvent) => setBarShown(e.clientY <= TOOLBAR_REVEAL_PX)
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
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
      <header className={`viewer-toolbar${barShown || styleOpen || tocOpen ? '' : ' hidden'}`}>
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
          <PdfView file={file} mode={mode} pagerRef={pagerRef} onPageState={setPageState} onToc={setToc} />
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
          />
        )}
        </div>
        <Toc entries={toc} open={tocOpen} onClose={() => setTocOpen(false)} />
        {mode === 'page' && (
          <PageNav state={pageState} onPrev={() => goPage('prev')} onNext={() => goPage('next')} />
        )}
      </div>
      <Progress mode={mode} pageState={pageState} bodyRef={containerRef} />
      <HoverBinding
        file={file}
        containerRef={containerRef}
        requestSegments={requestSegments}
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
  deps,
}: {
  file: ViewerFilePayload | null
  containerRef: React.RefObject<HTMLDivElement | null>
  requestSegments: (text: string) => void
  deps: unknown[]
}) {
  useHoverHighlight({ file, containerRef, requestSegments, deps })
  return null
}
