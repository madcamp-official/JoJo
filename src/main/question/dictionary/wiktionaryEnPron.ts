import { dedupe } from './wiktionary'

// 담당 B — Wiktionary en 발음 추출 (wiktionary.ts 에서 분리, 2026-07-28)
// en.wiktionary.org raw wikitext 의 {{IPA|en|...}} 템플릿에서 발음 값만 뽑는다.
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary" 절 참고.

/** en IPA 발음(들) — `{{IPA|en|/값/|[좁은전사]}}` 의 "en" 다음 첫 위치 인자를 뽑는다(주어진
 *  텍스트 구간 안에서 전부). 실측 확인(2026-07-28, "lead"/"run" 직접 wikitext 조회): 한
 *  Pronunciation 구간 안에 지역별 발음이 `* {{IPA|en|/ɹʌn/|a=GA,RP}}` 처럼 여러 줄로 올 수
 *  있다("run" → GA/RP·North England/Ireland·Scotland/Wales 3개) — 전부 모은다. 두 번째
 *  위치 인자(`[ˈlɛd]` 같은 대괄호, 좁은/음성 전사)는 안 뽑는다 — 첫 슬래시 인자(음소 전사)만
 *  으로 dictionaryapi.dev 가 주던 것과 같은 성격의 값이 나옴. */
export function extractEnIpaValues(content: string): string[] {
  const values = [...content.matchAll(/\{\{IPA\|en\|([^|}]+)/g)].map((m) => m[1].trim()).filter(Boolean)
  return dedupe(values)
}
