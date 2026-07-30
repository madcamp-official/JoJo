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
import { unionRects } from '@shared/wordMapping'
import type { ArticleExtraction, ArticleParagraph } from './webArticle'
import { extractArticleText, wordsInParagraph } from './webArticle'
import { getWordSegments } from './wordSegments'

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

// 문단별 단어 rect 캐시(hover 박스 표시 전용, 성능 목적) — 같은 문단에 마우스가 머무는
// 동안은 재계산하지 않는다. 클릭 결과 전송에는 안 쓴다(resolveClick이 매번 새로 계산).
let cachedParagraph: HTMLParagraphElement | null = null
let cachedWords: SubWord[] = []

function invalidateCache(): void {
  cachedParagraph = null
  cachedWords = []
}

// CJK(중국어/일본어) 문단은 domWords.ts(wordsInParagraph)가 공백 없이 글자 단위로 쪼갠다
// — 브라우저는 스스로 단어 경계를 알 방법이 없어서다(자막과 동일한 이유, highlight.ts
// 참고). 형태소 분석 결과를 요청할지 판단하는 데만 쓰는 가벼운 문자 판정.
const CJK_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿]/

// 형태소 분석을 이미 요청한 문단 텍스트 — 같은 문단을 여러 번 재진입해도 중복 요청하지
// 않는다(응답 전 다시 hover해도 재요청 안 함). 앱 쪽(bridge.ts segmentedLines)도 dedup
// 하지만, 그건 응답이 온 뒤에나 걸러지므로 왕복 전에 여기서 먼저 거른다.
const requestedSegments = new Set<string>()
let requestSegmentsFn: ((text: string) => void) | null = null

function ensureSegmentsRequested(paragraphText: string): void {
  if (!CJK_CHAR_RE.test(paragraphText)) return
  if (getWordSegments(paragraphText) || requestedSegments.has(paragraphText)) return
  requestedSegments.add(paragraphText)
  requestSegmentsFn?.(paragraphText)
}

// idx 번째 단어가 형태소 분석 결과(세그먼트)에 속하면 같은 세그먼트의 글자들을 하나로
// 묶어 반환한다(rect는 union, text/오프셋은 세그먼트 경계 기준) — highlight.ts의 동일
// 그룹핑 로직과 같은 이유. 세그먼트가 없으면(분석 전/비CJK) 단어 그대로 반환.
//
// words[].start/end 는 domWords.ts extractWordsAndText 가 추출 시점에 이미 계산해 실어
// 보낸 절대 오프셋이다(2026-07-30 수정 — 예전엔 여기서 paragraphText.indexOf 로 매번
// 역산했는데, 그 단어 하나의 rect 측정이 실패해 words 배열에서 빠지면 이후 모든 역산
// 오프셋이 앞쪽 중복 글자로 미끄러져, 문단 뒷부분 단어들이 전부 엉뚱하게 낮은 오프셋으로
// 계산되고 그 결과 이 아래 그룹핑이 문단 전체를 하나로 묶어버리는 문제가 있었다).
function groupWordAt(
  paragraphText: string,
  words: SubWord[],
  idx: number,
): { rect: RectPx; text: string; start: number; end: number } {
  const w = words[idx]!
  const segments = getWordSegments(paragraphText)
  const seg = segments?.find((s) => w.start >= s.start && w.start < s.end)
  if (!seg) return { rect: w.rect, text: w.text, start: w.start, end: w.end }
  const groupRects: RectPx[] = []
  for (const other of words) {
    if (other.start >= seg.start && other.start < seg.end) groupRects.push(other.rect)
  }
  // groupRects 는 항상 최소 1개(idx 자신)를 포함해 non-null.
  return { rect: unionRects(groupRects)!, text: paragraphText.slice(seg.start, seg.end), start: seg.start, end: seg.end }
}

// hover 박스가 어떤 문단을 대상으로 할지 판정하는 데만 쓴다(캡처 시작 시점 스냅샷 —
// 정확한 앵커 계산은 클릭 시 resolveClick 이 항상 다시 라이브로 만든다).
let paragraphByEl: Map<HTMLParagraphElement, ArticleParagraph> = new Map()
let fullTextRef = ''
// 클릭 시 fullText 를 다시 추출하려면 컨테이너가 필요하다(아래 resolveClick 참고).
let containerRef: Element | null = null

function findWordIndexAt(words: SubWord[], x: number, y: number): number {
  for (let i = 0; i < words.length; i++) {
    const r = words[i]!.rect
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return i
  }
  return -1
}

// hover 박스 표시 전용 — 캐시(성능 목적)를 쓴다. 클릭 결과 전송에는 안 쓴다(resolveClick 참고).
function hoverHitAt(x: number, y: number): RectPx | null {
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
    ensureSegmentsRequested(fullTextRef.slice(info.start, info.end))
  }
  const idx = findWordIndexAt(cachedWords, x, y)
  if (idx < 0) return null
  const paragraphText = fullTextRef.slice(info.start, info.end)
  return groupWordAt(paragraphText, cachedWords, idx).rect
}

// 클릭 지점의 앵커(본문 전체 텍스트 + 절대 오프셋)를 계산한다. 캡처 시작 시점에 만든
// paragraphByEl(hover용, 위 hoverHitAt)를 쓰지 않고 그 자리에서 컨테이너를 다시 통째로
// 재추출한다 — 클릭까지 시간이 걸리는 동안 페이지가 바뀌면(광고 지연 로드,
// 관련 기사 삽입 등 뉴스 사이트에서 흔함) 캡처 시점 스냅샷과 클릭 시점 라이브 DOM의 문단
// 경계가 어긋나, hover 박스는 맞는 단어를 가리키는데 팝업엔 다른 단어가 선택되는 문제가
// 있었다(2026-07-30 사용자 제보). 텍스트와 오프셋을 항상 "같은 순간"의 라이브 DOM에서
// 함께 만들면 이 어긋남 자체가 원천적으로 생기지 않는다 — 클릭은 드물게 일어나므로 매번
// 전체 재추출해도 비용 문제 없다.
function resolveClick(x: number, y: number): ArticleWordHit | null {
  if (!containerRef) return null
  const target = document.elementFromPoint(x, y)
  const p = target?.closest<HTMLParagraphElement>('p') ?? null
  if (!p) return null
  const fresh = extractArticleText(containerRef)
  const info = fresh.paragraphs.find((fp) => fp.el === p)
  if (!info) return null
  const words = wordsInParagraph(p)
  const idx = findWordIndexAt(words, x, y)
  if (idx < 0) return null
  const paragraphText = fresh.fullText.slice(info.start, info.end)
  // 세그먼트가 아직 응답 전이면(드묾 — hover 때 이미 요청해뒀을 확률이 높음) 글자 단위로
  // 폴백한다(highlight.ts와 동일 특성).
  const grouped = groupWordAt(paragraphText, words, idx)
  return {
    text: grouped.text,
    fullText: fresh.fullText,
    anchorStart: info.start + grouped.start,
    anchorEnd: info.start + grouped.end,
  }
}

function onMouseMove(e: MouseEvent): void {
  const rect = hoverHitAt(e.clientX, e.clientY)
  if (rect) showBoxAt(rect)
  else hideBox()
}

let onWordClick: ((hit: ArticleWordHit) => void) | null = null

// capture 단계에서 페이지 자체 클릭 핸들러(링크 이동 등)보다 먼저 가로채 막는다.
function onClick(e: MouseEvent): void {
  const hit = resolveClick(e.clientX, e.clientY)
  if (!hit) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  hideBox()
  onWordClick?.(hit)
}

// 스크롤/리사이즈되면 밑에 깔린 페이지 내용이 움직이거나 바뀌므로, 화면에 고정 좌표
// (position:fixed)로 떠 있는 박스를 즉시 숨긴다 — 예전엔 다음 mousemove 를 기다리며
// 단어 캐시만 비웠는데, 팝업을 닫은 뒤 마우스를 움직이지 않고 스크롤만 하면(예: 트랙패드/
// 휠) mousemove 가 안 와서 박스가 이전 위치에 그대로 남아있는 문제가 있었다(2026-07-30
// 사용자 제보). 다음 mousemove 가 오면 hoverHitAt 이 새 위치를 다시 계산해 필요하면
// 다시 보여준다.
function onViewportChange(): void {
  invalidateCache()
  hideBox()
}

export function startArticleHighlight(
  container: Element,
  extraction: ArticleExtraction,
  onClickFn: (hit: ArticleWordHit) => void,
  requestSegments: (text: string) => void,
): () => void {
  containerRef = container
  fullTextRef = extraction.fullText
  paragraphByEl = new Map(extraction.paragraphs.map((p) => [p.el, p]))
  onWordClick = onClickFn
  requestSegmentsFn = requestSegments
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
    fullTextRef = ''
    containerRef = null
    onWordClick = null
    requestSegmentsFn = null
    requestedSegments.clear()
  }
}
