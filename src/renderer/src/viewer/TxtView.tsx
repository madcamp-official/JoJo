import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import type { ViewerFilePayload } from '@shared/types'
import type { PageState, PagerHandle, ViewerMode } from './pager'
import type { ViewerStyle } from './ViewerSettings'

// txt — 빈 줄로 문단을 나눠 <p> 로 그린다. 호버 스택의 기본 문단 선택자가 <p> 라
// (webArticle.ts) 별도 설정 없이 웹페이지와 똑같이 동작한다.
//
// 페이지 모드는 CSS 다단(column)으로 만든다 — 본문 높이를 화면에 고정하고 열 너비를 화면
// 폭과 같게 주면 내용이 화면 크기만큼씩 잘려 가로로 흐르고, 스크롤을 한 화면씩 옮기면
// "한 장 넘기기"가 된다. 줄이 중간에서 잘리지 않는 게 이 방식의 장점이고, 텍스트가 DOM 에
// 그대로 남아 있어 호버 좌표 계산은 아무 영향 없이 그대로 동작한다.
export function TxtView({
  file,
  style,
  mode,
  pagerRef,
  onPageState,
}: {
  file: ViewerFilePayload
  style: ViewerStyle
  mode: ViewerMode
  pagerRef: RefObject<PagerHandle | null>
  onPageState: (s: PageState) => void
}) {
  const { fontSize, margin, letterSpacing, lineHeight } = style
  const paragraphs = (file.text ?? '').split(/\n{2,}/).filter((p) => p.trim())
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  // 페이지 모드의 열 너비는 "화면 폭 − 좌우 여백"이어야 한다. 열 너비는 길이값이라
  // CSS 만으로는 화면 폭에서 뺄 수 없어(column-width 는 % 불가) 여기서 재서 넣는다.
  // 열 간격을 여백의 2배로 두면 한 장 넘길 때 이동량이 정확히 화면 폭 하나가 된다
  // (열너비 + 간격 = (W−2m) + 2m = W).
  const [colWidth, setColWidth] = useState(0)
  // 한 장 넘길 때 옮기는 거리(=화면 폭). 스크롤이 아니라 transform 으로 옮긴다 —
  // scrollLeft 는 `scrollWidth - clientWidth` 로 클램프되는데, 전체 내용 폭이 화면 폭의
  // 정확한 배수가 아니면 **마지막 장에서만** 그 클램프에 걸려 열 시작점에 못 맞춘다
  // (실사용 제보: 마지막 페이지에서 왼쪽 여백만 넓어지고 오른쪽은 끝까지 붙음).
  // transform 은 레이아웃 밖이라 클램프가 없어 모든 장이 같은 위치에 정확히 선다.
  const [pageWidth, setPageWidth] = useState(0)

  // 1단계 — 화면 폭에서 열 너비/한 장 이동거리를 정한다.
  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const per = el.clientWidth
    setPageWidth(per)
    setColWidth(Math.max(80, per - margin * 2))
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
  }, [mode, fontSize, margin, letterSpacing, lineHeight, file, measure])

  // 2단계 — 열 너비가 **실제 레이아웃에 반영된 뒤**에 페이지 수를 セン다. 한 프레임 뒤에
  // 재는 게 핵심이다: 같은 렌더에서 바로 재면 아직 이전(또는 초기 0) 열 너비 기준이라
  // 열이 잘게 쪼개진 상태로 계산돼 페이지 수가 부풀려진다(실측: 7장짜리가 21장으로).
  //
  // 재는 대상도 스크롤 컨테이너가 아니라 본문(article)이다 — 본문에는 transform 이 걸려
  // 있는데, transform 은 그 요소 **안쪽** 스크롤 폭에는 영향을 주지 않아 어느 페이지에
  // 있든 같은 값이 나온다(컨테이너 기준으로 재면 넘긴 만큼 값이 달라진다).
  useEffect(() => {
    if (mode !== 'page') return
    const el = scrollRef.current
    const art = articleRef.current
    if (!el || !art || colWidth <= 0 || pageWidth <= 0) return
    const id = requestAnimationFrame(() => {
      setTotal(Math.max(1, Math.ceil((art.scrollWidth - 1) / pageWidth)))
    })
    return () => cancelAnimationFrame(id)
  }, [mode, colWidth, pageWidth, fontSize, margin, letterSpacing, lineHeight, file])

  // 폰트/여백이 바뀌어 전체 장수가 줄면 지금 페이지가 범위를 벗어날 수 있다.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(0, total - 1)))
  }, [total])

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
        ref={articleRef}
        className="viewer-doc"
        style={
          mode === 'page'
            ? {
                fontSize,
                letterSpacing,
                lineHeight,
                paddingLeft: margin,
                paddingRight: margin,
                columnWidth: colWidth,
                columnGap: margin * 2,
                transform: `translateX(${-page * pageWidth}px)`,
              }
            : { fontSize, letterSpacing, lineHeight, paddingLeft: margin, paddingRight: margin }
        }
      >
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </article>
    </div>
  )
}
