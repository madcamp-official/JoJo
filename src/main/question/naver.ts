import type { Language } from '@shared/types'
import { LANGUAGES } from '@shared/languages'

// 담당 B — 네이버 사전 URL 생성. 언어별 서브도메인은 @shared/languages 참고.
// 새 창 열기 공통 로직은 ./browser (google.ts 와 공유).

export function naverDictionaryUrl(text: string, lang: Language): string {
  const q = encodeURIComponent(text)
  const sub = LANGUAGES[lang].naverDictSubdomain
  return `https://${sub}.dict.naver.com/#/search?query=${q}`
}
