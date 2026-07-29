// 담당 milleion — 일반 웹페이지(뉴스·웹소설 등) 본문 DOM 텍스트 추출.
// 사이트별 셀렉터 등록 없이, 텍스트 밀도 기반 스코어링으로 본문 컨테이너를 스스로 찾는다
// (Mozilla Readability.js와 같은 발상의 경량 버전). 실측(웹소설 4곳·뉴스 3곳, 2026-07-29)으로
// 이 방식이 통할 공통 구조("본문 하나에 <p> 밀집 + 주변 UI 대비 압도적 텍스트 밀도")를 확인했다.
import type { SubWord } from '@shared/extension'
import { wordsInElement } from './domWords'

// 본문 후보에서 제외할 컨테이너 — nav/footer/광고/댓글 등 흔한 보일러플레이트 패턴.
// 사이트별 등록이 아니라 범용 키워드라 특정 사이트에 종속되지 않는다.
const BOILERPLATE_PATTERN =
  /nav|footer|header|sidebar|menu|comment|advert|banner|social|share|related|breadcrumb|pagination|cookie|popup|modal/i

const CANDIDATE_SELECTOR = 'article, main, [role="main"], div, section'
const MIN_PARAGRAPHS_FOR_CANDIDATE = 3

function isHidden(el: Element): boolean {
  const style = getComputedStyle(el)
  return style.display === 'none' || style.visibility === 'hidden'
}

// 조상 중 하나라도 숨겨져 있으면 진짜로 안 보인다(getComputedStyle 은 상속을 반영하지
// 않는다 — display:none 인 조상 아래 자손은 스스로는 display:block 이어도 화면엔 안 그려짐).
function isVisible(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    if (isHidden(node)) return false
    node = node.parentElement
  }
  return true
}

function isBoilerplate(el: Element): boolean {
  const id = el.id ?? ''
  const cls = typeof el.className === 'string' ? el.className : ''
  return BOILERPLATE_PATTERN.test(id) || BOILERPLATE_PATTERN.test(cls)
}

// 후리가나(<rt>/<rp>) — domWords.ts 와 같은 이유로 실제 본문이 아니라 읽는 법 표기라 제외.
function isFuriganaText(node: Text): boolean {
  return node.parentElement?.closest('rt, rp') != null
}

// root(문단) 안에서 node 까지 올라가며 display:none/visibility:hidden 조상이 있는지 확인한다
// — RoyalRoad 실측(2026-07-29)에서 확인된 anti-scraping 함정: 문단 중간에 display:none
// <span>으로 저작권 경고 문구를 심어둔다. isVisible(문단)만으로는 이 함정을 못 거른다 —
// 문단 자신은 보이고, 그 안의 자손 하나만 숨겨져 있기 때문이다. root 까지만 올라가면 되는
// 이유는 root(문단) 자체의 가시성은 visibleParagraphs()가 이미 확인했기 때문(중복 방지).
function isHiddenWithinRoot(node: Text, root: Element): boolean {
  let el = node.parentElement
  while (el && el !== root.parentElement) {
    if (isHidden(el)) return true
    el = el.parentElement
  }
  return false
}

// 문단 하나의 "진짜 본문" 텍스트 — 숨김 함정 + 후리가나를 모두 제외하고 이어붙인다.
// domWords.ts의 elementTextExcludingFurigana 는 자막 세그먼트 전용(항상 전체가 보임을
// 전제)이라 가시성 체크가 없다 — 본문 문단은 내부에 숨김 함정이 섞일 수 있어 별도로 둔다.
// <br>은 텍스트 노드가 아니라 SHOW_TEXT 워커에는 아예 안 잡힌다 — 그대로 두면 <br>로
// 나뉜 두 텍스트가 구분자 없이 그대로 붙어버린다(실측: RoyalRoad 챕터 제목이
// "Chapter 033<br></strong><strong>Gateways" 구조라 "Chapter 033Gateways"로 붙어 나오는
// 문제, 2026-07-30 사용자 제보). SHOW_ELEMENT도 함께 받아 <br>을 만나면 '\n'을 끼워 넣는다.
function visibleParagraphText(p: HTMLParagraphElement): string {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT
      const t = n as Text
      if (isFuriganaText(t)) return NodeFilter.FILTER_REJECT
      if (isHiddenWithinRoot(t, p)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let text = ''
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === 'BR') text += '\n'
    } else {
      text += (node as Text).textContent ?? ''
    }
    node = walker.nextNode()
  }
  return text
}

function visibleParagraphs(container: Element): HTMLParagraphElement[] {
  return Array.from(container.querySelectorAll<HTMLParagraphElement>('p')).filter(
    (p) => isVisible(p) && !isBoilerplate(p) && !p.closest('figure, figcaption, nav, footer, header, aside'),
  )
}

// 텍스트 밀도 점수: 문단들의 가시 텍스트 길이 합 − 링크 밀도 페널티.
// 링크가 많은 블록(메뉴/관련기사 목록)은 텍스트가 많아 보여도 실제로는 본문이 아니다.
function scoreContainer(container: Element): number {
  const paragraphs = visibleParagraphs(container)
  if (paragraphs.length < MIN_PARAGRAPHS_FOR_CANDIDATE) return -1
  let textLen = 0
  let linkLen = 0
  for (const p of paragraphs) {
    textLen += visibleParagraphText(p).length
    for (const a of Array.from(p.querySelectorAll('a'))) linkLen += (a.textContent ?? '').length
  }
  if (textLen === 0) return -1
  const linkDensity = linkLen / textLen
  return textLen * (1 - Math.min(linkDensity, 0.9))
}

// 페이지 전체에서 본문 컨테이너 후보를 스코어링해 최고점 하나를 고른다.
export function findMainContent(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).filter(
    (el) => isVisible(el) && !isBoilerplate(el),
  )
  let best: HTMLElement | null = null
  let bestScore = 0
  for (const el of candidates) {
    const score = scoreContainer(el)
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

export interface ArticleParagraph {
  el: HTMLParagraphElement
  start: number
  end: number
}

export interface ArticleExtraction {
  fullText: string
  paragraphs: ArticleParagraph[]
}

// container 안의 본문 문단을 이어붙여 전체 텍스트를 조립한다. 각 문단의 [start,end) 오프셋을
// fullText 기준으로 미리 기록해두면, 클릭 시(articleHighlight.ts) 별도 텍스트 검색 없이
// 바로 절대 오프셋을 계산할 수 있다(subtitleSource.ts의 anchorInTranscript와 달리 문자열
// 재검색이 필요 없음 — 확장이 조립 시점에 오프셋을 이미 알고 있으므로).
export function extractArticleText(container: Element): ArticleExtraction {
  const paragraphs: ArticleParagraph[] = []
  let fullText = ''
  for (const p of visibleParagraphs(container)) {
    const text = visibleParagraphText(p)
    if (!text.trim()) continue
    const start = fullText.length
    fullText += text
    paragraphs.push({ el: p, start, end: fullText.length })
    fullText += '\n'
  }
  return { fullText, paragraphs }
}

// 문단 하나의 단어별 뷰포트 사각형 — hover 히트테스트용(articleHighlight.ts 가 지연 호출).
// wordsInElement 자체는 이미 범용(자막 세그먼트 전용이 아님)이라 그대로 재사용한다.
export function wordsInParagraph(p: HTMLParagraphElement): SubWord[] {
  return wordsInElement(p)
}
