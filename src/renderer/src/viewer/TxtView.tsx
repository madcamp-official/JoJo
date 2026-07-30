import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import type { PageState, PagerHandle, ViewerMode } from './pager'

// txt — 빈 줄로 문단을 나눠 <p> 로 그린다. 호버 스택의 기본 문단 선택자가 <p> 라
// (webArticle.ts) 별도 설정 없이 웹페이지와 똑같이 동작한다.
//
// 페이지 모드는 CSS 다단(column)으로 만든다 — 본문 높이를 화면에 고정하고 열 너비를 화면
// 폭과 같게 주면 내용이 화면 크기만큼씩 잘려 가로로 흐르고, 스크롤을 한 화면씩 옮기면
// "한 장 넘기기"가 된다. 줄이 중간에서 잘리지 않는 게 이 방식의 장점이고, 텍스트가 DOM 에
// 그대로 남아 있어 호버 좌표 계산은 아무 영향 없이 그대로 동작한다.
export function TxtView({
  file,
  fontSize,
  margin,
  mode,
  pagerRef,
  onPageState,
}: {
  file: ViewerFilePayload
  fontSize: number
  margin: number
  mode: ViewerMode
  pagerRef: RefObject<PagerHandle | null>
  onPageState: (s: PageState) => void
}) {
  const paragraphs = (file.text ?? '').split(/\n{2,}/).filter((p) => p.trim())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  // 페이지 모드의 열 너비는 "화면 폭 − 좌우 여백"이어야 한다. 열 너비는 길이값이라
  // CSS 만으로는 화면 폭에서 뺄 수 없어(column-width 는 % 불가) 여기서 재서 넣는다.
  // 열 간격을 여백의 2배로 두면 한 장 넘길 때 이동량이 정확히 화면 폭 하나가 된다
  // (열너비 + 간격 = (W−2m) + 2m = W).
  const [colWidth, setColWidth] = useState(0)

  // 열 개수(=페이지 수)는 폰트 크기·창 크기에 따라 달라지므로 레이아웃이 바뀔 때마다 다시 잰다.
  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const per = el.clientWidth
    setColWidth(Math.max(80, per - margin * 2))
    setTotal(per > 0 ? Math.max(1, Math.round(el.scrollWidth / per)) : 0)
  }, [margin])

  useEffect(() => {
    if (mode !== 'page') {
      setTotal(0)
      setPage(0)
      return
    }
    // 레이아웃이 실제로 반영된 뒤에 재야 한다(폰트 크기 변경 직후 등).
    const id = window.setTimeout(measure, 0)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('resize', measure)
    }
  }, [mode, fontSize, margin, file, measure])

  // 페이지가 바뀌면 그 열이 보이도록 가로 스크롤을 옮긴다.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || mode !== 'page') return
    el.scrollTo({ left: page * el.clientWidth, behavior: 'auto' })
  }, [page, mode, total])

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
    <div className={`txt-scroll${mode === 'page' ? ' paged' : ''}`} ref={scrollRef}>
      <article
        className="viewer-doc"
        style={
          mode === 'page'
            ? { fontSize, paddingLeft: margin, paddingRight: margin, columnWidth: colWidth, columnGap: margin * 2 }
            : { fontSize, paddingLeft: margin, paddingRight: margin }
        }
      >
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </article>
    </div>
  )
}
