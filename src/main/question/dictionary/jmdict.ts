import { readFile } from 'fs/promises'
import { join } from 'path'
import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, SeeAlsoRef, UsageTag, UsageTagKind } from '@shared/types'

// 담당 ja — JMdict 로컬 번들 어댑터 (PLAN.md §5 ja-2, Kotobank 실패 시 폴백 & 품사 판정 1순위 소스)
// TODO.md/DICTIONARY_SOURCES.md 결정(2026-07-28): jisho.org 라이브 API가 아니라
// jmdict-simplified(scriptin/jmdict-simplified) "full"+"eng" 변형 로컬 JSON 번들로 확정 —
// jisho.org는 field(전문분야)/misc(사용역)를 tags 하나로 뭉개거나 노출을 안 해서, 원본
// 구조화(Sense.field/misc/dialect 분리, Kana.appliesToKanji 등)를 그대로 보존하는 로컬
// 번들이 필요했다. 번들 생성은 scripts/build-jmdict-bundle.py 참고 — 이 어댑터는
// resources/jmdict/{words,index,tags}.json 세 파일만 읽는다(네트워크 호출 없음).
//
// **활용형 미대응**: JMdict는 Kotobank와 마찬가지로 활용된 형태를 원형으로 자동 변환해
// 주지 않는다(TODO.md 131번 항목) — 표면형을 그대로 index.json 에 정확히 매칭해서만
// 조회한다. 基本形 전처리는 이 어댑터의 스코프 밖(main/nlp/japanese.ts 형태소 분석 결과가
// 조회 전에 이미 적용돼 있어야 함).

const WORDS_PATH = join(__dirname, '../../resources/jmdict/words.json')
const INDEX_PATH = join(__dirname, '../../resources/jmdict/index.json')
const TAGS_PATH = join(__dirname, '../../resources/jmdict/tags.json')

// ---- 번들 원본 타입(scripts/build-jmdict-bundle.py 가 만드는 trimmed 구조) --------------

interface JmdictBundleKanji {
  text: string
  common: boolean
}

interface JmdictBundleKana {
  text: string
  common: boolean
  /** 이 가나가 적용되는 한자 표기만 한정될 때만 있음(전체 적용이면 필드 자체가 없음 —
   *  빌드 스크립트가 원본의 "*" 를 지워서 만듦). */
  appliesToKanji?: string[]
}

interface JmdictBundleSense {
  partOfSpeech: string[]
  /** appliesToKana 와 마찬가지로 "전체 적용"("*")이면 필드 자체가 없음. 이 어댑터는
   *  reading 을 가나 단위로만 나누므로(DictionaryReading 이 표기가 아니라 발음 그룹),
   *  appliesToKanji 는 스코프 제외(TODO.md 137번 항목 결정과 동일 판단). */
  appliesToKanji?: string[]
  appliesToKana?: string[]
  related?: string[]
  antonym?: string[]
  field?: string[]
  dialect?: string[]
  misc?: string[]
  info?: string[]
  gloss: string[]
}

interface JmdictBundleWord {
  kanji: JmdictBundleKanji[]
  kana: JmdictBundleKana[]
  sense: JmdictBundleSense[]
}

type JmdictBundleWords = Record<string, JmdictBundleWord>
type JmdictBundleIndex = Record<string, string[]>
type JmdictBundleTags = Record<string, string>

interface JmdictBundle {
  words: JmdictBundleWords
  index: JmdictBundleIndex
  tags: JmdictBundleTags
}

let bundlePromise: Promise<JmdictBundle> | null = null

/** words.json(54MB)+index.json(14MB)+tags.json 파싱은 최초 1회만 — oewn.ts getBundle() 과
 *  동일 패턴(캐시된 프라미스 재사용). */
function getBundle(): Promise<JmdictBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [wordsRaw, indexRaw, tagsRaw] = await Promise.all([
        readFile(WORDS_PATH, 'utf-8'),
        readFile(INDEX_PATH, 'utf-8'),
        readFile(TAGS_PATH, 'utf-8'),
      ])
      return {
        words: JSON.parse(wordsRaw) as JmdictBundleWords,
        index: JSON.parse(indexRaw) as JmdictBundleIndex,
        tags: JSON.parse(tagsRaw) as JmdictBundleTags,
      }
    })()
  }
  return bundlePromise
}

// ---- JMdict partOfSpeech 코드 → CanonicalPos<'ja'> -----------------------------------

/** 실측 확인(jmdict-eng-3.6.2 전수 스캔): 이 사전에 실제로 등장하는 partOfSpeech 코드
 *  77종 전부를 다룬다. 'exp'(구/관용구)·'aux'(일반 조동사)·'unc'/'v-unspec'(미분류)처럼
 *  품사라기보다 분류 표시에 가까운 코드는 'other'로 둔다. */
const POS_TO_CANONICAL: Record<string, CanonicalPos<'ja'>> = {
  n: 'noun',
  'n-pr': 'noun',
  'n-t': 'noun',
  'n-adv': 'noun',
  'n-suf': 'noun',
  'n-pref': 'noun',
  num: 'noun',
  ctr: 'noun',
  pn: 'pronoun',
  adv: 'adverb',
  'adv-to': 'adverb',
  conj: 'conjunction',
  int: 'interjection',
  prt: 'particle',
  'adj-pn': 'adnominal',
  'adj-i': 'adjective',
  'adj-ix': 'adjective',
  'adj-na': 'adjective',
  'adj-no': 'adjective',
  'adj-t': 'adjective',
  'adj-f': 'adjective',
  'adj-ku': 'adjective',
  'adj-shiku': 'adjective',
  'adj-nari': 'adjective',
  'adj-kari': 'adjective',
  'aux-adj': 'adjective',
  'aux-v': 'verb',
  v1: 'verb',
  'v1-s': 'verb',
  vk: 'verb',
  vn: 'verb',
  vr: 'verb',
  vs: 'verb',
  'vs-c': 'verb',
  'vs-i': 'verb',
  'vs-s': 'verb',
  vz: 'verb',
  'v-unspec': 'other',
  cop: 'other',
  aux: 'other',
  exp: 'other',
  suf: 'other',
  pref: 'other',
  unc: 'other',
}
// v4*/v5*/v2*-k/v2*-s(五段/四段/二段 활용형 코드)는 전부 동사라 규칙적으로 채운다 — 하드코딩
// 77개 표 안에 다 늘어놓는 대신 정규식으로 한 번에 매칭.
const VERB_CODE_RE = /^v(4[a-z]|5[a-z0-9-]+|2[a-z]-[ks])$/

/** JMdict 의 partOfSpeech 는 sense 하나에 코드가 여러 개 동시에 붙을 수 있다(실측:
 *  "らしい" sense2 → `["suf", "adj-i"]` — 접미사이면서 い형용사, "元気" sense1 →
 *  `["Na-adjective (keiyodoshi)", "Noun"]` — な형용사이면서 명사). 예전엔 "other가
 *  아닌 첫 코드"에서 멈추고 하나만 반환해 이 중복 표시가 사라졌다(2026-07-28 이전) — 이제
 *  매핑되는 코드 전부를 순서대로 모아 반환한다(같은 canonical 값으로 중복 매핑되면 dedup). */
function mapPos(codes: string[]): CanonicalPos<'ja'>[] | undefined {
  const out: CanonicalPos<'ja'>[] = []
  for (const code of codes) {
    const mapped = VERB_CODE_RE.test(code) ? 'verb' : POS_TO_CANONICAL[code]
    if (mapped === undefined) continue
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out.length ? out : undefined
}

// ---- 활용 분류(conjugationClass) — 문법 설명에 실제로 쓰이는 정보라 posRaw 와 별도로 승격 ---

const V5_SUFFIX_LABEL: Record<string, string> = {
  aru: 'ある 특수',
  'u-s': 'う, 특수',
  'k-s': 'いく/ゆく 특수',
  'r-i': 'る, 불규칙',
  b: 'ぶ',
  g: 'ぐ',
  k: 'く',
  m: 'む',
  n: 'ぬ',
  r: 'る',
  s: 'す',
  t: 'つ',
  u: 'う',
}
const V4_SUFFIX_LABEL: Record<string, string> = { b: 'ぶ', g: 'ぐ', h: 'はふ', k: 'く', m: 'む', r: 'る', s: 'す', t: 'つ' }

const CONJUGATION_CLASS_FIXED: Record<string, string> = {
  v1: '一段',
  'v1-s': '一段(くれる 특수)',
  vk: 'カ行変格(来る)',
  vn: 'ぬ 불규칙',
  vr: 'り 불규칙',
  vs: 'サ変(する)',
  'vs-i': 'サ変(する)',
  'vs-s': 'サ変(특수)',
  'vs-c': 'サ変(고어, す)',
  vz: '一段(ずる)',
  'adj-i': 'い형용사',
  'adj-ix': 'い형용사(いい/よい류)',
  'adj-na': 'な형용사',
  'adj-no': '명사(の 로 연결)',
  'adj-t': 'たる형용사(고어)',
  'adj-f': '연체수식 전용(활용 없음)',
  'adj-ku': 'く형용사(고어)',
  'adj-shiku': 'しく형용사(고어)',
  'adj-nari': 'なり형용사(고어)',
  'adj-kari': 'かり형용사(고어)',
}

/** run/kick the bucket 류처럼 여러 partOfSpeech 코드 중 활용 정보를 담은 첫 코드 하나만
 *  찾아 사람이 읽을 수 있는 문자열로 디코딩한다(OEWN 의 irregularForms 와 같은 역할 —
 *  posRaw 만으론 v5k/v1 같은 약어가 그대로 남아 문법 설명에 못 쓰임). */
function conjugationClassFor(codes: string[]): string | undefined {
  for (const code of codes) {
    if (CONJUGATION_CLASS_FIXED[code]) return CONJUGATION_CLASS_FIXED[code]

    const v5 = /^v5([a-z0-9-]+)$/.exec(code)
    if (v5 && V5_SUFFIX_LABEL[v5[1]]) return `五段(${V5_SUFFIX_LABEL[v5[1]]})`

    const v4 = /^v4([a-z])$/.exec(code)
    if (v4 && V4_SUFFIX_LABEL[v4[1]]) return `四段(${V4_SUFFIX_LABEL[v4[1]]}, 고어)`

    const v2 = /^v2([a-z])-([ks])$/.exec(code)
    if (v2) return `${v2[2] === 'k' ? '上' : '下'}二段(${v2[1]}행, 고어)`
  }
  return undefined
}

// ---- misc 코드 → UsageTagKind 분류 ---------------------------------------------------
// DICTIONARY_SOURCES.md JMdict 절 결정: misc 값마다 register(격식/사용역)인지 convention
// (표기 관례)인지가 갈려서, 원본 misc 코드 기준 룩업 테이블로 분류해야 함(jisho.org 의
// 영문 tags 설명만으론 이 구분이 항상 명확하지 않음 — 로컬 번들이라 원본 코드가 보존돼
// 있어 가능한 분류). dialect 는 misc 가 아니라 별도 sense.dialect 필드로 이미 분리돼 옴.
const REGISTER_MISC = new Set([
  'sl',
  'm-sl',
  'net-sl',
  'derog',
  'col',
  'hon',
  'hum',
  'pol',
  'arch',
  'obs',
  'dated',
  'rare',
  'joc',
  'vulg',
  'sens',
  'fam',
  'poet',
  'form',
  'euph',
  'male',
  'fem',
  'chn',
  'hist',
])
const CONVENTION_MISC = new Set(['uk', 'abbr'])

function classifyMisc(code: string): UsageTagKind {
  if (REGISTER_MISC.has(code)) return 'register'
  if (CONVENTION_MISC.has(code)) return 'convention'
  return 'other'
}

// ---- sense/kana → DictionarySense/DictionaryReading ------------------------------------

function tagLabel(code: string, tags: JmdictBundleTags): string {
  return tags[code] ?? code
}

function buildSense(s: JmdictBundleSense, tags: JmdictBundleTags): DictionarySense<'ja'> | null {
  if (!s.gloss.length) return null // gloss 필수 — 못 채우면 이 sense 버린다(다른 소스와 동일 방침)

  const usageTags: UsageTag[] = [
    ...(s.dialect ?? []).map((code): UsageTag => ({ text: tagLabel(code, tags), kind: 'dialect' })),
    ...(s.misc ?? []).map((code): UsageTag => ({ text: tagLabel(code, tags), kind: classifyMisc(code) })),
  ]
  const seeAlso: SeeAlsoRef[] | undefined = s.related?.length ? s.related.map((text): SeeAlsoRef => ({ text, kind: 'related' })) : undefined

  return {
    pos: mapPos(s.partOfSpeech),
    posRaw: s.partOfSpeech.join(', '),
    gloss: s.gloss,
    domain: s.field?.length ? s.field.map((code) => tagLabel(code, tags)) : undefined,
    usageTags: usageTags.length ? usageTags : undefined,
    usageNote: s.info?.length ? s.info.join('; ') : undefined,
    seeAlso,
    antonyms: s.antonym?.length ? s.antonym : undefined,
    transitive: s.partOfSpeech.includes('vt') ? true : s.partOfSpeech.includes('vi') ? false : undefined,
    conjugationClass: conjugationClassFor(s.partOfSpeech),
  }
}

/** sense 가 이 가나 표기에 적용되는지 — appliesToKana 가 없으면(빌드 스크립트가 "*" 를
 *  지워서 만듦) 전체 가나에 적용된다는 뜻. */
function senseAppliesToKana(s: JmdictBundleSense, kanaText: string): boolean {
  return !s.appliesToKana || s.appliesToKana.includes(kanaText)
}

function buildReading(kana: JmdictBundleKana, allSenses: JmdictBundleSense[], tags: JmdictBundleTags): DictionaryReading<'ja'> | null {
  const senses = allSenses
    .filter((s) => senseAppliesToKana(s, kana.text))
    .map((s) => buildSense(s, tags))
    .filter((s): s is DictionarySense<'ja'> => s !== null)
  if (!senses.length) return null

  return {
    // JMdict 는 IPA 를 안 주고 가나 표기 자체가 발음 표기다(ja 는 kana=발음이라 다른
    // 언어의 pronunciations.value(IPA 등) 자리에 가나 텍스트를 넣는다).
    pronunciations: [{ value: kana.text }],
    senses,
    isCommon: kana.common,
    appliesToHeadwords: kana.appliesToKanji,
  }
}

// ---- 진입점 -----------------------------------------------------------------

export interface JmdictLookupResult {
  entries?: DictionaryEntry<'ja'>[]
}

function buildEntry(word: JmdictBundleWord, tags: JmdictBundleTags): DictionaryEntry<'ja'> | null {
  const kanjiTexts = word.kanji.map((k) => k.text)
  const kanaTexts = word.kana.map((k) => k.text)
  const headword = kanjiTexts.length ? kanjiTexts : kanaTexts // 가나만 있는 표제어(예: らしい) 대응
  if (!headword.length) return null

  const readings = word.kana.map((k) => buildReading(k, word.sense, tags)).filter((r): r is DictionaryReading<'ja'> => r !== null)
  if (!readings.length) return null

  // isIdiom: JMdict 는 partOfSpeech "exp"(구/관용구) 또는 misc "yoji"(사자성어)로 표시한다
  // (DICTIONARY_SOURCES.md JMdict 절 실측 확인).
  const isIdiom = word.sense.some((s) => s.partOfSpeech.includes('exp') || (s.misc ?? []).includes('yoji')) || undefined

  return { language: 'ja', headword, isIdiom, readings, source: 'jmdict' }
}

/** word 를 로컬 jmdict-simplified 번들에서 조회한다. 활용형 자동 변환은 안 하므로(위
 *  파일 상단 주석) 표면형 그대로 index.json 에 정확 매치되는 word id 들을 전부 모아
 *  각각 entry 로 반환 — 같은 표기가 여러 word 엔트리로 갈리는 경우(동형이의어)가 실제로
 *  있어(JMdict 는 표제어 하나당 id 하나씩 별도 word 로 등재) OEWN 처럼 배열로 돌려준다. */
export async function fetchJmdictEntry(word: string): Promise<JmdictLookupResult> {
  const bundle = await getBundle()
  const ids = bundle.index[word]
  if (!ids?.length) return {}

  const entries = ids
    .map((id) => bundle.words[id])
    .filter((w): w is JmdictBundleWord => w !== undefined)
    .map((w) => buildEntry(w, bundle.tags))
    .filter((e): e is DictionaryEntry<'ja'> => e !== null)
  if (!entries.length) return {}

  return { entries }
}
