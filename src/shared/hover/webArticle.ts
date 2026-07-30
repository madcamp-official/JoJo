// 담당 milleion — 일반 웹페이지(뉴스·웹소설 등) 본문 DOM 텍스트 추출.
// 사이트별 셀렉터 등록 없이, 텍스트 밀도 기반 스코어링으로 본문 컨테이너를 스스로 찾는다
// (Mozilla Readability.js와 같은 발상의 경량 버전). 실측(웹소설 4곳·뉴스 3곳, 2026-07-29)으로
// 이 방식이 통할 공통 구조("본문 하나에 <p> 밀집 + 주변 UI 대비 압도적 텍스트 밀도")를 확인했다.
import type { SubWord } from '@shared/extension'
import { extractWordsAndText, isHidden } from './domWords'

// 본문 후보에서 제외할 컨테이너 — nav/footer/광고/댓글 등 흔한 보일러플레이트 패턴.
// 사이트별 등록이 아니라 범용 키워드라 특정 사이트에 종속되지 않는다.
const BOILERPLATE_PATTERN =
  /nav|footer|header|sidebar|menu|comment|advert|banner|social|share|related|breadcrumb|pagination|cookie|popup|modal/i

const CANDIDATE_SELECTOR = 'article, main, [role="main"], div, section'
const MIN_PARAGRAPHS_FOR_CANDIDATE = 3

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

// 문단 하나의 "진짜 본문" 텍스트 — 숨김 함정(RoyalRoad 식 anti-scraping) + 후리가나 +
// <script>/<style> 코드 원문을 모두 제외하고 <br>은 '\n'으로 이어붙인다. 실제 순회는
// domWords.ts의 extractWordsAndText 가 담당한다 — wordsInParagraph(아래)도 같은 함수를
// 쓰므로 문단 텍스트와 그 안의 단어 오프셋이 항상 같은 좌표계를 갖는다(2026-07-30 수정 —
// 예전엔 이 함수와 wordsInElement 가 서로 다른 순회로 "같은 텍스트일 것"이라 가정했는데,
// 그 가정이 깨지면 호출부(articleHighlight.ts)의 오프셋 역산이 어긋났다).
function visibleParagraphText(p: HTMLParagraphElement): string {
  return extractWordsAndText(p).text
}

function visibleParagraphs(container: Element, selector = 'p'): HTMLParagraphElement[] {
  return Array.from(container.querySelectorAll<HTMLParagraphElement>(selector)).filter(
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
// selector: 문단으로 볼 요소 — 기본 <p>(웹페이지·txt·epub). PDF 는 pdf.js 텍스트 레이어가
// 만드는 span 을 넘긴다(자체 뷰어, articleHighlight.ts 의 paragraphSelector 와 같은 값).
export function extractArticleText(container: Element, selector = 'p'): ArticleExtraction {
  const paragraphs: ArticleParagraph[] = []
  let fullText = ''
  for (const p of visibleParagraphs(container, selector)) {
    const text = visibleParagraphText(p)
    if (!text.trim()) continue
    const start = fullText.length
    fullText += text
    paragraphs.push({ el: p, start, end: fullText.length })
    fullText += '\n'
  }
  return { fullText, paragraphs }
}

// 문단 하나의 단어별 뷰포트 사각형(문단 시작 기준 절대 오프셋 포함) — hover 히트테스트용
// (articleHighlight.ts 가 지연 호출). extractWordsAndText 는 이미 범용(자막 세그먼트
// 전용이 아님)이라 그대로 재사용한다.
export function wordsInParagraph(p: HTMLParagraphElement): SubWord[] {
  return extractWordsAndText(p).words
}
