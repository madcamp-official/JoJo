import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, SeeAlsoRef } from '@shared/types'

// 담당 B — 教育部重編國語辭典(萌典, moedict.tw 경유) 어댑터 (PLAN.md §6, zh-Hant 1순위)
// 실측 근거는 DICTIONARY_SOURCES.md "萌典 (zh-Hant)" 절 참고. 스크래핑이 아니라 공개 JSON
// API(`https://www.moedict.tw/uni/{표제어}`)를 쓴다 — 대만 교육부 편찬(번체 네이티브).
// 오케스트레이션(폴백 체인 호출·병합)은 이 어댑터의 스코프 밖 — 다른 세션이 담당한다.

const GUOYU_CIDIAN_ENDPOINT = 'https://www.moedict.tw/uni'

export class GuoyuCidianHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GuoyuCidianHttpError'
  }
}

// ---- 萌典 API 원본 응답 타입 (실측 기반, 2026-07-28) --------------------------------

interface GuoyuCidianDefinition {
  def?: string
  type?: string
  /** 현대 용례("如：「...」") — quote(고전 인용)와 별개 필드, 실측 확인. */
  example?: string[]
  /** 고전 문헌 인용 — 스키마에 반영하지 않기로 결정(DICTIONARY_SOURCES.md 참고), 파싱만 하고 버린다. */
  quote?: string[]
  /** 관련어 참조("也稱為「蜚蠊」") — 문자열 하나가 아니라 배열(실측 정정). */
  link?: string[]
}

interface GuoyuCidianHeteronym {
  bopomofo?: string
  /** 표준 한어병음만 채택 — bopomofo/bopomofo2 는 결정(2026-07-28)에 따라 쓰지 않는다. */
  pinyin?: string
  bopomofo2?: string
  definitions: GuoyuCidianDefinition[]
}

interface GuoyuCidianRaw {
  title: string
  heteronyms: GuoyuCidianHeteronym[]
  // radical/stroke_count/non_radical_stroke_count 는 결정(2026-07-28)에 따라 스키마에 안 담는다.
}

// ---- definitions[].type → CanonicalPos ---------------------------------------

/** 名/動/形/副/連/介/代/助/歎 만 실측 확인됨(DICTIONARY_SOURCES.md) — 그 외 값은 undefined. */
const POS_MAP: Record<string, CanonicalPos<'zh-Hant'>> = {
  名: 'noun',
  動: 'verb',
  形: 'adjective',
  副: 'adverb',
  連: 'conjunction',
  介: 'preposition',
  代: 'pronoun',
  助: 'particle',
  歎: 'interjection',
}

function mapPos(type: string | undefined): CanonicalPos<'zh-Hant'>[] | undefined {
  if (!type) return undefined
  const mapped = POS_MAP[type]
  return mapped ? [mapped] : undefined
}

// 萌典 example 필드는 "如：「...」。"처럼 예시임을 알리는 문구가 원문에 그대로 붙어있다
// (실측). UI가 예문을 이미 별도 블록(인용 스타일)으로 구분해 보여줘서(senseSelect.ts
// formatDictionaryAnswer) "如："는 군더더기라 잘라낸다.
function stripExampleMarker(example: string): string {
  return example.replace(/^如[：:]\s*/, '')
}

// ---- GuoyuCidianHeteronym[] → DictionaryReading[] -----------------------------

function toSeeAlso(link: string[] | undefined): SeeAlsoRef[] | undefined {
  if (!link?.length) return undefined
  return link.map((text) => ({ text, kind: 'related' as const }))
}

function heteronymToReading(heteronym: GuoyuCidianHeteronym): DictionaryReading<'zh-Hant'> | null {
  const senses = heteronym.definitions
    .map((def): DictionarySense<'zh-Hant'> | null => {
      if (!def.def) return null // gloss 는 필수 — 없으면 이 sense 는 버린다
      return {
        pos: mapPos(def.type),
        posRaw: def.type,
        gloss: [def.def],
        examples: def.example?.length ? def.example.map(stripExampleMarker) : undefined,
        seeAlso: toSeeAlso(def.link),
      }
    })
    .filter((s): s is DictionarySense<'zh-Hant'> => s !== null)

  if (!senses.length) return null

  return {
    pronunciations: heteronym.pinyin ? [{ value: heteronym.pinyin }] : undefined,
    senses,
  }
}

export interface GuoyuCidianLookupResult {
  entry?: DictionaryEntry<'zh-Hant'>
}

/** word 를 moedict.tw JSON API 로 조회한다. 표제어를 못 찾으면(HTTP 404) entry 없이
 *  빈 객체를 반환한다. */
export async function fetchGuoyuCidianEntry(word: string): Promise<GuoyuCidianLookupResult> {
  const url = `${GUOYU_CIDIAN_ENDPOINT}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'JoJo-dictionary-adapter/1.0' } })
  if (res.status === 404) return {}
  if (!res.ok) {
    throw new GuoyuCidianHttpError(res.status, `萌典 API 요청 실패: HTTP ${res.status}`)
  }

  let raw: GuoyuCidianRaw
  try {
    raw = await res.json()
  } catch {
    throw new GuoyuCidianHttpError(res.status, '萌典 응답을 파싱할 수 없습니다.')
  }

  const readings = (raw.heteronyms ?? []).map(heteronymToReading).filter((r): r is DictionaryReading<'zh-Hant'> => r !== null)
  if (!readings.length) return {}

  const entry: DictionaryEntry<'zh-Hant'> = {
    language: 'zh-Hant',
    headword: [raw.title ?? word],
    readings,
    source: 'guoyu-cidian',
  }

  return { entry }
}
