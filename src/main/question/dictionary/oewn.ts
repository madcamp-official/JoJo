import { readFile } from 'fs/promises'
import { join } from 'path'
import type { CanonicalPos, DictionaryEntry, DictionaryPronunciation, DictionaryReading, DictionarySense } from '@shared/types'

// 담당 B — OEWN(Open English WordNet) 로컬 번들 어댑터 (PLAN.md §5 en-2, MW 실패 시 폴백)
// 원본은 공식 GitHub Releases JSON(`globalwordnet/english-wordnet` 2025-edition,
// `english-wordnet-2025-json.zip`)을 내려받아 build_bundle 스크립트로 두 파일로 병합해
// resources/oewn/ 에 둔 것: entries.json(표제어→품사(+hom 번호)→발음/활용형/synset id 목록),
// synsets.json(synset id→정의(복수 가능)/예문/품사). 원본은 entries-*.json(표제어 인덱스)과
// noun.animal.json 등 40여 개 렉시코그래퍼 파일(synset 정의)로 나뉘어 있고, hypernym/
// derivation/agent/sent/subcat 등 이 앱 스키마에서 안 쓰는 관계 정보를 병합 단계에서 뺐다
// (원본 70MB → 22MB). 실측 근거는 DICTIONARY_SOURCES.md "OEWN" 절 참고. 라이브 API
// (en-word.net)는 실측 결과 불안정(503)이라 쓰지 않는다 — 이 어댑터는 네트워크 호출이 없다.

const ENTRIES_PATH = join(__dirname, '../../resources/oewn/entries.json')
const SYNSETS_PATH = join(__dirname, '../../resources/oewn/synsets.json')

// ---- 번들 원본 타입 -----------------------------------------------------------

/** entries.json 의 품사 키는 'n'/'v'/'a'/'s'(satellite adjective)/'r' 뒤에 동형이의어
 *  구분 번호가 붙을 수 있다(실측: "denier" → `n-1`/`n-2`, 화폐 단위 denier 와 "부인하는
 *  사람" denier 가 서로 다른 발음·synset 을 가짐 — MW 의 hom 과 같은 역할). */
interface OewnBundleEntryPos {
  synsets: string[]
  pronunciation?: { value: string; variety?: string }[]
  form?: string[]
}
type OewnBundleEntries = Record<string, Record<string, OewnBundleEntryPos>>

interface OewnBundleSynset {
  definition: string[]
  example?: string[]
  partOfSpeech: string
}
type OewnBundleSynsets = Record<string, OewnBundleSynset>

interface OewnBundle {
  entries: OewnBundleEntries
  synsets: OewnBundleSynsets
  /** 활용형(예: "ran") → 원형 후보 목록(같은 활용형이 여러 표제어/품사에 걸칠 수 있음,
   *  실측: MW 쪽에서도 "closed"가 형용사 표제어이면서 동시에 "close"의 활용형인 사례가
   *  있었다) — entries 의 모든 `form[]`을 뒤집어 로드 시점에 한 번만 만든다. */
  formIndex: Map<string, { lemma: string; pos: string }[]>
}

let bundlePromise: Promise<OewnBundle> | null = null

/** 22MB 짜리 JSON 두 개를 파싱하고 활용형 역인덱스를 만드는 건 최초 1회만 — 이후 호출은
 *  캐시된 프라미스를 재사용한다(chineseTokenizer.ts 의 getTokenize 와 같은 패턴). */
function getBundle(): Promise<OewnBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [entriesRaw, synsetsRaw] = await Promise.all([readFile(ENTRIES_PATH, 'utf-8'), readFile(SYNSETS_PATH, 'utf-8')])
      const entries = JSON.parse(entriesRaw) as OewnBundleEntries
      const synsets = JSON.parse(synsetsRaw) as OewnBundleSynsets

      const formIndex = new Map<string, { lemma: string; pos: string }[]>()
      for (const [lemma, byPos] of Object.entries(entries)) {
        for (const [pos, info] of Object.entries(byPos)) {
          for (const form of info.form ?? []) {
            const key = form.toLowerCase()
            const list = formIndex.get(key)
            if (list) list.push({ lemma, pos })
            else formIndex.set(key, [{ lemma, pos }])
          }
        }
      }

      return { entries, synsets, formIndex }
    })()
  }
  return bundlePromise
}

// ---- WordNet 품사 코드 → CanonicalPos ------------------------------------------

/** 'n-1'/'v-2' 같은 hom 번호 접미사를 떼고 기본 품사 코드만 남긴다. */
function baseWnPos(posKey: string): string {
  return posKey.split('-')[0]
}

const WN_POS_TO_CANONICAL: Record<string, CanonicalPos<'en'>> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective', // satellite adjective — CanonicalPos 는 'adjective' 하나로 뭉뚱그림, posRaw 에 원본 보존
  r: 'adverb',
}

// ---- synset → DictionarySense ---------------------------------------------------

function synsetToSense(synsetId: string, posKey: string, synsets: OewnBundleSynsets, irregularForms?: string[]): DictionarySense<'en'> | null {
  const synset = synsets[synsetId]
  if (!synset || !synset.definition.length) return null // gloss 는 필수 필드 — 못 채우면 이 sense 는 버린다
  return {
    pos: WN_POS_TO_CANONICAL[baseWnPos(posKey)],
    posRaw: posKey,
    gloss: synset.definition,
    examples: synset.example?.length ? synset.example : undefined,
    irregularForms: irregularForms?.length ? irregularForms : undefined,
  }
}

// ---- entries[lemma][posKey] → DictionaryReading -------------------------------

function posInfoToReading(posKey: string, info: OewnBundleEntryPos, synsets: OewnBundleSynsets): DictionaryReading<'en'> | null {
  const senses = info.synsets
    .map((id) => synsetToSense(id, posKey, synsets, info.form))
    .filter((s): s is DictionarySense<'en'> => s !== null)
  if (!senses.length) return null

  const pronunciations: DictionaryPronunciation[] | undefined = info.pronunciation?.length
    ? info.pronunciation.map((p) => ({ value: p.value, variety: p.variety }))
    : undefined

  return { pronunciations, senses }
}

// ---- 진입점 -----------------------------------------------------------------

export interface OewnLookupResult {
  entries?: DictionaryEntry<'en'>[]
}

/** 조회 표면형을 entries 의 실제 키(원형)로 해석한다. WordNet 표제어는 대부분 소문자지만
 *  고유명사는 원문 그대로 대문자로 등재돼 있어(실측: "Bach") 대소문자 그대로 먼저 시도하고,
 *  실패하면 소문자로 재시도한다. 그래도 없으면 활용형 역인덱스(로드 시점에 만든 formIndex)
 *  에서 원형 후보를 찾는다 — 같은 활용형이 여러 (표제어, 품사) 쌍에 걸칠 수 있으므로
 *  후보 전부를 반환한다(예: "closed" 류 케이스는 MW 쪽에서 실측됐고, OEWN 도 원리상 같은
 *  가능성이 있어 방어적으로 배열 그대로 취급). */
function resolveLemmas(word: string, bundle: OewnBundle): { lemma: string; posKeys?: string[] }[] {
  if (bundle.entries[word]) return [{ lemma: word }]
  const lower = word.toLowerCase()
  if (lower !== word && bundle.entries[lower]) return [{ lemma: lower }]

  const inflected = bundle.formIndex.get(lower)
  if (!inflected?.length) return []
  const byLemma = new Map<string, string[]>()
  for (const { lemma, pos } of inflected) {
    const list = byLemma.get(lemma)
    if (list) list.push(pos)
    else byLemma.set(lemma, [pos])
  }
  return [...byLemma.entries()].map(([lemma, posKeys]) => ({ lemma, posKeys }))
}

/** 표제어 하나(활용형 매칭이면 해당 품사만)를 DictionaryEntry 로 변환한다. */
function buildEntry(lemma: string, posKeys: string[] | undefined, bundle: OewnBundle): DictionaryEntry<'en'> | null {
  const byPos = bundle.entries[lemma]
  if (!byPos) return null

  const keys = posKeys ?? Object.keys(byPos)
  const readings = keys
    .map((posKey) => {
      const info = byPos[posKey]
      return info ? posInfoToReading(posKey, info, bundle.synsets) : null
    })
    .filter((r): r is DictionaryReading<'en'> => r !== null)
  if (!readings.length) return null

  return {
    language: 'en',
    headword: [lemma],
    // OEWN 은 관용구/구(句) 표제어를 별도 태그 없이 lemma 자체에 공백을 넣어 등재한다
    // (실측: "kick the bucket" → entries 키가 그대로 "kick the bucket"). 다른 소스처럼
    // 명시적인 관용구 플래그 필드가 원본에 없어, 공백 포함 여부를 대리 지표로 쓴다.
    isIdiom: lemma.includes(' ') || undefined,
    readings,
    source: 'wordnet',
  }
}

export async function fetchOewnEntry(word: string): Promise<OewnLookupResult> {
  const bundle = await getBundle()
  const candidates = resolveLemmas(word, bundle)
  if (!candidates.length) return {}

  const entries = candidates
    .map(({ lemma, posKeys }) => buildEntry(lemma, posKeys, bundle))
    .filter((e): e is DictionaryEntry<'en'> => e !== null)
  if (!entries.length) return {}

  return { entries }
}
