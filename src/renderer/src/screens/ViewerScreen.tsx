import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import { setWordSegments } from '@shared/hover/wordSegments'
import { TxtView } from '../viewer/TxtView'
import { PdfView } from '../viewer/PdfView'
import { EpubView } from '../viewer/EpubView'
import { useHoverHighlight } from '../viewer/useHoverHighlight'
import { ArrowLeftIcon, MoonIcon, ScrollIcon, PageIcon, SunIcon } from './icons'
import { PageNav } from '../viewer/PageNav'
import { EMPTY_PAGE_STATE, type PageState, type PagerHandle, type ViewerMode } from '../viewer/pager'

// 자체 문서 뷰어(pdf/epub/txt) — 외부 뷰어(크롬 내장 PDF 뷰어·Kindle 등)는 텍스트나 좌표를
// 신뢰할 수 있게 주지 않아서(TODO.md 96~111 조사) 우리가 직접 파싱·렌더링한다. 우리 DOM
// 위에서 확장이 웹페이지에 쓰는 것과 **같은 소스**(@shared/hover)로 호버박스를 띄우므로
// 접근성 API 도 OCR 도 필요 없고 mac/Windows 가 동일하게 동작한다.

const FONT_SIZE_MIN = 12
const FONT_SIZE_MAX = 32
const FONT_SIZE_DEFAULT = 18
// 좌우 여백(px) — 글자 크기와 **독립**으로 사용자가 고정한다. 예전엔 본문 폭을 `44em`
// (글자 크기 배수)로 잡아서, 글자를 줄이면 줄바꿈은 그대로인 채 여백만 넓어졌다
// (2026-07-31 사용자 제보). 이제 여백은 이 값으로 고정되고 글자 크기만 바뀌므로,
// 줄바꿈은 "고정된 폭 안에 글자가 몇 개 들어가는지"에 따라 자연스럽게 다시 잡힌다.
const MARGIN_MIN = 0
const MARGIN_MAX = 320
const MARGIN_DEFAULT = 72

export function ViewerScreen() {
  const [file, setFile] = useState<ViewerFilePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(FONT_SIZE_DEFAULT)
  const [margin, setMargin] = useState(MARGIN_DEFAULT)
  const [dark, setDark] = useState(false)
  const [mode, setMode] = useState<ViewerMode>('scroll')
  const [pageState, setPageState] = useState<PageState>(EMPTY_PAGE_STATE)
  const containerRef = useRef<HTMLDivElement>(null)
  // 각 뷰(pdf/epub/txt)가 자기 방식대로 채워 넣는 "넘기기" 핸들 — 넘기는 방법은 포맷마다
  // 다르지만(pager.ts 주석) 화살표 버튼·방향키는 이 핸들 하나만 부른다.
  const pagerRef = useRef<PagerHandle | null>(null)

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
        pagerRef.current?.prev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        pagerRef.current?.next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  // 모드를 바꾸면 이전 모드의 페이지 상태(화살표 활성 여부 등)는 의미가 없다.
  useEffect(() => setPageState(EMPTY_PAGE_STATE), [mode, file])

  return (
    <div className={`screen viewer-screen${dark && isReflowable ? ' dark' : ''}`}>
      <header className="viewer-toolbar">
        <button className="viewer-back" title="메인으로" onClick={() => void window.nuance.viewerBack()}>
          <ArrowLeftIcon />
        </button>
        <span className="viewer-title" title={file?.path}>
          {file?.name ?? '문서'}
        </span>
        <div className="viewer-controls">
          {/* 스크롤 ↔ 페이지 전환 — 세 포맷 모두 지원한다(구현 방식만 포맷별로 다름). */}
          <button
            className="viewer-mode"
            title={mode === 'page' ? '스크롤 모드로' : '페이지 모드로'}
            onClick={() => setMode((m) => (m === 'page' ? 'scroll' : 'page'))}
          >
            {mode === 'page' ? <ScrollIcon /> : <PageIcon />}
            {mode === 'page' ? '스크롤' : '페이지'}
          </button>
          {isReflowable && (
            <>
            <button
              className="viewer-theme"
              title={dark ? '라이트 모드로' : '다크 모드로'}
              onClick={() => setDark((v) => !v)}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
            <label className="viewer-font-control">
              여백
              <input
                type="range"
                min={MARGIN_MIN}
                max={MARGIN_MAX}
                step={8}
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value))}
              />
              <span className="viewer-font-value">{margin}px</span>
            </label>
            <label className="viewer-font-control">
              글자 크기
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
              <span className="viewer-font-value">{fontSize}px</span>
            </label>
            </>
          )}
        </div>
      </header>

      <div className="viewer-body" ref={containerRef}>
        {error && <p className="hint">{error}</p>}
        {!file && !error && <p className="hint">불러오는 중…</p>}
        {file?.kind === 'txt' && (
          <TxtView file={file} fontSize={fontSize} margin={margin} mode={mode} pagerRef={pagerRef} onPageState={setPageState} />
        )}
        {file?.kind === 'pdf' && (
          <PdfView file={file} mode={mode} pagerRef={pagerRef} onPageState={setPageState} />
        )}
        {file?.kind === 'epub' && (
          <EpubView
            file={file}
            fontSize={fontSize}
            margin={margin}
            dark={dark}
            mode={mode}
            pagerRef={pagerRef}
            onPageState={setPageState}
          />
        )}
        {mode === 'page' && (
          <PageNav
            state={pageState}
            onPrev={() => pagerRef.current?.prev()}
            onNext={() => pagerRef.current?.next()}
          />
        )}
      </div>
      <HoverBinding
        file={file}
        containerRef={containerRef}
        requestSegments={requestSegments}
        deps={[fontSize, margin, dark, mode, pageState]}
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
