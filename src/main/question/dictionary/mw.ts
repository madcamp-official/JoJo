import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense } from '@shared/types'

// 담당 B — Merriam-Webster Collegiate Dictionary API 어댑터 (PLAN.md §5 en-1)
// 실측 근거는 DICTIONARY_SOURCES.md "Merriam-Webster (MW)" 절 참고.
// 원본 JSON(sseq/dt/vis 중첩 구조, {bc}/{it}/{sx|..} 같은 마크업 토큰)을 파싱해
// 통일 스키마(DictionaryEntry)로 변환한다.

const MW_ENDPOINT = 'https://www.dictionaryapi.com/api/v3/references/collegiate/json'

// ---- MW 원본 응답 타입 (느슨하게 — 공식 스키마 문서가 없어 실측 기반) ----------------

interface MwPr {
  mw?: string
}

interface MwHwi {
  hw: string
  prs?: MwPr[]
}

interface MwVis {
  t: string
}

/** dt(defining text)는 [key, value] 튜플의 배열. key 는 'text'/'vis'/'uns'/'ca' 등. */
type MwDtItem = ['text', string] | ['vis', MwVis[]] | ['uns', MwDtItem[][]] | [string, unknown]

interface MwSense {
  dt: MwDtItem[]
  sls?: string[]
}

/** sseq 트리는 'sense'/'pseq'/'bs' 등 태그로 임의 깊이까지 중첩된다 — 실사용 케이스는
 *  대부분 'sense' leaf 만 있으면 충분해, 아래 collectSenseNodes 가 트리 모양을 가리지
 *  않고 재귀적으로 'sense' leaf 를 전부 찾아 평탄화한다. */
type MwSseqNode = unknown

interface MwDef {
  sseq: MwSseqNode[][]
}

interface MwCxs {
  cxl: string
  cxtis?: { cxt: string }[]
}

interface MwUro {
  ure: string
  fl?: string
  prs?: MwPr[]
}

interface MwEntry {
  meta: { id: string; stems?: string[] }
  hwi: MwHwi
  fl?: string
  ins?: { if?: string }[]
  def?: MwDef[]
  cxs?: MwCxs[]
  uros?: MwUro[]
  /** 실측 확인(2026-07-28, "deco" → `["often attributive"]`) — 전문분야 라벨이 아니라
   *  sls 와 같은 성격의 일반 표기 관례 라벨. entry 최상위 필드라 sense 레벨인
   *  usageTags 와 위치가 다르므로, 아래에서 그 entry의 모든 sense 에 복제해 합친다. */
  lbs?: string[]
}

/** 표제어를 못 찾으면 MW 는 유사 단어 제안 문자열 배열을 반환한다(엔트리 객체가 아님). */
type MwRaw = MwEntry | string

// ---- fl(functional label) → CanonicalPos --------------------------------------

const FL_TO_POS: Record<string, CanonicalPos> = {
  noun: 'noun',
  pronoun: 'pronoun',
  verb: 'verb',
  'transitive verb': 'verb',
  'intransitive verb': 'verb',
  adjective: 'adjective',
  adverb: 'adverb',
  preposition: 'preposition',
  conjunction: 'conjunction',
  interjection: 'interjection',
  article: 'article',
}

function flToPos(fl?: string): CanonicalPos | undefined {
  if (!fl) return undefined
  return FL_TO_POS[fl]
}

// ---- MW 마크업 토큰({bc}/{it}.../{sx|word||} 등) 제거 ---------------------------

/** MW dt 텍스트 안의 토큰 마크업을 사람이 읽는 평문으로 정리한다. 알려진 토큰만
 *  선별 처리하고, 나머지(태그 목록이 공개돼 있지 않아 전부 알 수 없음)는 통째로
 *  제거해 깨진 토큰이 그대로 gloss/example 에 노출되는 일을 막는다. */
function stripMwTokens(raw: string): string {
  let s = raw
  // 내용은 유지하고 태그만 제거하는 페어 토큰(이탤릭/볼드/위첨자 등)
  s = s.replace(/\{\/?(?:it|b|sup|inf|phrase|wi|dx|dx_def|dx_ety|ma|parahw)\}/g, '')
  // {bc} = definition-start colon, 문장부호가 아니라 구분자라 공백으로만 치환
  s = s.replace(/\{bc\}/g, '')
  s = s.replace(/\{ldquo\}/g, '“').replace(/\{rdquo\}/g, '”')
  // 파이프 구분 교차참조 토큰: 첫 필드(표시 텍스트)만 남기고 나머지(링크 대상 등) 버림
  s = s.replace(/\{(?:sx|dxt|a_link|d_link|i_link|et_link|mat)\|([^|}]*)(?:\|[^}]*)?\}/g, '$1')
  // 위에서 못 거른 나머지 토큰은 전부 제거(알 수 없는 태그가 평문에 새는 것을 방지)
  s = s.replace(/\{[^}]*\}/g, '')
  return s.trim().replace(/\s+/g, ' ')
}

// ---- sseq 평탄화 -----------------------------------------------------------

/** sseq 트리(임의 깊이로 중첩된 'sense'/'pseq' 등 태그) 안에서 ['sense', MwSense] 형태의
 *  leaf 를 전부 찾아 순서대로 평탄화한다. 'pseq'(구 표제어 하위 구분)처럼 태그+배열 형태는
 *  재귀로 자연스럽게 뚫고 들어가지만, 'bs'(binding substitute, `["bs", {"sense": {...}}]`
 *  처럼 sense 가 튜플이 아니라 객체 프로퍼티로 한 겹 더 감싸인 형태)는 이 재귀가 못 찾아
 *  건너뛴다 — 실사용 빈도가 낮아 우선 스코프에서 제외(TODO: 실측되면 별도 분기 추가). */
function collectSenseNodes(node: unknown, out: MwSense[]): void {
  if (!Array.isArray(node)) return
  if (node.length === 2 && node[0] === 'sense' && typeof node[1] === 'object') {
    out.push(node[1] as MwSense)
    return
  }
  for (const child of node) collectSenseNodes(child, out)
}

function extractDt(dt: MwDtItem[] | undefined): { gloss: string[]; examples: string[]; usageNote?: string } {
  const gloss: string[] = []
  const examples: string[] = []
  const usageNotes: string[] = []
  for (const item of dt ?? []) {
    const [key, value] = item
    if (key === 'text' && typeof value === 'string') {
      const text = stripMwTokens(value)
      if (text) gloss.push(text)
    } else if (key === 'vis' && Array.isArray(value)) {
      for (const v of value as MwVis[]) {
        const text = stripMwTokens(v.t)
        if (text) examples.push(text)
      }
    } else if (key === 'uns' && Array.isArray(value)) {
      // uns(usage note) 값은 dt 형태의 블록 배열 — 재귀적으로 텍스트만 뽑아 합친다.
      for (const block of value as MwDtItem[][]) {
        const inner = extractDt(block)
        usageNotes.push(...inner.gloss)
      }
    }
  }
  return { gloss, examples, usageNote: usageNotes.length ? usageNotes.join(' ') : undefined }
}

/** sense 레벨 sls 와 entry 최상위 lbs(둘 다 표기 관례/격식 라벨, DICTIONARY_SOURCES.md
 *  실측 확인)를 하나의 usageTags 로 합친다. lbs 는 entry 전체에 적용되는 라벨이라
 *  그 entry의 모든 sense 에 동일하게 복제된다. */
function mergeUsageTags(sls: string[] | undefined, lbs: string[] | undefined): string[] | undefined {
  const merged = [...(lbs ?? []), ...(sls ?? [])]
  return merged.length ? merged : undefined
}

function normalizeForMatch(s: string): string {
  return s.replace(/[·]/g, '').toLowerCase()
}

/** uros(파생어) 처리 — 조회한 표면형이 파생 접사가 붙은 형태면 최상위 응답이 항상 원
 *  표제어로 돌아온다(DICTIONARY_SOURCES.md 실측). uros[] 에서 조회 표면형과 일치하는
 *  항목을 찾아 그 fl/발음으로 보정한다(뜻풀이는 uros 에 없어 원 표제어 def 를 그대로 씀). */
function findMatchingUro(entry: MwEntry, queryWord: string): MwUro | undefined {
  const target = normalizeForMatch(queryWord)
  return entry.uros?.find((u) => normalizeForMatch(u.ure) === target)
}

// ---- MwEntry → DictionaryReading -------------------------------------------

function entryToReading(entry: MwEntry, queryWord: string): DictionaryReading | null {
  const uro = findMatchingUro(entry, queryWord)
  const fl = uro?.fl ?? entry.fl
  const pos = flToPos(fl)
  const irregularForms = (entry.ins ?? []).map((i) => i.if).filter((v): v is string => !!v)

  const senseNodes: MwSense[] = []
  for (const def of entry.def ?? []) collectSenseNodes(def.sseq, senseNodes)

  const senses: DictionarySense[] = senseNodes
    .map((node): DictionarySense | null => {
      const { gloss, examples, usageNote } = extractDt(node.dt)
      if (!gloss.length) return null // MW gloss 는 필수 필드 — 못 뽑으면 이 sense 는 버린다
      return {
        pos,
        posRaw: fl,
        irregularForms: irregularForms.length ? irregularForms : undefined,
        gloss,
        examples: examples.length ? examples : undefined,
        usageTags: mergeUsageTags(node.sls, entry.lbs),
        usageNote,
      }
    })
    .filter((s): s is DictionarySense => s !== null)

  if (!senses.length) return null

  const prs = uro?.prs ?? entry.hwi.prs
  const pronunciations = prs
    ?.map((p) => p.mw)
    .filter((v): v is string => !!v)
    .map((value) => ({ value }))

  return {
    pronunciations: pronunciations?.length ? pronunciations : undefined,
    senses,
  }
}

// ---- cxs(cross-reference 전용 엔트리) 처리 -----------------------------------
// 실측: "colour" 조회 시 def/shortdef 가 전부 비어있고 cxs 만 옴. cxl+cxt 를 합성해
// gloss 로 대체한다(재조회 없음 — DICTIONARY_SOURCES.md 옵션 (1)).

function cxsToSense(entry: MwEntry): DictionarySense | null {
  const cxs = entry.cxs?.[0]
  if (!cxs) return null
  const targets = cxs.cxtis?.map((t) => t.cxt).join(', ')
  if (!targets) return null
  return {
    pos: flToPos(entry.fl),
    posRaw: entry.fl,
    gloss: [`${cxs.cxl} ${targets}`],
  }
}

// ---- 진입점 -----------------------------------------------------------------

export interface MwLookupResult {
  /** MW 가 정확한 표제어를 못 찾고 유사 단어만 제안한 경우 */
  suggestions?: string[]
  entries?: DictionaryEntry[]
}

export async function fetchMwEntry(word: string, apiKey: string): Promise<MwLookupResult> {
  const url = `${MW_ENDPOINT}/${encodeURIComponent(word)}?key=${apiKey}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`MW API 요청 실패: HTTP ${res.status}`)
  }
  const raw = (await res.json()) as MwRaw[]
  if (raw.length === 0) return {}
  if (typeof raw[0] === 'string') return { suggestions: raw as string[] }

  const entries = raw.filter((r): r is MwEntry => typeof r !== 'string')
  const readings: DictionaryReading[] = []
  let isIdiom = false
  const headwordSet = new Set<string>()

  for (const entry of entries) {
    headwordSet.add(entry.hwi.hw.replace(/[·*]/g, '')) // MW hw 는 음절 경계를 '·'(중점)로 표시(uros.ure 와 동일 표기 체계)
    if (entry.fl === 'phrase') isIdiom = true

    if (entry.cxs) {
      const sense = cxsToSense(entry)
      if (sense) {
        readings.push({ senses: [sense] })
        continue
      }
    }

    const reading = entryToReading(entry, word)
    if (reading) readings.push(reading)
  }

  if (!readings.length) return {}

  return {
    entries: [
      {
        headword: headwordSet.size ? [...headwordSet] : [word],
        isIdiom: isIdiom || undefined,
        readings,
        source: 'merriam-webster',
      },
    ],
  }
}
