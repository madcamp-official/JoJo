// 담당 B — 팝업 원문 문맥의 "화면상 줄" 경계 측정 (PLAN.md §4 팝업 화면)
//
// selection.ts 의 computeLineContextRange 는 extracted.text 의 '\n'(OCR 정규화 후
// 남은 문단 구분) 기준 줄이라, 팝업 화면에 실제로 보이는(너비·폰트에 따라 자동
// 줄바꿈된) 줄과는 다르다(2026-07-29 사용자 피드백) — 화면상 줄은 렌더링된 DOM 없이는
// 알 수 없어(폰트/자간/줄간격이 언어별로 다르고 — .lang-ja/.lang-zh, styles.css —
// text-align:justify 라 줄바꿈 위치 자체는 폰트·너비에만 좌우됨, justify 는 그 줄 안의
// 자간만 늘릴 뿐 줄바꿈 지점을 안 바꾼다) 여기서만 DOM Range API 로 직접 측정한다.

/** referenceEl 과 같은 클래스(폰트/자간/줄간격)·너비로 text 를 오프스크린에 렌더링해,
 *  문자 인덱스별 렌더링 top 좌표를 읽어 "화면상 줄"이 바뀌는 지점을 모두 찾는다.
 *  Range.getClientRects() 는 실제 텍스트 노드에 그대로 적용 가능해서(atom 처럼 글자마다
 *  별도 span 을 만들 필요 없음) 문자 수만큼의 DOM 쿼리만으로 끝난다. */
function measureLineStartOffsets(referenceEl: HTMLElement, text: string): number[] {
  const measureEl = document.createElement('div')
  measureEl.className = referenceEl.className
  measureEl.style.position = 'fixed'
  measureEl.style.top = '-99999px'
  measureEl.style.left = '0'
  measureEl.style.width = `${referenceEl.clientWidth}px`
  measureEl.style.visibility = 'hidden'
  measureEl.style.pointerEvents = 'none'
  const textNode = document.createTextNode(text)
  measureEl.appendChild(textNode)
  document.body.appendChild(measureEl)

  try {
    const range = document.createRange()
    const lineStarts: number[] = [0]
    let prevTop: number | null = null
    for (let i = 0; i < text.length; i++) {
      range.setStart(textNode, i)
      range.setEnd(textNode, i + 1)
      const rect = range.getClientRects()[0]
      const top: number | null = rect ? rect.top : prevTop
      if (top !== null && prevTop !== null && Math.abs(top - prevTop) > 0.5) {
        lineStarts.push(i)
      }
      if (top !== null) prevTop = top
    }
    return lineStarts
  } finally {
    document.body.removeChild(measureEl)
  }
}

function lineIndexOf(lineStarts: number[], pos: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** text 안에서 [selStart, selEnd) 선택이 속한 "화면상 줄"(referenceEl 의 실제 렌더링
 *  너비·폰트 기준)을 찾아, 그 앞 linesBefore줄·뒤 linesAfter줄까지 포함하는 문자 오프셋
 *  범위를 반환한다. referenceEl 의 너비가 0이면(아직 레이아웃 전) null. */
export function measureVisualLineRange(
  referenceEl: HTMLElement,
  text: string,
  selStart: number,
  selEnd: number,
  linesBefore: number,
  linesAfter: number,
): { start: number; end: number } | null {
  if (referenceEl.clientWidth === 0 || text.length === 0) return null

  const lineStarts = measureLineStartOffsets(referenceEl, text)
  const startLine = lineIndexOf(lineStarts, Math.min(selStart, text.length - 1))
  const endLine = lineIndexOf(lineStarts, Math.min(Math.max(selStart, selEnd - 1), text.length - 1))
  const windowStartLine = Math.max(0, startLine - linesBefore)
  const windowEndLine = Math.min(lineStarts.length - 1, endLine + linesAfter)
  const start = lineStarts[windowStartLine]
  const end = windowEndLine + 1 < lineStarts.length ? lineStarts[windowEndLine + 1] : text.length
  return { start, end }
}
