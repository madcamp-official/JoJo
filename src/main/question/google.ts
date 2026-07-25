import type { Language } from '@shared/types'
import { LANGUAGES } from '@shared/languages'

// 담당 B — 구글 검색 탭 URL 생성 (PLAN.md §4.2 구글 검색)
// 발음: "선택어 + Pronunciation/読み方/拼音" 웹 탭 / 시각 자료: 이미지 탭.
// 언어별 접미어는 @shared/languages 에서 관리(언어 확장 시 그쪽만 수정).

export function googlePronunciationUrl(text: string, lang: Language): string {
  const q = encodeURIComponent(`${text} ${LANGUAGES[lang].googleSearchSuffix}`)
  return `https://www.google.com/search?q=${q}`
}

export function googleImageUrl(text: string): string {
  const q = encodeURIComponent(text)
  return `https://www.google.com/search?tbm=isch&q=${q}`
}
