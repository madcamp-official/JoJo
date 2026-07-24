import type { Language } from '@shared/types'

// 담당 B — 구글 검색 탭 URL 생성 (PLAN.md §4.2 구글 검색)
// 발음: "선택어 + Pronunciation/読み方/拼音" 웹 탭 / 시각 자료: 이미지 탭.

const PRON_SUFFIX: Record<Language, string> = {
  en: 'Pronunciation',
  ja: '読み方',
  zh: '拼音',
}

export function googlePronunciationUrl(text: string, lang: Language): string {
  const q = encodeURIComponent(`${text} ${PRON_SUFFIX[lang]}`)
  return `https://www.google.com/search?q=${q}`
}

export function googleImageUrl(text: string): string {
  const q = encodeURIComponent(text)
  return `https://www.google.com/search?tbm=isch&q=${q}`
}
