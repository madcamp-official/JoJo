// 담당 milleion — 일반 웹페이지 본문 hover 하이라이트 + 클릭. 유튜브/넷플릭스 자막과 같은
// 이유로 페이지 안에서 직접 처리한다(highlight.ts 참고 — 오버레이로 좌표를 릴레이하면
// 크로스 프로세스 지연으로 hover/클릭이 어긋난다).
//
// highlight.ts와 다른 점: 자막은 화면에 2~3줄만 떠 있어 매 mousemove마다 전체 줄의 단어
// rect를 다시 재는 방식이 괜찮지만, 기사 전체 문단(수백 개)에 같은 방식을 쓰면 mousemove
// 마다 수백 번의 Range.getClientRects() 호출이 발생해 너무 느리다 — 그래서
// document.elementFromPoint()로 먼저 "어느 문단이냐"만 싸게 알아낸 뒤, 그 문단 하나에
// 대해서만 wordsInParagraph()를 지연 계산 + 캐시한다(다른 문단으로 옮길 때만 재계산).
import { WORD_BOX_STYLE } from '@shared/highlightStyle'
import type { RectPx, SubWord } from '@shared/extension'
import type { ArticleExtraction, ArticleParagraph } from './webArticle'
import { wordsInParagraph } from './webArticle'

export interface ArticleWordHit {
  text: string
  fullText: string
  anchorStart: number
  anchorEnd: number
}

let box: HTMLDivElement | null = null

// 전체화면 API는 전체화면 엘리먼트와 그 자손만 top layer에 그린다(highlight.ts와 동일 이유).
function boxParent(): HTMLElement {
  return (document.fullscreenElement as HTMLElement | null) ?? document.documentElement
}

function ensureBox(): HTMLDivElement {
  if (box) return box
  const el = document.createElement('div')
  el.id = 'nuance-article-word-highlight'
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

function onFullscreenChange(): void {
  if (box) boxParent().appendChild(box)
}

// 박스 자신은 pointerEvents:none 이라 실제 마우스는 밑에 깔린 페이지 요소가 받는다 —
// highlight.ts와 동일한 이유로 `*` 전체 선택자에 !important 를 건 스타일시트를 주입해야
// 조상 인라인 스타일이 있어도 자손까지 커서가 강제 적용된다.
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

// 문단별 단어 rect 캐시 — 같은 문단에 마우스가 머무는 동안은 재계산하지 않는다.
let cachedParagraph: HTMLParagraphElement | null = null
let cachedWords: SubWord[] = []
let cachedOffsets: number[] = []

function invalidateCache(): void {
  cachedParagraph = null
  cachedWords = []
  cachedOffsets = []
}

// 문단 텍스트 안에서 각 단어의 문자 오프셋을 순서대로 찾는다(같은 단어가 반복돼도
// searchFrom 덕에 이전 단어와 안 섞인다) — highlight.ts의 동일 로직과 같은 이유.
function paragraphOffsets(paragraphText: string, words: SubWord[]): number[] {
  let searchFrom = 0
  const offsets: number[] = []
  for (const w of words) {
    const found = paragraphText.indexOf(w.text, searchFrom)
    const off = found >= 0 ? found : searchFrom
    offsets.push(off)
    searchFrom = off + w.text.length
  }
  return offsets
}

let paragraphByEl: Map<HTMLParagraphElement, ArticleParagraph> = new Map()
let fullTextRef = ''

function wordAtPoint(
  x: number,
  y: number,
): { text: string; anchorStart: number; anchorEnd: number; rect: RectPx } | null {
  const target = document.elementFromPoint(x, y)
  const p = target?.closest<HTMLParagraphElement>('p') ?? null
  const info = p ? paragraphByEl.get(p) : undefined
  if (!p || !info) {
    invalidateCache()
    return null
  }
  if (cachedParagraph !== p) {
    cachedParagraph = p
    cachedWords = wordsInParagraph(p)
    cachedOffsets = paragraphOffsets(fullTextRef.slice(info.start, info.end), cachedWords)
  }
  for (let i = 0; i < cachedWords.length; i++) {
    const w = cachedWords[i]!
    const r = w.rect
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      const off = cachedOffsets[i]!
      return { text: w.text, anchorStart: info.start + off, anchorEnd: info.start + off + w.text.length, rect: r }
    }
  }
  return null
}

function onMouseMove(e: MouseEvent): void {
  const hit = wordAtPoint(e.clientX, e.clientY)
  if (hit) showBoxAt(hit.rect)
  else hideBox()
}

let onWordClick: ((hit: ArticleWordHit) => void) | null = null

// capture 단계에서 페이지 자체 클릭 핸들러(링크 이동 등)보다 먼저 가로채 막는다.
function onClick(e: MouseEvent): void {
  const hit = wordAtPoint(e.clientX, e.clientY)
  if (!hit) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  onWordClick?.({ text: hit.text, fullText: fullTextRef, anchorStart: hit.anchorStart, anchorEnd: hit.anchorEnd })
}

// 스크롤/리사이즈로 문단 좌표가 바뀌면 캐시된 rect 가 어긋난다 — 다음 mousemove 에서 다시
// 계산하도록 무효화만 해두고 즉시 재계산하진 않는다(스크롤 중엔 hover 판정이 급하지 않고,
// 다음 mousemove 가 곧 온다).
function onViewportChange(): void {
  invalidateCache()
}

export function startArticleHighlight(
  extraction: ArticleExtraction,
  onClickFn: (hit: ArticleWordHit) => void,
): () => void {
  fullTextRef = extraction.fullText
  paragraphByEl = new Map(extraction.paragraphs.map((p) => [p.el, p]))
  onWordClick = onClickFn
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('scroll', onViewportChange, { passive: true, capture: true })
  window.addEventListener('resize', onViewportChange, { passive: true })
  document.addEventListener('fullscreenchange', onFullscreenChange)
  return () => {
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('scroll', onViewportChange, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', onViewportChange)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    hideBox()
    invalidateCache()
    paragraphByEl = new Map()
    onWordClick = null
  }
}
