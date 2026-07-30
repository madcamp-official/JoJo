// 담당 milleion — 일반 웹페이지 본문 hover 하이라이트 + 클릭. 유튜브/넷플릭스 자막과 같은
// 이유로 페이지 안에서 직접 처리한다(highlight.ts 참고 — 오버레이로 좌표를 릴레이하면
// 크로스 프로세스 지연으로 hover/클릭이 어긋난다).
//
// highlight.ts와 다른 점: 자막은 화면에 2~3줄만 떠 있어 매 mousemove마다 전체 줄의 단어
// rect를 다시 재는 방식이 괜찮지만, 기사 전체 문단(수백 개)에 같은 방식을 쓰면 mousemove
// 마다 수백 번의 Range.getClientRects() 호출이 발생해 너무 느리다 — 그래서
// document.elementFromPoint()로 먼저 "어느 문단이냐"만 싸게 알아낸 뒤, 그 문단 하나에
// 대해서만 wordsInParagraph()를 지연 계산 + 캐시한다(다른 문단으로 옮길 때만 재계산).
import type { RectPx, SubWord } from '@shared/extension'
import { groupSegmentAt } from '@shared/wordMapping'
import { hideHoverBox, setHoverBoxDocument, showHoverBoxesAt } from './hoverBox'
import type { ArticleExtraction, ArticleParagraph } from './webArticle'
import { extractArticleText, wordsInParagraph } from './webArticle'
import { getWordSegments } from './wordSegments'

export interface ArticleWordHit {
  text: string
  fullText: string
  anchorStart: number
  anchorEnd: number
}

// hover 박스 렌더링(줄바꿈에 걸치면 줄마다 따로 그리는 박스 풀)/커서 오버라이드/전체화면
// 재부착은 자막(highlight.ts)과 공유하는 hoverBox.ts 로 옮겼다(2026-07-30, 자막/웹 각자
// 복제해 갖고 있던 드리프트 정리).

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

// 형태소 분석을 이미 요청한 문단 텍스트와 그 요청 시각 — 같은 문단을 짧은 시간 안에 여러
// 번 재진입해도 중복 요청하지 않는다(응답 전 다시 hover해도 재요청 안 함). 시각을 남겨
// SEGMENT_RETRY_MS 가 지나면 재시도한다 — 예전엔 영구 Set(한 번 요청하면 끝까지 스킵)이라,
// 요청이 앱(bridge.ts)까지는 갔지만 응답이 확장 쪽에 전달되지 못하면(탭 전환 중 릴레이
// 실패 등) 그 문단이 영원히 글자 단위 hover 로 고정되는 문제가 있었다(2026-07-30).
const SEGMENT_RETRY_MS = 4000
const requestedSegmentsAt = new Map<string, number>()
let requestSegmentsFn: ((text: string) => void) | null = null

function ensureSegmentsRequested(paragraphText: string): void {
  if (!CJK_CHAR_RE.test(paragraphText)) return
  if (getWordSegments(paragraphText)) return
  const requestedAt = requestedSegmentsAt.get(paragraphText)
  if (requestedAt !== undefined && Date.now() - requestedAt < SEGMENT_RETRY_MS) return
  requestedSegmentsAt.set(paragraphText, Date.now())
  requestSegmentsFn?.(paragraphText)
}

// idx 번째 단어가 형태소 분석 결과(세그먼트)에 속하면 같은 세그먼트의 글자들을 하나로
// 묶어 반환한다(rect는 union, text/오프셋은 세그먼트 경계 기준) — highlight.ts와 같은
// 이유로 shared/wordMapping.ts의 groupSegmentAt 으로 통합했다(2026-07-30, 자막/웹 각자
// 복제해 갖고 있던 드리프트 정리). 세그먼트가 없으면(분석 전/비CJK) 단어 그대로 반환.
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
): { rects: RectPx[]; text: string; start: number; end: number } {
  return groupSegmentAt(paragraphText, words, words[idx]!, getWordSegments(paragraphText))
}

// hover 박스가 어떤 문단을 대상으로 할지 판정하는 데만 쓴다(캡처 시작 시점 스냅샷 —
// 정확한 앵커 계산은 클릭 시 resolveClick 이 항상 다시 라이브로 만든다).
let paragraphByEl: Map<HTMLParagraphElement, ArticleParagraph> = new Map()
let fullTextRef = ''
// 클릭 시 fullText 를 다시 추출하려면 컨테이너가 필요하다(아래 resolveClick 참고).
let containerRef: Element | null = null

// 이벤트·히트테스트가 어느 문서 기준인지 — 전역 document/window 를 직접 쓰지 않고
// 컨테이너에서 유도한다. 웹페이지·자체 뷰어(txt/pdf)는 그냥 전역과 같지만, 자체 뷰어의
// epub 은 epubjs 가 내용을 iframe 안에 띄우므로 그 iframe 의 문서여야 한다.
let docRef: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
let winRef: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)

// 문단으로 볼 요소의 선택자 — 웹페이지/txt/epub 은 <p>(기본값), PDF 는 pdf.js 텍스트
// 레이어가 만드는 span 이다(startArticleHighlight 의 opts.paragraphSelector 로 주입).
let paragraphSelectorRef = 'p'

function findWordIndexAt(words: SubWord[], x: number, y: number): number {
  for (let i = 0; i < words.length; i++) {
    const r = words[i]!.rect
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return i
  }
  return -1
}

// hover 박스 표시 전용 — 캐시(성능 목적)를 쓴다. 클릭 결과 전송에는 안 쓴다(resolveClick 참고).
function hoverHitAt(x: number, y: number): RectPx[] | null {
  const target = docRef.elementFromPoint(x, y)
  const p = target?.closest<HTMLParagraphElement>(paragraphSelectorRef) ?? null
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
  return groupWordAt(paragraphText, cachedWords, idx).rects
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
  const target = docRef.elementFromPoint(x, y)
  const p = target?.closest<HTMLParagraphElement>(paragraphSelectorRef) ?? null
  if (!p) return null
  const fresh = extractArticleText(containerRef, paragraphSelectorRef)
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
  const rects = hoverHitAt(e.clientX, e.clientY)
  if (rects) showHoverBoxesAt(rects)
  else hideHoverBox()
}

let onWordClick: ((hit: ArticleWordHit) => void) | null = null

// capture 단계에서 페이지 자체 클릭 핸들러(링크 이동 등)보다 먼저 가로채 막는다.
function onClick(e: MouseEvent): void {
  const hit = resolveClick(e.clientX, e.clientY)
  if (!hit) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  hideHoverBox()
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
  hideHoverBox()
}

export interface ArticleHighlightOptions {
  /** 문단으로 볼 요소의 선택자 — 기본 'p'. PDF 는 pdf.js 텍스트 레이어 span 을 넘긴다. */
  paragraphSelector?: string
}

export function startArticleHighlight(
  container: Element,
  extraction: ArticleExtraction,
  onClickFn: (hit: ArticleWordHit) => void,
  requestSegments: (text: string) => void,
  opts: ArticleHighlightOptions = {},
): () => void {
  containerRef = container
  // 전역이 아니라 컨테이너가 속한 문서를 쓴다 — epub(epubjs iframe)이면 그 iframe 의
  // 문서/창이라, 리스너·히트테스트·박스 좌표가 전부 같은 좌표계로 일관되게 맞는다.
  docRef = container.ownerDocument ?? document
  winRef = docRef.defaultView ?? window
  paragraphSelectorRef = opts.paragraphSelector ?? 'p'
  setHoverBoxDocument(docRef)
  fullTextRef = extraction.fullText
  paragraphByEl = new Map(extraction.paragraphs.map((p) => [p.el, p]))
  onWordClick = onClickFn
  requestSegmentsFn = requestSegments
  winRef.addEventListener('mousemove', onMouseMove, true)
  winRef.addEventListener('click', onClick, true)
  winRef.addEventListener('scroll', onViewportChange, { passive: true, capture: true })
  winRef.addEventListener('resize', onViewportChange, { passive: true })
  return () => {
    winRef.removeEventListener('mousemove', onMouseMove, true)
    winRef.removeEventListener('click', onClick, true)
    winRef.removeEventListener('scroll', onViewportChange, { capture: true } as EventListenerOptions)
    winRef.removeEventListener('resize', onViewportChange)
    hideHoverBox()
    invalidateCache()
    paragraphByEl = new Map()
    fullTextRef = ''
    containerRef = null
    onWordClick = null
    requestSegmentsFn = null
    requestedSegmentsAt.clear()
  }
}
