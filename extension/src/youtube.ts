// 담당 B — 유튜브 화면 자막 DOM 추출 + 단어별 좌표.
// 유튜브 자막은 .ytp-caption-segment span 으로 렌더된다(극장/전체화면/자막 위치 이동과
// 무관하게 항상 이 구조). 공용 유틸(domWords.ts)로 단어별 뷰포트 사각형을 잰다.
import type { SubLine, SubtitleSnapshot } from '@shared/extension'
import { extractWordsAndText, observeContainer, videoCurrentTime, viewportInfo } from '@shared/hover/domWords'

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
function captionRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('#movie_player') ||
    document.querySelector<HTMLElement>('.html5-video-player')
  )
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
      // words 를 공백으로 join 하면 CJK 처럼 원문에 공백이 없던 구간에 가짜 공백이 끼어들어
      // (domWords.ts 가 한자/가나를 글자 단위로 쪼개므로) 실제 자막 원문과 달라진다 —
      // anchorInTranscript(subtitleSource.ts)가 이 lineText 를 timedtext cue 원문 안에서
      // 그대로 찾아야 하므로, 세그먼트의 원문(후리가나 제외) 그대로를 line.text 로 쓴다.
      // text/words 를 한 번의 순회(extractWordsAndText)로 함께 뽑아야 words[].start/end 가
      // 항상 이 text 기준 오프셋과 일치한다(2026-07-30, 따로 두 번 순회하던 방식의 위험성은
      // domWords.ts extractWordsAndText 주석 참고).
      const { text: raw, words } = extractWordsAndText(seg)
      if (words.length === 0) continue
      lines.push({ text: raw, words })
    }
  }
  if (lines.length === 0) return null
  return { lines, viewport: viewportInfo(), currentTime: videoCurrentTime() }
}

// 자막 컨테이너 변화를 감시해 콜백을 호출한다. 반환값으로 정리 함수를 준다.
export function observeSubtitles(onChange: () => void): () => void {
  return observeContainer(captionRoot() ?? document.body, onChange)
}
