import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, Language } from '@shared/types'

// 담당 B — Wiktionary 어댑터 (PLAN.md §5, en/ja/zh 공용 최종 폴백)
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary (공용 — en/ja/zh 최종 폴백)" 절 참고.
// en.wiktionary.org 공식 REST API(GET /api/rest_v1/page/definition/{word}, 무료·키 불필요)를
// 뜻풀이 소스로 쓴다 — ja.wiktionary.org/zh.wiktionary.org 같은 네이티브판은 커버리지가 더
// 약해 미채택. 이 API 엔 발음(phonetic) 필드가 없어(실측), en 한정으로 dictionaryapi.dev
// (서드파티, en.wiktionary.org 데이터 재가공, 실제 IPA 제공)를 발음 전용으로 추가 호출해
// 보강한다 — ja/zh는 이 서드파티도 커버리지가 없어 발음 없는 채로 남는다.
// raw wikitext(활용표/방언 발음 등)는 이 폴백 소스의 스코프 밖 — 두 API가 주는 만큼만 다룬다.

const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition'
/** en 전용 발음 보강 소스 — en.wiktionary.org REST API(definition 엔드포인트)엔 phonetic
 *  필드 자체가 없어(DICTIONARY_SOURCES.md 실측) 별도로 붙인다. 서드파티(en.wiktionary.org
 *  데이터를 재가공)라 무료·키 불필요. ja/zh는 이 API 자체가 커버리지가 없어(en 전용,
 *  DICTIONARY_SOURCES.md 실측) 보강 대상에서 제외. */
const DICTIONARYAPI_DEV_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en'

export class WiktionaryHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WiktionaryHttpError'
  }
}

// ---- Wiktionary REST API 원본 응답 타입 (실측 기반, 2026-07-28) ----------------------

interface WiktionaryParsedExample {
  example: string
}

interface WiktionaryDefinition {
  /** 위키링크 HTML이 그대로 섞인 문자열 — 빈 문자열로 오는 경우도 실측 확인(예: "dog"
   *  Verb 블록의 첫 definition). gloss 는 필수 필드라 비어있으면 이 sense 는 버린다. */
  definition: string
  examples?: string[]
  parsedExamples?: WiktionaryParsedExample[]
}

interface WiktionaryPosBlock {
  partOfSpeech: string
  /** 언어 전체 이름(원문 그대로, 예: "English"/"Japanese"/"Chinese"/"Translingual") —
   *  실측 확인(2026-07-28, "ate"): 최상위 언어 코드 키("en" 등) 밑에도 그 키와 무관한
   *  언어 블록(Translingual 등)이 섞여 온다. 키만으로 거르면 안 되고 이 필드로 한 번 더
   *  걸러야 한다. */
  language: string
  definitions: WiktionaryDefinition[]
}

type WiktionaryRaw = Record<string, WiktionaryPosBlock[]>

/** 최상위 언어 코드 키 — 실측 확인(2026-07-28): en/ja/zh 전부 REST API 응답이 이 키로
 *  옴(zh-Hans/zh-Hant 구분 없이 "zh" 하나 — Wiktionary REST API 자체가 스크립트를
 *  구분하지 않음, DICTIONARY_SOURCES.md 참고). */
const WIKTIONARY_LANG_KEY: Record<Language, string> = {
  en: 'en',
  ja: 'ja',
  'zh-Hans': 'zh',
  'zh-Hant': 'zh',
}

/** WiktionaryPosBlock.language 필터용 — 이 값과 정확히 일치하는 블록만 채택한다. */
const WIKTIONARY_LANG_NAME: Record<Language, string> = {
  en: 'English',
  ja: 'Japanese',
  'zh-Hans': 'Chinese',
  'zh-Hant': 'Chinese',
}

// ---- partOfSpeech → CanonicalPos --------------------------------------------

/** 언어 공통으로 겹치는 품사만 — CanonicalPosCommon 값. 언어 전용 값(article/particle 등)은
 *  아래에서 language 로 분기해 추가한다. */
const POS_COMMON: Record<string, CanonicalPos> = {
  noun: 'noun',
  'proper noun': 'noun',
  verb: 'verb',
  adjective: 'adjective',
  adverb: 'adverb',
  pronoun: 'pronoun',
  conjunction: 'conjunction',
  interjection: 'interjection',
}

/** Wiktionary partOfSpeech 원문(대문자 시작)을 CanonicalPos<L> 로 매핑한다. 이 소스는
 *  isIdiom 표시가 없다(DICTIONARY_SOURCES.md 실측 확인 — "kick the bucket"도 그냥
 *  partOfSpeech: "verb") — 관용구 여부는 이 어댑터에서 항상 undefined. */
function mapPos<L extends Language>(partOfSpeech: string, language: L): CanonicalPos<L> | undefined {
  const key = partOfSpeech.toLowerCase()
  const common = POS_COMMON[key]
  if (common) return common as CanonicalPos<L>
  if (language === 'en' && key === 'preposition') return 'preposition' as CanonicalPos<L>
  if (language === 'en' && key === 'article') return 'article' as CanonicalPos<L>
  if (language === 'ja' && key === 'particle') return 'particle' as CanonicalPos<L>
  if ((language === 'zh-Hans' || language === 'zh-Hant') && key === 'preposition') return 'preposition' as CanonicalPos<L>
  if ((language === 'zh-Hans' || language === 'zh-Hant') && key === 'particle') return 'particle' as CanonicalPos<L>
  if ((language === 'zh-Hans' || language === 'zh-Hant') && key === 'classifier') return 'classifier' as CanonicalPos<L>
  return undefined
}

// ---- HTML 정리 ---------------------------------------------------------------

/** definition/example 문자열 안의 위키링크 HTML(<a>/<span>/<i>/<b>/<link> 등)을 제거하고
 *  자주 나오는 HTML 엔티티만 디코드한다. MW 어댑터(stripMerriamWebsterTokens)와 동일한
 *  "알려진 것만 처리, 나머지는 통째로 제거" 방침. */
function stripWiktionaryHtml(raw: string): string {
  let s = raw
  s = s.replace(/<[^>]*>/g, '')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

function extractExamples(def: WiktionaryDefinition): string[] {
  const source = def.parsedExamples?.map((e) => e.example) ?? def.examples ?? []
  return source.map(stripWiktionaryHtml).filter(Boolean)
}

// ---- dictionaryapi.dev 발음 보강(en 전용) -------------------------------------

interface DictionaryApiDevPhonetic {
  text?: string
}

interface DictionaryApiDevEntry {
  phonetic?: string
  phonetics?: DictionaryApiDevPhonetic[]
}

/** dictionaryapi.dev 로 실제 IPA 발음 하나를 가져온다 — 실측 확인(2026-07-28, "run"):
 *  발음이 meaning(품사)별이 아니라 entry 최상위에만 있어(phonetics[] 가 품사와 무관하게
 *  하나로 옴) 품사별로 구분해 붙일 수가 없다. 그래서 이 값을 그 word 의 모든 reading에
 *  동일하게 채운다 — MW가 hom 간 발음을 상속하는 것과 비슷한 단순화. 실패(네트워크
 *  오류·404 등)해도 조용히 undefined 반환 — 발음은 부가 정보라 이것 때문에 전체 조회를
 *  실패시키지 않는다. */
async function fetchEnPronunciation(word: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${DICTIONARYAPI_DEV_ENDPOINT}/${encodeURIComponent(word)}`, {
      headers: { 'User-Agent': 'JoJo-dictionary-adapter/1.0' },
    })
    if (!res.ok) return undefined
    const raw = (await res.json()) as DictionaryApiDevEntry[]
    for (const entry of raw) {
      if (entry.phonetic) return entry.phonetic
      const fromPhonetics = entry.phonetics?.find((p) => p.text)?.text
      if (fromPhonetics) return fromPhonetics
    }
  } catch {
    /* 폴백 실패는 무시 — 나머지 사전 정보는 이미 확보돼 있음 */
  }
  return undefined
}

// ---- WiktionaryPosBlock[] → DictionaryEntry ----------------------------------

/** REST API 는 발음/homograph 그룹을 안 주므로(DICTIONARY_SOURCES.md 실측: phonetic 필드
 *  자체가 없음), pos 블록 하나당 reading 하나로 대응한다 — pronunciations 는 여기선 항상
 *  undefined 로 두고(en 은 fetchWiktionaryEntry 가 dictionaryapi.dev 로 보강). */
function blockToReading<L extends Language>(block: WiktionaryPosBlock, language: L): DictionaryReading<L> | null {
  const pos = mapPos(block.partOfSpeech, language)
  const senses: DictionarySense<L>[] = block.definitions
    .map((def): DictionarySense<L> | null => {
      const gloss = stripWiktionaryHtml(def.definition)
      if (!gloss) return null // gloss 는 필수 필드 — 못 뽑으면 이 sense 는 버린다(실측: 빈 definition 존재)
      const examples = extractExamples(def)
      return {
        pos,
        posRaw: block.partOfSpeech,
        gloss: [gloss],
        examples: examples.length ? examples : undefined,
      } as DictionarySense<L>
    })
    .filter((s): s is DictionarySense<L> => s !== null)

  if (!senses.length) return null
  return { senses }
}

export interface WiktionaryLookupResult<L extends Language = Language> {
  entry?: DictionaryEntry<L>
}

/** word 를 en.wiktionary.org REST API 로 조회한다. 언어별 최상위 키(en/ja/zh)로 먼저
 *  거르고, 그 안에서도 language 필드가 정확히 일치하는 블록만 채택한다(실측: 같은 "en"
 *  키 아래 Translingual 블록이 섞여 옴). 표제어를 못 찾으면(HTTP 404) entry 없이 빈
 *  객체를 반환 — MW 어댑터의 suggestions 같은 부가 정보가 이 API 엔 없다. */
export async function fetchWiktionaryEntry<L extends Language>(
  word: string,
  language: L,
): Promise<WiktionaryLookupResult<L>> {
  const url = `${WIKTIONARY_ENDPOINT}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'JoJo-dictionary-adapter/1.0' } })
  if (res.status === 404) return {}
  if (!res.ok) {
    throw new WiktionaryHttpError(res.status, `Wiktionary API 요청 실패: HTTP ${res.status}`)
  }

  let raw: WiktionaryRaw
  try {
    raw = await res.json()
  } catch {
    throw new WiktionaryHttpError(res.status, 'Wiktionary 응답을 파싱할 수 없습니다.')
  }

  const langKey = WIKTIONARY_LANG_KEY[language]
  const langName = WIKTIONARY_LANG_NAME[language]
  const blocks = (raw[langKey] ?? []).filter((b) => b.language === langName)
  if (!blocks.length) return {}

  const readings = blocks
    .map((b) => blockToReading(b, language))
    .filter((r): r is DictionaryReading<L> => r !== null)
  if (!readings.length) return {}

  if (language === 'en') {
    const pronunciation = await fetchEnPronunciation(word)
    if (pronunciation) {
      for (const reading of readings) reading.pronunciations = [{ value: pronunciation }]
    }
  }

  const entry = {
    language,
    headword: [word],
    readings,
    source: 'wiktionary',
  } as DictionaryEntry<L>

  return { entry }
}
