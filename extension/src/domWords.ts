// 담당 B — 유튜브/넷플릭스 공용 자막 DOM 좌표 유틸.
// 자막 span 을 단어로 쪼개 각 단어의 뷰포트 사각형을 Range 로 잰다. getBoundingClientRect
// 계열을 매번 새로 읽으므로 전체화면/자막 위치 이동에도 항상 현재 위치가 반영된다.
import type { RectPx, SubWord } from '@shared/extension'
import { HOVER_WORD_ATOM_PATTERN } from '@shared/wordTokenize'
import { unionRects } from '@shared/wordMapping'

// 텍스트 노드의 [start,end) 구간 사각형. 줄바꿈으로 여러 조각이면 union 한다.
export function rangeRect(node: Text, start: number, end: number): RectPx | null {
  const range = document.createRange()
  try {
    range.setStart(node, start)
    range.setEnd(node, end)
  } catch {
    return null
  }
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0)
  return unionRects(rects)
}

// 중국어/일본어는 단어 사이에 공백이 없다 — 공백 기준으로만 쪼개면 자막 한 줄 전체가
// "단어 하나"로 잡혀 hover 박스·클릭 앵커가 줄 단위가 돼버린다(실사용 중 확인). 그래서
// 한자/가나는 여기서 한 글자씩 개별 토큰으로 쪼갠다 — 실제 단어 경계(형태소 분석)는 팝업이
// 열린 뒤 앱의 zh/ja 세그멘터(popup/selection.ts tokenizeAtoms)가 문맥을 보고 다시 묶어주므로,
// 여기서는 클릭 지점의 글자 하나만 정확히 짚으면 된다.
const CJK_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿]/

// 태국어/라오어도 단어 사이 공백이 없지만(위 CJK와 같은 문제), 여긴 반대로 접근한다 —
// 형태소 분석기가 없어(2026-07-30 결정) 글자 단위로 쪼개도 "정확한 단어 경계"를 흉내낼
// 수조차 없으므로, 아예 시도하지 않고 hover 박스를 "화면상 줄" 단위로 보여준다(사용자
// 결정 — "호버박스는 줄 단위, 팝업 연 다음 내부 선택만 글자 단위"). 팝업이 열린 뒤의
// 글자 단위 선택은 popup/selection.ts의 NO_WORD_BOUNDARY_LANGUAGES가 담당 — 여기(hover)와
// 그쪽(팝업 내부)이 "글자 단위"의 의미가 다르다는 점 주의.
//
// 처음엔 "텍스트 노드 전체 = 한 줄"로 단순화했는데, 이 함수(wordsInElement)가 자막
// (한 노드 = 실제로 화면상 한 줄)뿐 아니라 일반 웹페이지 본문 문단(webArticle.ts, 한
// 노드가 여러 줄로 줄바꿈될 수 있음)에도 재사용되면서 문단 전체가 한 덩어리로 뭉치는
// 문제가 있었다(2026-07-30 사용자 지적) — splitTextNodeIntoVisualLines로 실제 화면상
// 줄바꿈 지점을 찾아 진짜 줄 단위로 쪼갠다.
const THAI_LAO_CHAR_RE = /[฀-໿]/

// 텍스트 노드를 실제 화면에 그려지는 줄(visual line) 단위로 쪼갠다 — 글자 하나씩 사각형을
// 재서(rangeRect) 세로 위치(y)가 이전 줄 범위를 벗어나면 줄바꿈으로 본다. 자막처럼 원래
// 한 줄뿐인 노드는 그대로 1개 결과, 웹 기사 문단처럼 여러 줄로 감싸진 노드는 줄 수만큼
// 나온다. RTL/LTR 등 글의 방향과 무관하게 세로(y) 좌표만 보므로 아랍어 등에도 안전하다.
function splitTextNodeIntoVisualLines(node: Text, full: string): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = []
  let lineStart = 0
  let lineTop = 0
  let lineBottom = 0
  let hasLine = false
  for (let i = 0; i < full.length; i++) {
    const r = rangeRect(node, i, i + 1)
    if (!r) continue // 공백 등 폭 0 인 문자 — 줄 판정에서 제외하고 다음 글자로
    if (!hasLine) {
      lineTop = r.y
      lineBottom = r.y + r.height
      hasLine = true
      continue
    }
    // 세로 범위가 지금 줄과 조금이라도 겹치면 같은 줄로 본다(폰트 크기가 섞여도 안전하게
    // 넉넉히 판정) — 안 겹치면 새 줄이 시작된 것.
    const overlaps = r.y < lineBottom && r.y + r.height > lineTop
    if (overlaps) {
      lineTop = Math.min(lineTop, r.y)
      lineBottom = Math.max(lineBottom, r.y + r.height)
      continue
    }
    lines.push({ start: lineStart, end: i })
    lineStart = i
    lineTop = r.y
    lineBottom = r.y + r.height
  }
  if (hasLine) lines.push({ start: lineStart, end: full.length })
  return lines
}

// 팝업의 단어 판정 핵심 규칙(콤마/마침표 등 문장부호 제외)을 공유하되, 하이픈만 의도적
// 으로 다르게 처리한다 — 팝업은 하이픈을 경계로 보고 쪼개지만("well-to-do" → well/to/do),
// hover 박스는 하이픈으로 이어진 구간을 한 단어로 묶어 보여준다(자막 화면에서 세 조각으로
// 쪼개 보이면 부자연스럽다는 요청, 2026-07-29). 클릭하면 여전히 팝업이 열리고 그 안에서는
// 팝업 규칙대로 다시 쪼개진다 — 규칙 차이의 근거는 @shared/wordTokenize 주석 참고.
const WORD_ATOM_RE = new RegExp(HOVER_WORD_ATOM_PATTERN, 'gu')

// baseOffset: 이 텍스트 노드가 (문단/줄 전체 조립 텍스트 기준) 시작하는 절대 오프셋 —
// 반환하는 각 SubWord.start/end 는 로컬(노드 안) 위치가 아니라 이 baseOffset 을 더한
// 절대 오프셋이다(extractWordsAndText 참고, 여러 텍스트 노드를 이어붙인 전체 텍스트 위
// 좌표로 통일해야 groupWordAt/wordAtPoint 가 인덱스 역산 없이 바로 쓸 수 있다).
function wordsFromTextNode(node: Text, baseOffset: number): SubWord[] {
  const full = node.textContent ?? ''
  // 태국어/라오어는 화면상 줄 하나를 "단어" 하나로 취급한다(위 THAI_LAO_CHAR_RE 주석
  // 참고) — 공백/CJK 분기를 아예 안 타고 실제 줄바꿈 지점(splitTextNodeIntoVisualLines)
  // 마다 사각형 하나씩 반환.
  if (THAI_LAO_CHAR_RE.test(full)) {
    const lineWords: SubWord[] = []
    for (const { start, end } of splitTextNodeIntoVisualLines(node, full)) {
      const rect = rangeRect(node, start, end)
      if (rect) lineWords.push({ text: full.slice(start, end), rect, start: baseOffset + start, end: baseOffset + end })
    }
    return lineWords
  }
  const words: SubWord[] = []
  let i = 0
  while (i < full.length) {
    const ch = full[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (CJK_CHAR_RE.test(ch)) {
      const rect = rangeRect(node, i, i + 1)
      if (rect) words.push({ text: ch, rect, start: baseOffset + i, end: baseOffset + i + 1 })
      i += 1
      continue
    }
    // 그 외(라틴/한글/키릴 등)는 공백 또는 CJK 문자를 만날 때까지 우선 묶은 뒤, 그 구간
    // 안에서 WORD_ATOM_RE 로 문장부호를 뺀 실제 단어(들)만 골라낸다 — 하이픈처럼 팝업의
    // LATIN_ATOM_RE 에도 안 걸리는 구두점으로 이어진 구간은 여러 단어로 쪼개질 수 있다
    // (예: "well-known" → well / known, 팝업과 동일).
    let j = i + 1
    while (j < full.length && !/\s/.test(full[j]!) && !CJK_CHAR_RE.test(full[j]!)) j += 1
    const run = full.slice(i, j)
    WORD_ATOM_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WORD_ATOM_RE.exec(run))) {
      const start = i + m.index
      const end = start + m[0].length
      const rect = rangeRect(node, start, end)
      if (rect) words.push({ text: m[0], rect, start: baseOffset + start, end: baseOffset + end })
    }
    i = j
  }
  return words
}

// 후리가나(<rt>, 루비 주석) 안의 텍스트는 한자 읽는 법 표기일 뿐 실제 자막 본문이 아니다
// — <rp>(루비 미지원 브라우저용 괄호 폴백)도 같은 이유로 제외한다. 포함시키면 팝업/문맥
// 텍스트에 읽기가 본문과 섞여 들어간다(예: "七崩賢だったしちほうけん").
function isFuriganaText(node: Text): boolean {
  return node.parentElement?.closest('rt, rp') != null
}

// <script>/<style> 자식 텍스트 노드는 화면에 그려지지 않는 코드/CSS 원문이다 — 일반
// 웹 문단(webArticle.ts)에 영상 임베드용 <script>가 섞여 있는 경우가 실제로 있어(사용자
// 확인, 2026-07-30) extractWordsAndText 에서 걷러낸다.
const NON_TEXT_ELEMENT_RE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/

// display:none/visibility:hidden뿐 아니라, 스크린리더 전용("sr-only") 요소도 숨김으로
// 본다 — video.js 같은 비디오 플레이어가 JS로 주입하는 접근성 안내문("Video Player is
// loading.", "This is a modal window." 등, 클래스 vjs-control-text)이 대표적인 예:
// width:1px/height:1px + overflow:hidden 으로 "기술적으로는 보이는" 상태를 유지한 채
// 시각적으로만 숨긴다(실사용 확인, 2026-07-30 — 인민망 기사 첫 <p>에 영상 플레이어가
// 주입한 이 문구들이 진짜 본문 앞에 끼어들어, 그 문구 안에 섞인 개행 문자가 팝업 문맥
// 맨 위 빈 줄로 나타났다). 1×1px 이하로 접힌 요소는 사실상 화면에 아무 것도 그리지
// 않으므로 display/visibility 판정과 동일하게 취급해도 진짜 콘텐츠를 오탐할 위험이
// 낮다(Readability.js 등 다른 본문 추출기도 쓰는 흔한 휴리스틱).
export function isHidden(el: Element): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return true
  const rect = el.getBoundingClientRect()
  return rect.width <= 1 && rect.height <= 1
}

// root(문단/줄 컨테이너) 안에서 node 까지 올라가며 숨김 조상이 있는지 확인한다 —
// RoyalRoad 실측(2026-07-29)에서 확인된 anti-scraping 함정: 문단 중간에 숨긴 <span>으로
// 가짜 문구를 심어둔다. root 자신의 가시성은 호출부가 이미 확인했다는 전제로 root까지만 올라간다.
function isHiddenWithinRoot(node: Text, root: Element): boolean {
  let el = node.parentElement
  while (el && el !== root.parentElement) {
    if (isHidden(el)) return true
    el = el.parentElement
  }
  return false
}

function shouldSkipTextNode(node: Text, root: Element): boolean {
  return isFuriganaText(node) || node.parentElement?.closest('script, style') != null || isHiddenWithinRoot(node, root)
}

export interface WordsAndText {
  /** root 안의 "진짜 보이는 원문"(후리가나/script·style/숨김 함정 제외, <br>은 '\n') */
  text: string
  /** text 안에서의 절대 오프셋(start/end)을 포함한 단어 목록 */
  words: SubWord[]
}

// root 하나를 한 번만 순회해 원문 텍스트와 단어별 사각형을 함께 만든다 — 예전엔
// wordsInElement/elementTextExcludingFurigana(자막)와 webArticle.ts의 visibleParagraphText
// (문단)가 서로 다른 두 번의 순회로 "같은 텍스트일 것"이라 가정하고 따로 조립됐는데,
// 그 가정이 깨지면(예: 문자 하나의 rect 측정 실패로 단어 하나가 조용히 빠짐) 호출부가
// text.indexOf(word.text, ...) 로 오프셋을 역산하다가 중복 글자가 흔한 CJK 문장에서
// 엉뚱한 위치로 미끄러졌다(2026-07-30 사용자 제보 — 기사 hover 박스가 문단 두 줄을
// 통째로 덮음). 한 번의 순회로 text 와 words[].start/end 를 함께 만들면 그 자체로 항상
// 같은 좌표계를 쓰게 되어 이 어긋남이 애초에 발생할 수 없다.
export function extractWordsAndText(root: HTMLElement): WordsAndText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        return NON_TEXT_ELEMENT_RE.test((n as Element).tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      }
      return shouldSkipTextNode(n as Text, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  let text = ''
  const words: SubWord[] = []
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // <br>은 텍스트 노드가 아니라 SHOW_TEXT 만으로는 안 잡힌다 — 그대로 두면 <br>로
      // 나뉜 두 텍스트가 구분자 없이 그대로 붙어버린다(실측: "Chapter 033Gateways"처럼
      // 붙어 나오는 문제, 2026-07-30 사용자 제보).
      if ((node as Element).tagName === 'BR') text += '\n'
    } else {
      const t = node as Text
      words.push(...wordsFromTextNode(t, text.length))
      text += t.textContent ?? ''
    }
    node = walker.nextNode()
  }
  return { text, words }
}

/** 하위 호환 — 단어 사각형만 필요한 호출부용. 가능하면 extractWordsAndText 를 직접 써서
 *  text 와 words 가 같은 순회에서 나온 값임을 보장하는 편이 낫다. */
export function wordsInElement(el: HTMLElement): SubWord[] {
  return extractWordsAndText(el).words
}

/** 하위 호환 — 원문 텍스트만 필요한 호출부용(anchorInTranscript 등). */
export function elementTextExcludingFurigana(el: HTMLElement): string {
  return extractWordsAndText(el).text
}

// 브라우저 창 좌상단 → 뷰포트 좌상단 오프셋(CSS px)까지 담은 뷰포트 정보.
// 세로는 툴바+탭바(outer-inner), 가로는 좌우 테두리 절반. 전체화면에선 크롬이 없어 0 에 수렴.
export function viewportInfo(): {
  width: number
  height: number
  dpr: number
  chromeLeft: number
  chromeTop: number
} {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    chromeTop: Math.max(0, window.outerHeight - window.innerHeight),
    chromeLeft: Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2)),
  }
}

export function videoCurrentTime(): number {
  const v = document.querySelector<HTMLVideoElement>('video')
  return v ? v.currentTime : 0
}

// 컨테이너의 자막 변화 + 뷰포트 변화(스크롤/리사이즈/전체화면)를 감시해 콜백을 부른다.
export function observeContainer(root: HTMLElement, onChange: () => void): () => void {
  const observer = new MutationObserver(() => onChange())
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const onView = (): void => onChange()
  window.addEventListener('resize', onView, { passive: true })
  window.addEventListener('scroll', onView, { passive: true, capture: true })
  document.addEventListener('fullscreenchange', onView)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', onView)
    window.removeEventListener('scroll', onView, { capture: true } as EventListenerOptions)
    document.removeEventListener('fullscreenchange', onView)
  }
}
