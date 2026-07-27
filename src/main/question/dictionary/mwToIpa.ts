// 담당 B — MW 자체 발음 표기(prs.mw, IPA 아님)를 표시용 IPA 근사치로 변환.
// DICTIONARY_SOURCES.md 실측(2026-07-28, day/cot/boy/now/go/law/food/good/the/thin/
// vision/whale/cute 등 다수 단어를 MW API로 직접 호출해 정확한 코드포인트 확인)을
// 근거로 만든 정적 매핑 — MW 표기가 "기호 하나 = 음소 하나"로 설계돼 있어 대부분은
// 이 정도 룩업 테이블로 충분히 커버된다.
//
// 알려진 한계(원본 자체의 모호함이라 변환으로 못 없앰): MW 는 강세 음절의 STRUT
// 모음(cup, judge)과 비강세 schwa(about, mother)를 똑같이 `ə` 로 적는다(실측:
// "cup"→"kəp", "judge"→"jəj") — 실제 IPA 라면 전자는 /ʌ/ 로 구분해 쓰지만, MW
// 표기만으론 이 둘을 구별할 정보 자체가 없어 여기서도 항상 `ə` 로 남는다.

/** 여러 코드포인트가 하나의 IPA 음소로 합쳐지는 경우만 순서대로 나열(최장 일치 우선).
 *  나머지(예: ȯi→ɔɪ, yü→ju)는 아래 SINGLE 매핑을 문자 단위로 이어붙이면 자연히
 *  올바른 결과가 나와 별도 규칙이 필요 없다(실측 확인). */
const MULTI: [string, string][] = [
  ['a' + 'u' + '̇', 'aʊ'], // au̇ (now) — 이 조합의 'a'는 홀로 쓰일 때(æ)와 뜻이 달라 예외 처리 필요
  ['t' + '͟' + 'h', 'ð'], // t͟h (the) — 유성 th, 밑줄 결합기호로 무성 th(θ)와 구분됨
  ['u' + '̇', 'ʊ'], // u̇ (good)
  ['ch', 'tʃ'],
  ['sh', 'ʃ'],
  ['zh', 'ʒ'],
  ['th', 'θ'], // 무성 th(thin) — 위 t͟h(유성)보다 뒤에 와야 함(더 짧은 패턴이라 순서상 문제없음, 결합기호 유무로 이미 구분됨)
]

const SINGLE: Record<string, string> = {
  ā: 'eɪ',
  ä: 'ɑ',
  ē: 'i',
  ī: 'aɪ',
  ō: 'oʊ',
  ȯ: 'ɔ',
  ü: 'u',
  a: 'æ',
  e: 'ɛ',
  i: 'ɪ',
  j: 'dʒ', // MW 의 j 는 IPA y 소리가 아니라 dʒ(job)
  y: 'j', // MW 의 y 가 IPA j(yes)
  '-': '', // 음절 구분용 하이픈 — IPA 간이 표기에선 생략
}

/** MW `prs.mw` 표기 하나를 IPA 근사치 문자열로 변환한다. 최장 일치 우선으로 스캔하고,
 *  매핑에 없는 문자(자음 대부분, 강세 기호 ˈ/ˌ, 괄호, 공백 등)는 그대로 통과시킨다 —
 *  MW 와 IPA 가 이미 같은 문자를 쓰는 경우가 많아서다(b/d/f/g/h/k/l/m/n/p/r/s/t/v/w/z,
 *  강세 기호, ə, ŋ 등). */
export function mwToIpa(mw: string): string {
  let out = ''
  let i = 0
  outer: while (i < mw.length) {
    for (const [pattern, ipa] of MULTI) {
      if (mw.startsWith(pattern, i)) {
        out += ipa
        i += pattern.length
        continue outer
      }
    }
    const ch = mw[i]
    out += ch in SINGLE ? SINGLE[ch] : ch
    i += 1
  }
  return out
}
