import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, Language } from '@shared/types'
import { extractEnIpaValues } from './wiktionaryEnPron'
import { extractJaPronValues } from './wiktionaryJaPron'
import { extractZhMandarinFromWikitext, tryZhDefinitionsFallback } from './wiktionaryZh'

// 담당 B — Wiktionary 어댑터 (PLAN.md §5, en/ja/zh 공용 최종 폴백)
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary (공용 — en/ja/zh 최종 폴백)" 절 참고.
// en.wiktionary.org 공식 REST API(GET /api/rest_v1/page/definition/{word}, 무료·키 불필요)를
// 뜻풀이 소스로 쓴다 — ja.wiktionary.org/zh.wiktionary.org 같은 네이티브판은 커버리지가 더
// 약해 미채택. 이 API 엔 발음(phonetic) 필드가 없어(실측) en/ja/zh 세 언어 모두 발음은
// en.wiktionary.org 의 raw wikitext(action=parse)에서 따로 뽑는다. **처음엔 en 만
// dictionaryapi.dev(서드파티, en.wiktionary.org 데이터 재가공)로 보강했었는데, 그 API가
// meaning(품사)별 구분 없이 entry 하나에 발음 하나만 줘서(실측: "lead"(금속 /lɛd/) vs
// "lead"(이끌다 /liːd/) 처럼 뜻마다 발음이 다른 단어를 구분 못 함) 결국 걷어내고 en도
// ja/zh 와 똑같이 wikitext 경로로 통일했다(2026-07-28, 사용자 지적) — en wikitext 도
// `===Etymology N===`/`====Pronunciation====`/`{{IPA|en|...}}` 구조가 ja/zh 와 동일해서
// (실측: "lead"/"run") 셋 다 같은 함수(assignPerBlockPronunciations)로 처리 가능함이
// 확인됨. en `{{IPA|en|/lɛd/|...}}`, ja `{{ja-pron|よみ|...}}`, zh `{{zh-pron|m=병음|...}}`
// 에서 값만 뽑는다(활용표·방언 발음 전체를 파싱하는 건 여전히 스코프 밖). **단순히 페이지
// 전체에서 긁어 전부 합치는 게 아니라**, wikitext 의 헤더 구조를 걸어 REST API 블록
// 하나하나에 정확히 대응되는 발음만 붙인다 — 실측 근거는 assignPerBlockPronunciations
// 주석 참고.
//
// **파일 구성**(2026-07-28, 파일 크기가 커져서 분리): 이 파일은 공용 로직(REST API 호출,
// wikitext 헤더 구조 파싱, mapPos/HTML 정리, fetchWiktionaryEntry 오케스트레이션)만
// 갖는다. 언어별 발음 추출은 wiktionaryEnPron.ts/wiktionaryJaPron.ts 로, zh 전용 발음
// 추출 + 단일 한자 REST API 누락 대응 fallback(분량이 커서 en/ja와 비대칭)은
// wiktionaryZh.ts 로 분리했다.

const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition'
const WIKTIONARY_ACTION_API = 'https://en.wiktionary.org/w/api.php'
/** Wikimedia User-Agent 정책(https://meta.wikimedia.org/wiki/User-Agent_policy) 준수용 —
 *  "ClientName/Version (연락처)" 형식으로 연락 가능한 수단을 명시해야 한다(이메일 필수는
 *  아님 — 이슈를 남길 수 있는 저장소 URL도 인정되는 형태). 연락처 없는 UA는 정책 위반으로
 *  더 강하게 레이트리밋/차단될 수 있음(실측: 개발 중 여러 번 HTTP 429 수신). */
const WIKTIONARY_USER_AGENT = 'JoJo-dictionary-adapter/1.0 (https://github.com/madcamp-official/JoJo)'

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

/** 순서를 유지하며 중복만 제거 — wiktionaryEnPron/wiktionaryJaPron/wiktionaryZh 의
 *  extract*Values 함수가 공유(그래서 export). */
export function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// ---- raw wikitext 발음 보강(en/ja/zh 공용) -------------------------------------

/** en.wiktionary.org raw wikitext(action=parse, prop=wikitext)를 가져온다 — REST API가
 *  안 주는 발음 템플릿(ja-pron/zh-pron)이 여기에만 있다(DICTIONARY_SOURCES.md 실측).
 *  페이지 자체가 없으면(비표제어 등) `parse` 키가 응답에 없다(REST API 의 404 와 다른
 *  실패 모양 — MediaWiki action API 는 이 경우도 HTTP 200 을 준다, 실측 확인). zh 단일
 *  한자 fallback(wiktionaryZh.ts tryZhDefinitionsFallback)도 재사용하므로 export. */
export async function fetchWikitext(word: string): Promise<string | undefined> {
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

// ---- 헤더 트리 순서로 발음을 POS 블록에 정확히 대응 ----------------------------

/** Wiktionary 언어 섹션(`==Japanese==` 등)을 헤더 등장 순서대로 걸어, 각 POS 헤더
 *  (=REST API 블록)에 그 직전 `====Pronunciation====` 헤더에서 뽑은 값을 붙인다.
 *
 *  **왜 필요한가** — 실측 확인(2026-07-28, 猫/東京/打 wikitext 헤더 구조 직접 확인):
 *  `{{ja-pron}}`/`{{zh-pron}}`는 페이지 전체에 뭉텅이로 있는 게 아니라 `===Etymology
 *  N===`(다의어별) 아래 `====Pronunciation====`으로, 그 바로 다음 POS 섹션(`====Noun====`
 *  등)에만 대응된다 — 예: "猫"는 Etymology 1(ねこ)/Noun, Etymology 2(ねこま)/Noun 로
 *  완전히 분리돼 있고, "東京"은 Etymology 1(とうきょう)/Proper noun+Noun, Etymology
 *  2(とうけい)/Proper noun, Etymology 3(トンキン)/Proper noun 로 분리돼 있다. 단일
 *  Etymology 표제어(예: 食べる)는 `===Etymology===`/`===Pronunciation===`/`===Verb===`
 *  가 같은 깊이로 나란히 오는데, 두 구조 다 "헤더 등장 순서로 걷기"만 하면 동일하게
 *  처리된다(깊이는 안 봄).
 *
 *  **REST API와 순서 정합 실측 확인**: 東京의 wikitext 헤더 순서 [Proper noun, Noun,
 *  Proper noun, Proper noun] ↔ REST API 블록 순서 [Proper noun(5 defs), Noun(1),
 *  Proper noun(5), Proper noun(1)]가 완전히 일치했고, 猫도 [Noun, Noun] 일치했다 —
 *  그래서 "헤더 텍스트가 지금 기다리는 REST 블록의 partOfSpeech 와 일치할 때만
 *  매칭·소비"하는 방식으로 순서를 맞춘다.
 *
 *  **실패 시 undefined(추측하지 않음)**: 헤더 구조가 예상과 달라(드묾) 블록 수만큼
 *  못 채우면 남는 블록은 undefined로 남긴다 — 예전 방식(구분 없이 페이지 전체 발음을
 *  모든 reading에 똑같이 복제)은 猫/東京처럼 서로 다른 읽기를 가진 표제어에서 부정확한
 *  정보를 자신 있게 보여주는 문제가 있었다(2026-07-28 사용자 피드백으로 발견) — "모른다"가
 *  틀린 값보다 안전하다는 판단.
 *
 *  **반환값에 groupId 를 같이 준다**(2026-07-28, 안전성 개선) — 처음엔 fetchWiktionaryEntry
 *  가 "바로 이전 블록과 pronunciations 배열이 레퍼런스로 같은가"를 보고 같은 Pronunciation
 *  헤더에 속하는지 판단했는데, 이건 "이 함수가 새 Pronunciation 헤더를 만날 때만 새
 *  배열을 만든다"는 내부 구현 디테일에 호출부가 암묵적으로 의존하는 셈이라, 나중에 이
 *  함수를 고치면서 그 습관이 깨지면(예: 매번 새 배열을 만들도록 리팩터링) 조용히 병합이
 *  전부 안 되는 버그로 이어질 수 있었다. Pronunciation 헤더를 새로 만날 때마다 증가하는
 *  숫자(groupId)를 명시적으로 반환해, 호출부가 배열 레퍼런스가 아니라 이 숫자만 비교하면
 *  되게 했다 — 값이 같은 값이라도(예: 우연히 같은 발음) groupId 가 다르면 다른 그룹으로
 *  남는다. */
interface BlockPronunciation {
  values: string[] | undefined
  /** 이 블록이 속한 Pronunciation 헤더 그룹 번호(0-based, 첫 Pronunciation 헤더를
   *  만나기 전 블록은 -1 — 어차피 values 가 undefined 라 병합 대상이 안 됨). */
  groupId: number
}

function assignPerBlockPronunciations(
  wikitext: string,
  languageName: string,
  blocks: WiktionaryPosBlock[],
  extractValues: (content: string) => string[],
): BlockPronunciation[] {
  const results: BlockPronunciation[] = blocks.map(() => ({ values: undefined, groupId: -1 }))

  const sectionRegex = new RegExp(`==${languageName}==([\\s\\S]*?)(?=\\n==[A-Za-z][^=\\n]*==\\n|$)`)
  const sectionMatch = wikitext.match(sectionRegex)
  if (!sectionMatch) return results
  const section = sectionMatch[1]

  const headingRegex = /^(=+)\s*(.+?)\s*\1\s*$/gm
  const headings: { text: string; start: number; end: number }[] = []
  for (const m of section.matchAll(headingRegex)) {
    const start = m.index ?? 0
    headings.push({ text: m[2].trim(), start, end: start + m[0].length })
  }

  let currentPron: string[] = []
  let currentGroupId = -1
  let blockIdx = 0
  for (let i = 0; i < headings.length && blockIdx < blocks.length; i++) {
    const h = headings[i]
    const contentEnd = i + 1 < headings.length ? headings[i + 1].start : section.length
    const content = section.slice(h.end, contentEnd)

    // zh 는 "===Pronunciation N===" 형태로 번호가 붙는 경우가 있다(ja 의 "===Etymology
    // N===" 와 대응하는 zh 쪽 관례 — 실측 확인, 2026-07-28, 結實/地方: "Pronunciation 1"/
    // "Pronunciation 2" 로 발음군이 나뉘고 그 아래 POS 헤더가 옴). 번호 없는 단일
    // "Pronunciation"(ja 전용, zh 도 발음군이 하나면 번호 없이 옴)도 계속 지원해야 해서
    // 정규식으로 둘 다 받는다 — exact-match 였을 때는 번호 붙은 케이스를 통째로 놓쳐서
    // currentPron 이 끝까지 빈 채로 남고 모든 zh 블록이 undefined 가 되는 버그가 있었음.
    if (/^Pronunciation(\s+\d+)?$/.test(h.text)) {
      currentPron = extractValues(content)
      currentGroupId++
      continue
    }
    if (h.text === blocks[blockIdx].partOfSpeech) {
      results[blockIdx] = { values: currentPron.length ? currentPron : undefined, groupId: currentGroupId }
      blockIdx++
    }
  }
  return results
}

// ---- WiktionaryPosBlock[] → DictionaryEntry ----------------------------------

/** REST API 는 발음/homograph 그룹을 안 주므로(DICTIONARY_SOURCES.md 실측: phonetic 필드
 *  자체가 없음), pos 블록 하나당 reading 하나로 대응한다 — pronunciations 는 여기선 항상
 *  undefined 로 두고(fetchWiktionaryEntry 가 raw wikitext 로 블록별로 보강). */
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
 *  객체를 반환 — MW 어댑터의 suggestions 같은 부가 정보가 이 API 엔 없다. 단, zh 는
 *  404/빈 블록이어도 곧바로 포기하지 않고 tryZhDefinitionsFallback 을 시도한다(wiktionaryZh.ts
 *  참고 — 이 두 실패 모양 다 zh 단일 한자 표제어에서 실측 확인됨). */
export async function fetchWiktionaryEntry<L extends Language>(
  word: string,
  language: L,
): Promise<WiktionaryLookupResult<L>> {
  const isZh = language === 'zh-Hans' || language === 'zh-Hant'
  const langName = WIKTIONARY_LANG_NAME[language]

  const url = `${WIKTIONARY_ENDPOINT}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': WIKTIONARY_USER_AGENT } })
  if (res.status === 404) return isZh ? tryZhDefinitionsFallback(word, language, langName) : {}
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
  const blocks = (raw[langKey] ?? []).filter((b) => b.language === langName)
  if (!blocks.length) return isZh ? tryZhDefinitionsFallback(word, language, langName) : {}

  // blocks 인덱스를 보존한 채 reading 을 만든다 — gloss 가 하나도 안 남아 블록이 통째로
  // 버려지는 경우가 있어(blockToReading 이 null 반환), 아래 발음 매칭이 "원래 REST API
  // 블록 순서"를 기준으로 하는 assignPerBlockPronunciations 결과와 어긋나지 않으려면
  // 버려진 블록의 인덱스도 계속 알고 있어야 한다.
  const readingsWithBlockIndex = blocks
    .map((b, blockIndex) => ({ blockIndex, reading: blockToReading(b, language) }))
    .filter((r): r is { blockIndex: number; reading: DictionaryReading<L> } => r.reading !== null)
  if (!readingsWithBlockIndex.length) return {}

  // en/ja/zh 전부 raw wikitext 헤더 구조를 걸어 블록별로 정확한 발음을 매칭한다(위
  // assignPerBlockPronunciations 주석 참고) — 페이지 전체에서 긁어 모든 reading 에
  // 뭉뚱그려 넣지 않는다.
  const wikitext = await fetchWikitext(word)
  const perBlock: BlockPronunciation[] = wikitext
    ? assignPerBlockPronunciations(
        wikitext,
        langName,
        blocks,
        language === 'en' ? extractEnIpaValues : language === 'ja' ? extractJaPronValues : extractZhMandarinFromWikitext,
      )
    : blocks.map(() => ({ values: undefined, groupId: -1 }))

  // 같은 Pronunciation 헤더에 딸린 블록들(예: "lead" 금속 뜻의 Noun+Verb, 실측: 둘 다
  // /ˈlɛd/)은 DictionaryReading 이 원래 "발음 하나에 딸린 sense 묶음"으로 설계됐다는
  // 취지(shared/types.ts DictionaryReading 주석 참고, MW hom·萌典 heteronyms 와 반대
  // 방향의 같은 원칙)에 맞춰 reading 하나로 합친다 — REST API 블록(품사 단위)과
  // DictionaryReading(발음 단위)이 서로 다른 축이라 기계적으로 1:1 대응시키면 같은
  // 발음이 여러 reading 으로 쪼개지는 문제가 있었다(2026-07-28 사용자 지적).
  // assignPerBlockPronunciations 가 명시적으로 돌려주는 groupId(같은 Pronunciation
  // 헤더 구간이면 같은 번호)로 그룹을 판별한다 — 배열 레퍼런스 동일성 비교(이전 방식)는
  // 그 함수의 "새 헤더를 만날 때만 새 배열을 만든다"는 내부 구현 디테일에 암묵적으로
  // 의존해서, 나중에 그 함수를 리팩터링하다 그 습관이 깨지면 조용히 병합이 전부 안 되는
  // 버그로 이어질 위험이 있었다(2026-07-28 안전성 개선). groupId 가 -1(발음 못 찾음)인
  // 블록은 서로 무관할 수 있어 합치지 않고 각자 별도 reading 으로 둔다.
  const readings: DictionaryReading<L>[] = []
  let lastGroupId = -1
  for (const { blockIndex, reading } of readingsWithBlockIndex) {
    const { values, groupId } = perBlock[blockIndex]
    const prev = readings[readings.length - 1]
    if (values && prev && groupId !== -1 && groupId === lastGroupId) {
      prev.senses.push(...reading.senses)
    } else {
      if (values?.length) reading.pronunciations = values.map((value) => ({ value }))
      readings.push(reading)
    }
    lastGroupId = groupId
  }

  const entry = {
    language,
    headword: [word],
    readings,
    source: 'wiktionary',
  } as DictionaryEntry<L>

  return { entry }
}
