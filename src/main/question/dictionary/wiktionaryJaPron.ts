import { dedupe } from './wiktionary'

// 담당 B — Wiktionary ja 발음 추출 (wiktionary.ts 에서 분리, 2026-07-28)
// en.wiktionary.org raw wikitext 의 {{ja-pron|...}} 템플릿에서 히라가나 읽기만 뽑는다.
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary" 절 참고.

/** ja 읽기(들) — {{ja-pron|よみ|...}} 의 첫 위치 인자를 뽑는다(주어진 텍스트 구간 안에서
 *  전부). 실측 확인(2026-07-28, 走る/美しい/東京/猫/犬/食べる 6개 표제어 직접 wikitext
 *  조회): 이 템플릿이 항상 히라가나 읽기를 첫 인자로 그대로 담고 있어(예: "走る"→"はしる",
 *  "美しい"→"うつくしい") 뒤따르는 `acc=`/`acc_ref=`/`a=`(오디오 파일명) 등 named 파라미터와
 *  파이프(|)로 안전하게 구분됨. `assignPerBlockPronunciations`가 페이지 전체가 아니라
 *  Pronunciation 헤더 하나의 콘텐츠 구간만 넘기므로, 한 표제어에 읽기가 여러 개라도
 *  (실측: "猫"→ねこ/ねこま 2개, "東京"→とうきょう/とうけい/トンキン 3개) 이 함수 자체는
 *  그 구간에 있는 것만 본다 — Etymology별로 다른 POS 블록에 정확히 대응된다(wiktionary.ts
 *  assignPerBlockPronunciations 주석 참고). 템플릿 자체가 없으면 빈 배열. */
export function extractJaPronValues(content: string): string[] {
  const values = [...content.matchAll(/\{\{ja-pron\|([^|}]+)/g)].map((m) => m[1].trim()).filter(Boolean)
  return dedupe(values)
}
