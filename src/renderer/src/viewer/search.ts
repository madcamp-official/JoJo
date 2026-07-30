// 뷰어 텍스트 검색 — 포맷마다 "어디서 텍스트를 모으는가"가 다르다:
//  - txt : 화면에 그려진 문단(<p>)들
//  - pdf : 이미 렌더된 각 페이지의 텍스트 레이어(.pdf-line)
//  - epub: 현재 챕터만 DOM 에 있으므로 spine 을 돌며 각 챕터를 따로 읽는다
// 그래서 "찾기"는 포맷별 구현이 담당하고, 결과의 모양과 이동 방법만 이 파일에서 맞춘다
// (목차 TocEntry 와 같은 구조 — 화면은 go() 를 부르기만 한다).

export interface SearchHit {
  /** 왼쪽 목록에 굵게 나오는 위치 이름 — "24쪽", "3장" 등 */
  location: string
  /** 검색어 앞뒤를 잘라낸 문맥 */
  snippet: string
  /** 검색어가 snippet 안에서 시작하는 위치와 길이(굵게 칠하는 데 쓴다) */
  hitStart: number
  hitLength: number
  /** 이 결과로 이동 */
  go: () => void
}

const SNIPPET_BEFORE = 34
const SNIPPET_AFTER = 46

/** 매치 주변만 잘라 한 줄짜리 문맥을 만든다(줄바꿈은 공백으로 눕힌다). */
export function makeSnippet(text: string, at: number, length: number): Omit<SearchHit, 'location' | 'go'> {
  const flat = text.replace(/\s+/g, ' ')
  // 공백을 접으면 위치가 밀리므로, 접기 전 기준으로 자른 뒤 다시 접는다.
  const rawStart = Math.max(0, at - SNIPPET_BEFORE)
  const head = text.slice(rawStart, at).replace(/\s+/g, ' ')
  const hit = text.slice(at, at + length).replace(/\s+/g, ' ')
  const tail = text.slice(at + length, at + length + SNIPPET_AFTER).replace(/\s+/g, ' ')
  const prefix = rawStart > 0 ? '…' : ''
  const suffix = at + length + SNIPPET_AFTER < text.length ? '…' : ''
  void flat
  return {
    snippet: prefix + head + hit + tail + suffix,
    hitStart: prefix.length + head.length,
    hitLength: hit.length,
  }
}

/** 대소문자 구분 없이 모든 매치 위치를 찾는다. */
export function findAll(haystack: string, needle: string): number[] {
  if (!needle) return []
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  const out: number[] = []
  let i = h.indexOf(n)
  while (i !== -1) {
    out.push(i)
    i = h.indexOf(n, i + n.length)
  }
  return out
}

/**
 * 찾은 자리로 데려간 뒤 잠깐 강조한다. 매치 글자에 태그를 씌우면 본문 DOM 이 바뀌어
 * 호버 좌표 계산(offset 기준)이 흔들리므로, **그 문단/줄 요소에 클래스만 잠깐 얹는다**.
 */
export function revealElement(el: Element | null | undefined): void {
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  el.classList.add('search-flash')
  window.setTimeout(() => el.classList.remove('search-flash'), 1600)
}
