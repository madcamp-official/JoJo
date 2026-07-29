// 담당 B — 유튜브/넷플릭스 공용 자막 DOM 좌표 유틸.
// 자막 span 을 단어로 쪼개 각 단어의 뷰포트 사각형을 Range 로 잰다. getBoundingClientRect
// 계열을 매번 새로 읽으므로 전체화면/자막 위치 이동에도 항상 현재 위치가 반영된다.
import type { RectPx, SubWord } from '@shared/extension'

// 텍스트 노드의 [start,end) 구간 사각형. 줄바꿈으로 여러 조각이면 union 한다.
export function rangeRect(node: Text, start: number, end: number): RectPx | null {
  const range = document.createRange()
  try {
    range.setStart(node, start)
    range.setEnd(node, end)
  } catch {
    return null
  }
  const rects = range.getClientRects()
  if (rects.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of Array.from(rects)) {
    if (r.width === 0 && r.height === 0) continue
    x0 = Math.min(x0, r.left)
    y0 = Math.min(y0, r.top)
    x1 = Math.max(x1, r.right)
    y1 = Math.max(y1, r.bottom)
  }
  if (!isFinite(x0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// 중국어/일본어는 단어 사이에 공백이 없다 — 공백 기준으로만 쪼개면 자막 한 줄 전체가
// "단어 하나"로 잡혀 hover 박스·클릭 앵커가 줄 단위가 돼버린다(실사용 중 확인). 그래서
// 한자/가나는 여기서 한 글자씩 개별 토큰으로 쪼갠다 — 실제 단어 경계(형태소 분석)는 팝업이
// 열린 뒤 앱의 zh/ja 세그멘터(popup/selection.ts tokenizeAtoms)가 문맥을 보고 다시 묶어주므로,
// 여기서는 클릭 지점의 글자 하나만 정확히 짚으면 된다.
const CJK_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿]/

function wordsFromTextNode(node: Text): SubWord[] {
  const full = node.textContent ?? ''
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
      if (rect) words.push({ text: ch, rect })
      i += 1
      continue
    }
    // 그 외(라틴 등)는 공백 또는 CJK 문자를 만날 때까지를 한 단어로 묶는다.
    let j = i + 1
    while (j < full.length && !/\s/.test(full[j]!) && !CJK_CHAR_RE.test(full[j]!)) j += 1
    const rect = rangeRect(node, i, j)
    if (rect) words.push({ text: full.slice(i, j), rect })
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

// 한 요소 안의 모든 텍스트 노드를 순회하며 단어(공백 경계, CJK 는 글자 단위)마다 사각형을 잰다.
export function wordsInElement(el: HTMLElement): SubWord[] {
  const words: SubWord[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isFuriganaText(node as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let node = walker.nextNode() as Text | null
  while (node) {
    words.push(...wordsFromTextNode(node))
    node = walker.nextNode() as Text | null
  }
  return words
}

// el 의 원문 텍스트를 후리가나(<rt>/<rp>) 제외하고 그대로 이어붙인다 — line.text(youtube.ts/
// netflix.ts)를 el.textContent 로 그대로 쓰면 wordsInElement 로 걸러낸 후리가나가 여기엔
// 여전히 섞여 들어간다(예: "七崩賢だったしちほうけん"). anchorInTranscript(subtitleSource.ts)
// 가 이 텍스트를 실제 timedtext/WebVTT cue 원문 안에서 찾아야 하므로, wordsInElement 와
// 똑같이 후리가나만 뺀 "진짜 원문"이어야 한다(공백을 임의로 끼워넣지 않음).
export function elementTextExcludingFurigana(el: HTMLElement): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isFuriganaText(node as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let text = ''
  let node = walker.nextNode() as Text | null
  while (node) {
    text += node.textContent ?? ''
    node = walker.nextNode() as Text | null
  }
  return text
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
