import type { AnyLanguage } from '@shared/types'
import { getGoogleSearchSuffix } from '@shared/languages'

// 담당 B — 구글 검색 탭 URL 생성 (PLAN.md §4.2 구글 검색)
// 발음: "선택어 + pronunciation/読み方/拼音/..." 웹 탭 / 시각 자료: 이미지 탭.
// tier1/tier2 어느 쪽이든(=tier3만 아니면) 항상 된다 — 언어별 접미어는
// @shared/languages 에서 관리(언어 확장 시 그쪽만 수정).
// 새 창 열기 공통 로직은 ./browser 참고(naver.ts 와 공유).

export function googlePronunciationUrl(text: string, lang: AnyLanguage): string {
  const q = encodeURIComponent(`${text} ${getGoogleSearchSuffix(lang)}`)
  return `https://www.google.com/search?q=${q}`
}

export function googleImageUrl(text: string): string {
  const q = encodeURIComponent(text)
  return `https://www.google.com/search?tbm=isch&q=${q}`
}
