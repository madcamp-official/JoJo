// 담당 B — 유튜브 자막 hover 하이라이트 + 클릭을 확장(페이지) 안에서 직접 처리.
// 기존엔 좌표를 앱(Electron)으로 보내 오버레이 창에 그렸는데, 실제 마우스는 브라우저
// 페이지가 직접 받으므로(오버레이는 클릭스루) 크로스 프로세스 릴레이 지연 때문에 자막이
// 살짝만 움직여도 hover/클릭이 어긋났다 — 페이지 안에서 직접 그리면 지연이 없고, 뷰포트
// 좌표를 그대로 쓸 수 있어 브라우저 크롬 오프셋 보정도 필요 없다. 스타일은
// shared/highlightStyle.ts(오버레이와 동일 소스)를 그대로 읽어 인라인 스타일로 적용한다.
import { WORD_BOX_STYLE } from '@shared/highlightStyle'
import type { RectPx, SubLine, WordSegment } from '@shared/extension'

export interface WordHit {
  text: string
  lineText: string
  wordOffsetInLine: number
}

// CJK(중국어/일본어) 자막 줄은 youtube.ts가 공백 없이 글자 단위로 쪼개서 넘긴다(브라우저가
// 스스로 단어 경계를 알 방법이 없어서) — 앱이 자신의 zh/ja 세그멘터로 분석한 결과를
// 받으면(content.ts 경유) 여기 캐시해뒀다가, hover 히트테스트 시 같은 세그먼트에 속한
// 글자들의 rect 를 하나로 묶어 보여준다. 아직 분석 결과가 없는 줄은 글자 단위로 폴백한다.
const wordSegmentsByLine = new Map<string, WordSegment[]>()
export function setWordSegments(lineText: string, words: WordSegment[]): void {
  wordSegmentsByLine.set(lineText, words)
}

let box: HTMLDivElement | null = null

// 전체화면 API는 전체화면으로 전환된 엘리먼트(보통 플레이어 div, <html> 전체가 아님)와 그
// 자손만 "top layer"에 그린다 — 박스가 document.documentElement 에 그대로 붙어있으면 그
// top layer 바깥이라 전체화면 중엔 안 보인다(실사용 확인). 지금 전체화면 엘리먼트가 있으면
// 그 안에, 없으면 documentElement 에 붙인다.
function boxParent(): HTMLElement {
  return (document.fullscreenElement as HTMLElement | null) ?? document.documentElement
}

function ensureBox(): HTMLDivElement {
  if (box) return box
  const el = document.createElement('div')
  el.id = 'nuance-word-highlight'
  Object.assign(el.style, {
    position: 'fixed',
    boxSizing: 'border-box',
    border: `${WORD_BOX_STYLE.borderWidth}px solid ${WORD_BOX_STYLE.borderColor}`,
    background: WORD_BOX_STYLE.background,
    borderRadius: `${WORD_BOX_STYLE.borderRadius}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
    display: 'none',
  })
  boxParent().appendChild(el)
  box = el
  return el
}

// 전체화면 진입/해제 시 박스를 새 top layer 대상 안으로 옮긴다(appendChild 는 이미 자식인
// 노드를 다시 넣으면 같은 부모 안에서 이동만 하므로 항상 안전하게 재부착된다).
function onFullscreenChange(): void {
  if (box) boxParent().appendChild(box)
}

function hideBox(): void {
  if (box) box.style.display = 'none'
  setHoveringCursor(false)
}

function showBoxAt(rect: RectPx): void {
  const el = ensureBox()
  const p = WORD_BOX_STYLE.padding
  el.style.left = `${rect.x - p}px`
  el.style.top = `${rect.y - p}px`
  el.style.width = `${rect.width + p * 2}px`
  el.style.height = `${rect.height + p * 2}px`
  el.style.display = 'block'
  setHoveringCursor(true)
}

// 박스 자신은 pointerEvents:none 이라 실제 마우스는 유튜브 자막 DOM(밑에 깔린 요소)이
// 받는다 — 그래서 박스에 cursor 를 줘도 반영이 안 되고, 대신 문서 전체 cursor 를 강제해야
// 커서가 클릭 가능함을 나타내는 손 모양(검지 편 모양, pointer)으로 바뀐다.
let cursorOverridden = false
function setHoveringCursor(hovering: boolean): void {
  if (hovering === cursorOverridden) return
  cursorOverridden = hovering
  if (hovering) document.documentElement.style.setProperty('cursor', 'pointer', 'important')
  else document.documentElement.style.removeProperty('cursor')
}

function unionRects(rects: RectPx[]): RectPx {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function wordAtPoint(lines: SubLine[], x: number, y: number): (WordHit & { rect: RectPx }) | null {
  for (const line of lines) {
    // line.text 는 세그먼트 원문 그대로(youtube.ts) — 단어 사이 간격이 공백 한 칸이라는
    // 보장이 없다(CJK 는 글자 사이 간격이 0). 각 단어의 실제 위치를 line.text 안에서 순서대로
    // 찾아 offset 을 구한다(searchFrom 부터 찾아 같은 글자가 반복돼도 이전 단어와 안 섞임).
    let searchFrom = 0
    const offsets: number[] = []
    for (const w of line.words) {
      const found = line.text.indexOf(w.text, searchFrom)
      const off = found >= 0 ? found : searchFrom
      offsets.push(off)
      searchFrom = off + w.text.length
    }
    const segments = wordSegmentsByLine.get(line.text)
    for (let i = 0; i < line.words.length; i++) {
      const w = line.words[i]!
      const r = w.rect
      if (!(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue
      const off = offsets[i]!
      const seg = segments?.find((s) => off >= s.start && off < s.end)
      if (!seg) return { text: w.text, lineText: line.text, wordOffsetInLine: off, rect: r }
      // CJK 형태소 분석 결과가 있으면 같은 세그먼트에 속한 글자들의 rect 를 하나로 묶는다.
      const groupRects: RectPx[] = []
      for (let j = 0; j < line.words.length; j++) {
        if (offsets[j]! >= seg.start && offsets[j]! < seg.end) groupRects.push(line.words[j]!.rect)
      }
      return {
        text: line.text.slice(seg.start, seg.end),
        lineText: line.text,
        wordOffsetInLine: seg.start,
        rect: unionRects(groupRects),
      }
    }
  }
  return null
}

let getLines: (() => SubLine[]) | null = null
let onWordClick: ((hit: WordHit) => void) | null = null

function onMouseMove(e: MouseEvent): void {
  const hit = wordAtPoint(getLines?.() ?? [], e.clientX, e.clientY)
  if (hit) showBoxAt(hit.rect)
  else hideBox()
}

// capture 단계에서 유튜브 자체 클릭 핸들러(재생/일시정지 토글 등)보다 먼저 가로채 막는다.
function onClick(e: MouseEvent): void {
  const hit = wordAtPoint(getLines?.() ?? [], e.clientX, e.clientY)
  if (!hit) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  onWordClick?.(hit)
}

export function startHighlight(getLinesFn: () => SubLine[], onClickFn: (hit: WordHit) => void): () => void {
  getLines = getLinesFn
  onWordClick = onClickFn
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('click', onClick, true)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  return () => {
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('click', onClick, true)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    hideBox()
    getLines = null
    onWordClick = null
  }
}
