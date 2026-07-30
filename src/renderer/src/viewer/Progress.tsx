import { useEffect, useState, type RefObject } from 'react'
import type { PageState, ViewerMode } from './pager'

// 화면 아래 진도 표시 — 페이지 모드는 "3 / 16", 스크롤 모드는 읽은 비율(%)이다.
// 스크롤 위치를 어디서 읽는지가 포맷마다 다르다:
//  - txt/pdf: 바깥 스크롤 컨테이너(.viewer-body)
//  - epub: epubjs 가 만든 스크롤러(.epub-container). 게다가 epub 은 챕터 하나씩만 싣기
//    때문에 이 비율은 "책 전체"가 아니라 "이 챕터 안에서의 위치"다.

function findScroller(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  return root.querySelector<HTMLElement>('.epub-container') ?? root
}

export function Progress({
  mode,
  pageState,
  bodyRef,
}: {
  mode: ViewerMode
  pageState: PageState
  bodyRef: RefObject<HTMLElement | null>
}) {
  const [ratio, setRatio] = useState(0)

  // 스크롤 모드에서만 위치를 따라간다. 스크롤러가 나중에 생기는 경우(epub 로딩)가 있어
  // 이벤트만으로는 놓칠 수 있으므로 짧은 주기로도 확인한다.
  useEffect(() => {
    if (mode !== 'scroll') return
    const read = (): void => {
      const el = findScroller(bodyRef.current)
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      setRatio(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0)
    }
    read()
    const timer = window.setInterval(read, 250)
    const el = bodyRef.current
    el?.addEventListener('scroll', read, { passive: true })
    return () => {
      window.clearInterval(timer)
      el?.removeEventListener('scroll', read)
    }
  }, [mode, bodyRef])

  const paged = mode === 'page' && pageState.total > 0
  const percent = paged ? (pageState.current / pageState.total) * 100 : ratio * 100

  return (
    <div className="viewer-progress">
      <div className="viewer-progress-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="viewer-progress-text">
        {paged ? `${pageState.current} / ${pageState.total}` : `${Math.round(percent)}%`}
      </span>
    </div>
  )
}
