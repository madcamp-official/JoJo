// 담당 B — 유튜브 화면 자막 DOM 추출 + 단어별 좌표.
// 유튜브 자막은 .ytp-caption-segment span 으로 렌더된다(극장/전체화면/자막 위치 이동과
// 무관하게 항상 이 구조). span 을 단어로 쪼개 각 단어의 뷰포트 사각형을 Range 로 잰다 —
// getBoundingClientRect 를 매번 새로 읽으므로 자막을 드래그로 옮기거나 전체화면 전환해도
// 항상 현재 위치가 반영된다.
import type { RectPx, SubLine, SubtitleSnapshot, SubWord } from '@shared/extension'

const CAPTION_WINDOW = '.caption-window' // 자막 컨테이너(여러 줄/위치 이동의 최상위)
const CAPTION_SEGMENT = '.ytp-caption-segment'

export function isYoutubeWatch(): boolean {
  const p = location.pathname
  return (
    location.hostname.endsWith('youtube.com') &&
    (p === '/watch' || p.startsWith('/shorts/') || p.startsWith('/live/') || p.startsWith('/embed/'))
  )
}

// 자막 갱신을 감시할 컨테이너. 플레이어 전체를 관찰해 자막 창이 생겼다 사라지는 것까지 잡는다.
export function captionRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('#movie_player') ||
    document.querySelector<HTMLElement>('.html5-video-player')
  )
}

function videoCurrentTime(): number {
  const v = document.querySelector<HTMLVideoElement>('video.html5-main-video, video')
  return v ? v.currentTime : 0
}

// 한 세그먼트(span) 텍스트를 단어 단위로 쪼개고, 각 단어의 뷰포트 사각형을 Range 로 잰다.
// 공백/문장부호로 나누되, 표시 텍스트와 오프셋이 어긋나지 않도록 정규식 매칭으로 자른다.
function wordsFromSegment(seg: HTMLElement): SubWord[] {
  const textNode = firstTextNode(seg)
  if (!textNode) return []
  const full = textNode.textContent ?? ''
  const words: SubWord[] = []
  // 연속된 비공백 덩어리 = 단어(CJK 는 여기선 통째로 한 덩어리 → 후속 형태소 분해는 앱이 담당).
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(full))) {
    const start = m.index
    const end = start + m[0].length
    const rect = rangeRect(textNode, start, end)
    if (rect) words.push({ text: m[0], rect })
  }
  return words
}

function firstTextNode(el: Node): Text | null {
  if (el.nodeType === Node.TEXT_NODE) return el as Text
  for (const child of Array.from(el.childNodes)) {
    const found = firstTextNode(child)
    if (found) return found
  }
  return null
}

// 텍스트 노드의 [start,end) 구간 사각형. 줄바꿈으로 여러 조각이면 union 한다.
function rangeRect(node: Text, start: number, end: number): RectPx | null {
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

// 지금 화면에 떠 있는 자막 프레임을 추출한다. 자막이 없으면 null.
export function extractSubtitleSnapshot(): SubtitleSnapshot | null {
  const windows = document.querySelectorAll<HTMLElement>(CAPTION_WINDOW)
  const lines: SubLine[] = []
  const containers = windows.length > 0 ? Array.from(windows) : [document.body]
  for (const win of containers) {
    const segs = win.querySelectorAll<HTMLElement>(CAPTION_SEGMENT)
    // 한 자막 창 안에서 각 세그먼트는 보통 한 줄(또는 줄 조각)이다. 세그먼트별로 한 줄로 본다.
    for (const seg of Array.from(segs)) {
      const words = wordsFromSegment(seg)
      if (words.length === 0) continue
      lines.push({ text: words.map((w) => w.text).join(' '), words })
    }
  }
  if (lines.length === 0) return null
  return {
    lines,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    currentTime: videoCurrentTime(),
  }
}

// 자막 컨테이너 변화를 감시해 콜백을 호출한다. 반환값으로 정리 함수를 준다.
export function observeSubtitles(onChange: () => void): () => void {
  const root = captionRoot() ?? document.body
  const observer = new MutationObserver(() => onChange())
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  // 스크롤/리사이즈/전체화면 전환 시 좌표가 달라지므로 함께 갱신한다.
  const onView = () => onChange()
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
