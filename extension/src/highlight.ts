// 담당 B — 유튜브 자막 hover 하이라이트 + 클릭을 확장(페이지) 안에서 직접 처리.
// 기존엔 좌표를 앱(Electron)으로 보내 오버레이 창에 그렸는데, 실제 마우스는 브라우저
// 페이지가 직접 받으므로(오버레이는 클릭스루) 크로스 프로세스 릴레이 지연 때문에 자막이
// 살짝만 움직여도 hover/클릭이 어긋났다 — 페이지 안에서 직접 그리면 지연이 없고, 뷰포트
// 좌표를 그대로 쓸 수 있어 브라우저 크롬 오프셋 보정도 필요 없다. 스타일은
// shared/highlightStyle.ts(오버레이와 동일 소스)를 그대로 읽어 인라인 스타일로 적용한다.
import type { RectPx, SubLine } from '@shared/extension'
import { groupRectsByLine } from '@shared/wordMapping'
import { hideHoverBox, showHoverBoxesAt } from './hoverBox'
import { getWordSegments } from './wordSegments'

export interface WordHit {
  text: string
  lineText: string
  wordOffsetInLine: number
}

// CJK(중국어/일본어) 자막 줄은 youtube.ts가 공백 없이 글자 단위로 쪼개서 넘긴다(브라우저가
// 스스로 단어 경계를 알 방법이 없어서) — 앱이 자신의 zh/ja 세그멘터로 분석한 결과를
// 받으면(content.ts 경유, wordSegments.ts 에 캐시) hover 히트테스트 시 같은 세그먼트에
// 속한 글자들의 rect 를 하나로 묶어 보여준다. 아직 분석 결과가 없는 줄은 글자 단위로
// 폴백한다.
//
// hover 박스 렌더링(줄바꿈에 걸치면 줄마다 따로 그리는 박스 풀)/커서 오버라이드/전체화면
// 재부착은 웹 문단(articleHighlight.ts)과 공유하는 hoverBox.ts 로 옮겼다 — 자막/웹 모드가
// 각자 복제해 갖고 있었을 때 한쪽만 고쳐지고 다른 쪽이 뒤처지는 드리프트가 실제로
// 있었다(2026-07-30).

function wordAtPoint(lines: SubLine[], x: number, y: number): (WordHit & { rects: RectPx[] }) | null {
  for (const line of lines) {
    // line.words[].start/end 는 domWords.ts extractWordsAndText 가 line.text 를 조립하는
    // 바로 그 순회에서 함께 계산해 실어 보낸 절대 오프셋이다(2026-07-30 수정 — 예전엔
    // 여기서 line.text.indexOf(w.text, searchFrom) 로 매번 역산했는데, 단어 하나의 rect
    // 측정이 실패해 words 배열에서 빠지면 그 뒤로 오프셋이 앞쪽 중복 글자로 미끄러지는
    // 문제가 있었다 — 자세한 사례는 articleHighlight.ts의 동일 수정 주석 참고).
    const segments = getWordSegments(line.text)
    for (const w of line.words) {
      const r = w.rect
      if (!(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue
      const seg = segments?.find((s) => w.start >= s.start && w.start < s.end)
      if (!seg) return { text: w.text, lineText: line.text, wordOffsetInLine: w.start, rects: [r] }
      // CJK 형태소 분석 결과가 있으면 같은 세그먼트에 속한 글자들의 rect 를 하나로 묶는다.
      const groupRects: RectPx[] = []
      for (const other of line.words) {
        if (other.start >= seg.start && other.start < seg.end) groupRects.push(other.rect)
      }
      return {
        text: line.text.slice(seg.start, seg.end),
        lineText: line.text,
        wordOffsetInLine: seg.start,
        // 세그먼트가 화면 줄바꿈에 걸치면(articleHighlight.ts의 동일 수정 주석 참고)
        // 줄마다 따로 묶는다 — groupRects 는 항상 최소 1개(현재 단어 자신)를 포함.
        rects: groupRectsByLine(groupRects),
      }
    }
  }
  return null
}

let getLines: (() => SubLine[]) | null = null
let onWordClick: ((hit: WordHit) => void) | null = null

function onMouseMove(e: MouseEvent): void {
  const hit = wordAtPoint(getLines?.() ?? [], e.clientX, e.clientY)
  if (hit) showHoverBoxesAt(hit.rects)
  else hideHoverBox()
}

// capture 단계에서 유튜브 자체 클릭 핸들러(재생/일시정지 토글 등)보다 먼저 가로채 막는다.
function onClick(e: MouseEvent): void {
  const hit = wordAtPoint(getLines?.() ?? [], e.clientX, e.clientY)
  if (!hit) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  // 클릭 즉시 박스를 지운다 — articleHighlight.ts와 동일한 이유(클릭 후 팝업이 뜨는 동안
  // 이전 hover 위치의 박스가 그대로 남아있으면 안 된다, 2026-07-30 로직 통합).
  hideHoverBox()
  onWordClick?.(hit)
}

// 스크롤/리사이즈되면 자막 위치가 바뀌므로, 화면 고정 좌표(position:fixed)로 떠 있는
// 박스를 즉시 숨긴다 — articleHighlight.ts와 동일한 이유(다음 mousemove가 올 때까지
// 이전 위치에 박스가 남아있던 문제, 2026-07-30 로직 통합). 다음 mousemove 가 오면
// wordAtPoint 가 새 위치를 다시 계산해 필요하면 다시 보여준다.
function onViewportChange(): void {
  hideHoverBox()
}

export function startHighlight(getLinesFn: () => SubLine[], onClickFn: (hit: WordHit) => void): () => void {
  getLines = getLinesFn
  onWordClick = onClickFn
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('scroll', onViewportChange, { passive: true, capture: true })
  window.addEventListener('resize', onViewportChange, { passive: true })
  return () => {
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('scroll', onViewportChange, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', onViewportChange)
    hideHoverBox()
    getLines = null
    onWordClick = null
  }
}
