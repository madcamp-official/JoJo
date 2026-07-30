// 담당 B — 넷플릭스 화면 자막 DOM 추출 + 단어별 좌표.
// 넷플릭스 자막은 .player-timedtext-text-container 안 span 으로 렌더된다. 전체 자막(앞뒤
// 문맥)은 이 파일이 아니라 netflixNetworkHook.ts(매니페스트 가로채기 + WebVTT 다운로드)로
// 확보한다 — youtube.ts 와 동일하게 화면 DOM은 "지금 이 순간" 좌표만 담당한다.
import type { SubLine, SubtitleSnapshot } from '@shared/extension'
import { extractWordsAndText, observeContainer, videoCurrentTime, viewportInfo } from './domWords'

const TEXT_CONTAINER = '.player-timedtext-text-container'

export function isNetflixWatch(): boolean {
  return location.hostname.endsWith('netflix.com') && location.pathname.startsWith('/watch/')
}

// URL의 /watch/<movieId> 에서 뽑는다 — netflixNetworkHook.ts 가 매니페스트에서 얻는
// movieId 와 같은 값이어야, 클릭 시점에 지금 보고 있는 영상의 자막인지 검증할 수 있다
// (content.ts onWordClicked, subtitleSource.ts buildSelection).
export function currentNetflixMovieId(): string | null {
  const m = location.pathname.match(/^\/watch\/(\d+)/)
  return m ? m[1]! : null
}

function captionRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.watch-video') ||
    document.querySelector<HTMLElement>('.player-timedtext') ||
    document.querySelector<HTMLElement>('[data-uia="player"]')
  )
}

// 화면에 뜬 자막 프레임을 추출한다. 없으면 null.
export function extractNetflixSnapshot(): SubtitleSnapshot | null {
  const containers = document.querySelectorAll<HTMLElement>(TEXT_CONTAINER)
  const lines: SubLine[] = []
  for (const c of Array.from(containers)) {
    // words 를 공백으로 join 하면 CJK 구간에 가짜 공백이 끼어든다(domWords.ts 참고) —
    // 컨테이너 원문(후리가나 제외) 그대로를 line.text 로 쓴다(youtube.ts 와 동일한 이유).
    // text/words 는 한 번의 순회(extractWordsAndText)로 함께 뽑아 오프셋 일치를 보장한다.
    const { text: raw, words } = extractWordsAndText(c)
    if (words.length === 0) continue
    lines.push({ text: raw, words })
  }
  if (lines.length === 0) return null
  return { lines, viewport: viewportInfo(), currentTime: videoCurrentTime() }
}

export function observeNetflixSubtitles(onChange: () => void): () => void {
  return observeContainer(captionRoot() ?? document.body, onChange)
}
