import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, Language } from '@shared/types'

// 담당 B — Wiktionary 어댑터 (PLAN.md §5, en/ja/zh 공용 최종 폴백)
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary (공용 — en/ja/zh 최종 폴백)" 절 참고.
// en.wiktionary.org 공식 REST API(GET /api/rest_v1/page/definition/{word}, 무료·키 불필요)를
// 뜻풀이 소스로 쓴다 — ja.wiktionary.org/zh.wiktionary.org 같은 네이티브판은 커버리지가 더
// 약해 미채택. 이 API 엔 발음(phonetic) 필드가 없어(실측), en 한정으로 dictionaryapi.dev
// (서드파티, en.wiktionary.org 데이터 재가공, 실제 IPA 제공)를 발음 전용으로 추가 호출해
// 보강한다. ja/zh는 이 서드파티 커버리지가 없는 대신, en.wiktionary.org 의 raw wikitext
// (action=parse)에서 발음 템플릿 파라미터만 정규식으로 뽑아 보강한다(활용표·방언 발음
// 전체를 파싱하는 건 여전히 스코프 밖 — 발음 값 하나만 필요한 만큼만 다룬다). ja는
// {{ja-pron|よみ|...}} 의 첫 위치 인자(히라가나 읽기), zh는 {{zh-pron|m=병음|...}} 의
// m= 파라미터(표준중국어/Mandarin 병음)만 뽑는다 — 실측 근거는 각 fetch*Pronunciation
// 함수 주석 참고.

const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition'
const WIKTIONARY_ACTION_API = 'https://en.wiktionary.org/w/api.php'
/** Wikimedia User-Agent 정책(https://meta.wikimedia.org/wiki/User-Agent_policy) 준수용 —
 *  "ClientName/Version (연락처)" 형식으로 연락 가능한 수단을 명시해야 한다(이메일 필수는
 *  아님 — 이슈를 남길 수 있는 저장소 URL도 인정되는 형태). 연락처 없는 UA는 정책 위반으로
 *  더 강하게 레이트리밋/차단될 수 있음(실측: 개발 중 여러 번 HTTP 429 수신). Wikimedia
 *  소유가 아닌 dictionaryapi.dev 호출에도 동일하게 재사용 — 일부 API가 UA 없는/일반적인
 *  요청을 더 박하게 다루는 경우가 있어 좋은 관행으로 통일. */
const WIKTIONARY_USER_AGENT = 'JoJo-dictionary-adapter/1.0 (https://github.com/madcamp-official/JoJo)'
/** en 전용 발음 보강 소스 — en.wiktionary.org REST API(definition 엔드포인트)엔 phonetic
 *  필드 자체가 없어(DICTIONARY_SOURCES.md 실측) 별도로 붙인다. 서드파티(en.wiktionary.org
 *  데이터를 재가공)라 무료·키 불필요. ja/zh는 이 API 자체가 커버리지가 없어(en 전용,
 *  DICTIONARY_SOURCES.md 실측) 보강 대상에서 제외 — 대신 아래 raw wikitext 경로를 쓴다. */
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

/** 순서를 유지하며 중복만 제거 — 세 fetch*Pronunciations 함수가 공유. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/** dictionaryapi.dev 로 실제 IPA 발음(들)을 가져온다 — 실측 확인(2026-07-28, "run"):
 *  발음이 meaning(품사)별이 아니라 entry 최상위에만 있어(phonetics[] 가 품사와 무관하게
 *  공유됨) 품사별로 구분해 붙일 수가 없다. 그래서 여기서 모은 값 전부를 그 word 의 모든
 *  reading에 동일하게 채운다(DictionaryReading.pronunciations 가 배열이라 실제로 발음이
 *  여러 개인 경우, 예: 지역별 이표기, 전부 담을 수 있음 — 첫 번째만 쓰던 이전 방식에서
 *  2026-07-28 변경). `phonetic`(최상위 대표값)과 `phonetics[].text`(개별 값, 중복 많음—
 *  실측: "run"은 4개 중 서로 다른 값이 1개뿐) 전부 모아 중복만 제거한다. 실패(네트워크
 *  오류·404 등)해도 조용히 빈 배열 반환 — 발음은 부가 정보라 이것 때문에 전체 조회를
 *  실패시키지 않는다. */
async function fetchEnPronunciations(word: string): Promise<string[]> {
  try {
    const res = await fetch(`${DICTIONARYAPI_DEV_ENDPOINT}/${encodeURIComponent(word)}`, {
      headers: { 'User-Agent': WIKTIONARY_USER_AGENT },
    })
    if (!res.ok) return []
    const raw = (await res.json()) as DictionaryApiDevEntry[]
    const values: string[] = []
    for (const entry of raw) {
      if (entry.phonetic) values.push(entry.phonetic)
      for (const p of entry.phonetics ?? []) if (p.text) values.push(p.text)
    }
    return dedupe(values)
  } catch {
    /* 폴백 실패는 무시 — 나머지 사전 정보는 이미 확보돼 있음 */
    return []
  }
}

// ---- raw wikitext 발음 보강(ja/zh 전용) ---------------------------------------

/** en.wiktionary.org raw wikitext(action=parse, prop=wikitext)를 가져온다 — REST API가
 *  안 주는 발음 템플릿(ja-pron/zh-pron)이 여기에만 있다(DICTIONARY_SOURCES.md 실측).
 *  페이지 자체가 없으면(비표제어 등) `parse` 키가 응답에 없다(REST API 의 404 와 다른
 *  실패 모양 — MediaWiki action API 는 이 경우도 HTTP 200 을 준다, 실측 확인). */
async function fetchWikitext(word: string): Promise<string | undefined> {
  try {
    const url = `${WIKTIONARY_ACTION_API}?action=parse&page=${encodeURIComponent(word)}&prop=wikitext&format=json&formatversion=2`
    const res = await fetch(url, { headers: { 'User-Agent': WIKTIONARY_USER_AGENT } })
    if (!res.ok) return undefined
    const raw = (await res.json()) as { parse?: { wikitext?: string } }
    return raw.parse?.wikitext
  } catch {
    return undefined
  }
}

/** ja 읽기(들) — {{ja-pron|よみ|...}} 의 첫 위치 인자를 전부 뽑는다. 실측 확인(2026-07-28,
 *  走る/美しい/東京/猫/犬/食べる 6개 표제어 직접 wikitext 조회): 이 템플릿이 항상 히라가나
 *  읽기를 첫 인자로 그대로 담고 있어(예: "走る"→"はしる", "美しい"→"うつくしい") 뒤따르는
 *  `acc=`/`acc_ref=`/`a=`(오디오 파일명) 등 named 파라미터와 파이프(|)로 안전하게 구분됨.
 *  한 표제어에 읽기가 여러 개인 경우(실측: "猫"→ねこ/ねこま 2개, "東京"→とうきょう/とうけい/
 *  トンキン 3개) **전부 모아 배열로 채운다**(DictionaryReading.pronunciations 가 배열이라
 *  전부 담을 수 있음 — 첫 번째만 대표로 쓰던 이전 방식에서 2026-07-28 변경, 猫/東京로
 *  재검증). 어느 읽기가 어느 sense에 대응하는지까지는 아직 안 함 — 정확한 매칭은 추후
 *  Kotobank/JMdict 정식 어댑터가 담당. 템플릿 자체가 없으면(드묾, 명사 표제어 일부)
 *  빈 배열. */
async function fetchJaPronunciations(word: string): Promise<string[]> {
  const wikitext = await fetchWikitext(word)
  if (!wikitext) return []
  const values = [...wikitext.matchAll(/\{\{ja-pron\|([^|}]+)/g)].map((m) => m[1].trim()).filter(Boolean)
  return dedupe(values)
}

/** zh 표준중국어(Mandarin) 병음(들) — {{zh-pron|m=병음|...}} 의 m= 파라미터만 뽑는다(다른
 *  방언 파라미터 c=광둥어/h=객가어/mn=민난어 등은 DICTIONARY_SOURCES.md 방침대로 버림).
 *  실측 확인(2026-07-28, 你好/中國/一/打/謝謝/打算/水/的/了/麼/嗎 11개 표제어 직접 wikitext
 *  조회) 결과 이 파라미터엔 두 가지 함정이 있었다:
 *  1. **값이 콤마로 여러 개 이어질 수 있고, 그중 일부는 실제 병음이 아니라 콤마로 덧붙는
 *     수식 플래그**다 — 예: "打算"→"m=dǎsuàn,tl=y"(tl=톤 산디 플래그), "水"→"m=shuǐ,er=y"
 *     (er=얼화 플래그), "的"→"m=de,dì,2tl=y,1nb=unstressed,2nb=stressed"(앞 2개는 실제
 *     복수 병음 — "de"/"dì" 둘 다 진짜 발음이라 둘 다 채택, 뒤 3개는 번호 붙은 플래그).
 *     콤마로 나눈 뒤 "=" 가 들어간 세그먼트(플래그)만 걸러내고 남는 건 전부 병음으로
 *     채택한다 — 첫 번째만 쓰던 이전 방식에서 2026-07-28 변경(DictionaryReading.
 *     pronunciations 가 배열이라 전부 담을 수 있음).
 *  2. **일부 블록은 m= 값 자체가 병음이 아니라 한자 표제어 그대로**인 경우가 있다(실측:
 *     "一"/"打" 일부 블록 → "m=一"/"m=打" — 정확한 의미는 불명, 아마 "문자 자체의 별도
 *     항목을 보라"는 플레이스홀더로 추정). 이런 값은 한자만 포함해 병음처럼 안 보이므로
 *     한자(CJK 통합 한자) 포함 여부로 걸러낸다.
 *  3. **표제어에 zh-pron 블록이 여러 개 있고(다의어·이독), 일부 블록엔 아예 m= 자체가
 *     없을 수 있다**(실측: "一" 세 번째 블록 — 민난어/객가어 전용, m= 없음) — 이 경우
 *     그 블록만 건너뛰고 m= 가 있는 다른 블록은 계속 수집한다. */
function extractZhMandarinFromWikitext(wikitext: string): string[] {
  const blockRegex = /\{\{zh-pron\b[^}]*?\|m=([^|\n}]+)/g
  const values: string[] = []
  for (const m of wikitext.matchAll(blockRegex)) {
    const candidates = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('=') && !/[㐀-鿿豈-﫿]/.test(s))
    values.push(...candidates)
  }
  return dedupe(values)
}

async function fetchZhPronunciations(word: string): Promise<string[]> {
  const wikitext = await fetchWikitext(word)
  if (!wikitext) return []
  return extractZhMandarinFromWikitext(wikitext)
}

// ---- WiktionaryPosBlock[] → DictionaryEntry ----------------------------------

/** REST API 는 발음/homograph 그룹을 안 주므로(DICTIONARY_SOURCES.md 실측: phonetic 필드
 *  자체가 없음), pos 블록 하나당 reading 하나로 대응한다 — pronunciations 는 여기선 항상
 *  undefined 로 두고(en 은 fetchWiktionaryEntry 가 dictionaryapi.dev 로 보강). */
function blockToReading<L extends Language>(block: WiktionaryPosBlock, language: L): DictionaryReading<L> | null {
  const mapped = mapPos(block.partOfSpeech, language)
  const pos = mapped ? [mapped] : undefined
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
  const res = await fetch(url, { headers: { 'User-Agent': WIKTIONARY_USER_AGENT } })
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

  const pronunciations =
    language === 'en'
      ? await fetchEnPronunciations(word)
      : language === 'ja'
        ? await fetchJaPronunciations(word)
        : await fetchZhPronunciations(word)
  if (pronunciations.length) {
    const values = pronunciations.map((value) => ({ value }))
    for (const reading of readings) reading.pronunciations = values
  }

  const entry = {
    language,
    headword: [word],
    readings,
    source: 'wiktionary',
  } as DictionaryEntry<L>

  return { entry }
}
