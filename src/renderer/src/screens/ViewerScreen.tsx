import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import { setWordSegments } from '@shared/hover/wordSegments'
import { TxtView } from '../viewer/TxtView'
import { PdfView } from '../viewer/PdfView'
import { EpubView } from '../viewer/EpubView'
import { useHoverHighlight } from '../viewer/useHoverHighlight'

// 자체 문서 뷰어(pdf/epub/txt) — 외부 뷰어(크롬 내장 PDF 뷰어·Kindle 등)는 텍스트나 좌표를
// 신뢰할 수 있게 주지 않아서(TODO.md 96~111 조사) 우리가 직접 파싱·렌더링한다. 우리 DOM
// 위에서 확장이 웹페이지에 쓰는 것과 **같은 소스**(@shared/hover)로 호버박스를 띄우므로
// 접근성 API 도 OCR 도 필요 없고 mac/Windows 가 동일하게 동작한다.

const FONT_SIZE_MIN = 12
const FONT_SIZE_MAX = 32
const FONT_SIZE_DEFAULT = 18

export function ViewerScreen() {
  const [file, setFile] = useState<ViewerFilePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(FONT_SIZE_DEFAULT)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const showFontControl = file?.kind === 'txt' || file?.kind === 'epub'

  return (
    <div className="screen viewer-screen">
      <header className="viewer-toolbar">
        <span className="viewer-title" title={file?.path}>
          {file?.name ?? '문서'}
        </span>
        {showFontControl && (
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
        )}
      </header>

      <div className="viewer-body" ref={containerRef}>
        {error && <p className="hint">{error}</p>}
        {!file && !error && <p className="hint">불러오는 중…</p>}
        {file?.kind === 'txt' && <TxtView file={file} fontSize={fontSize} />}
        {file?.kind === 'pdf' && <PdfView file={file} />}
        {file?.kind === 'epub' && <EpubView file={file} fontSize={fontSize} />}
      </div>
      <HoverBinding file={file} containerRef={containerRef} requestSegments={requestSegments} deps={[fontSize]} />
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
