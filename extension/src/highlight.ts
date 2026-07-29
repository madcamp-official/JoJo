// 담당 B — 유튜브 자막 hover 하이라이트 + 클릭을 확장(페이지) 안에서 직접 처리.
// 기존엔 좌표를 앱(Electron)으로 보내 오버레이 창에 그렸는데, 실제 마우스는 브라우저
// 페이지가 직접 받으므로(오버레이는 클릭스루) 크로스 프로세스 릴레이 지연 때문에 자막이
// 살짝만 움직여도 hover/클릭이 어긋났다 — 페이지 안에서 직접 그리면 지연이 없고, 뷰포트
// 좌표를 그대로 쓸 수 있어 브라우저 크롬 오프셋 보정도 필요 없다. 스타일은
// shared/highlightStyle.ts(오버레이와 동일 소스)를 그대로 읽어 인라인 스타일로 적용한다.
import { WORD_BOX_STYLE } from '@shared/highlightStyle'
import type { RectPx, SubLine } from '@shared/extension'
import { unionRects } from '@shared/wordMapping'
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
// 한다. 처음엔 `document.documentElement.style.setProperty('cursor', 'pointer', 'important')`
// 로 했으나 실사용 확인 결과 안 먹혔다(유튜브는 진행바 드래그용 grab, 넷플릭스는 자체
// 커서를 자막 컨테이너/조상에 인라인으로 직접 지정해둔 경우가 있어서) — CSS 상속은 "그
// 요소 자신에게 지정된 값이 하나도 없을 때만" 일어나므로, 조상(html)의 인라인
// `!important` 값이 있어도 자손 요소 자신에게 어떤 값이든(비-important 라도) 지정돼
// 있으면 그게 그대로 이기고 상속 자체가 발생하지 않는다 — 조상의 !important 는 자손의
// "값 없음" 상태를 이길 대상이 없어 아무 효과가 없다. 대신 `*` 전체 선택자에 `!important`
// 를 건 스타일시트 규칙을 주입하면, 그 규칙이 각 자손 요소에 직접 매치돼(상속이 아니라
// 매치) 자손의 비-important 인라인 스타일까지 이긴다.
let cursorOverridden = false
let cursorStyleEl: HTMLStyleElement | null = null
function ensureCursorStyle(): HTMLStyleElement {
  if (cursorStyleEl) return cursorStyleEl
  const el = document.createElement('style')
  el.textContent = 'html.nuance-hover-pointer, html.nuance-hover-pointer * { cursor: pointer !important; }'
  document.documentElement.appendChild(el)
  cursorStyleEl = el
  return el
}
function setHoveringCursor(hovering: boolean): void {
  if (hovering === cursorOverridden) return
  cursorOverridden = hovering
  ensureCursorStyle()
  document.documentElement.classList.toggle('nuance-hover-pointer', hovering)
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
    const segments = getWordSegments(line.text)
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
        // groupRects 는 항상 최소 1개(현재 단어 자신)를 포함해 non-null.
        rect: unionRects(groupRects)!,
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
