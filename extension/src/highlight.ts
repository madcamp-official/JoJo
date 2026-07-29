// 담당 B — 유튜브 자막 hover 하이라이트 + 클릭을 확장(페이지) 안에서 직접 처리.
// 기존엔 좌표를 앱(Electron)으로 보내 오버레이 창에 그렸는데, 실제 마우스는 브라우저
// 페이지가 직접 받으므로(오버레이는 클릭스루) 크로스 프로세스 릴레이 지연 때문에 자막이
// 살짝만 움직여도 hover/클릭이 어긋났다 — 페이지 안에서 직접 그리면 지연이 없고, 뷰포트
// 좌표를 그대로 쓸 수 있어 브라우저 크롬 오프셋 보정도 필요 없다. 스타일은
// shared/highlightStyle.ts(오버레이와 동일 소스)를 그대로 읽어 인라인 스타일로 적용한다.
import { WORD_BOX_STYLE } from '@shared/highlightStyle'
import type { RectPx, SubLine } from '@shared/extension'

export interface WordHit {
  text: string
  lineText: string
  wordOffsetInLine: number
}

let box: HTMLDivElement | null = null

function ensureBox(): HTMLDivElement {
  if (box) return box
  const el = document.createElement('div')
  el.id = 'nuance-word-highlight'
  Object.assign(el.style, {
    position: 'fixed',
    boxSizing: 'border-box',
    border: `${WORD_BOX_STYLE.borderWidth}px solid ${WORD_BOX_STYLE.borderColor}`,
    background: WORD_BOX_STYLE.background,
    pointerEvents: 'none',
    zIndex: '2147483647',
    display: 'none',
  })
  document.documentElement.appendChild(el)
  box = el
  return el
}

function hideBox(): void {
  if (box) box.style.display = 'none'
}

function showBoxAt(rect: RectPx): void {
  const el = ensureBox()
  const p = WORD_BOX_STYLE.padding
  el.style.left = `${rect.x - p}px`
  el.style.top = `${rect.y - p}px`
  el.style.width = `${rect.width + p * 2}px`
  el.style.height = `${rect.height + p * 2}px`
  el.style.display = 'block'
}

function wordAtPoint(lines: SubLine[], x: number, y: number): (WordHit & { rect: RectPx }) | null {
  for (const line of lines) {
    // line.text 는 이제 세그먼트 원문 그대로(youtube.ts) — 단어 사이 간격이 공백 한 칸이라는
    // 보장이 없다(CJK 는 글자 사이 간격이 0). 각 단어의 실제 위치를 line.text 안에서 순서대로
    // 찾아 offset 을 구한다(searchFrom 부터 찾아 같은 글자가 반복돼도 이전 단어와 안 섞임).
    let searchFrom = 0
    for (const w of line.words) {
      const r = w.rect
      const found = line.text.indexOf(w.text, searchFrom)
      const wordOffsetInLine = found >= 0 ? found : searchFrom
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return { text: w.text, lineText: line.text, wordOffsetInLine, rect: r }
      }
      searchFrom = wordOffsetInLine + w.text.length
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
  return () => {
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('click', onClick, true)
    hideBox()
    getLines = null
    onWordClick = null
  }
}
