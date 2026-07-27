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
  // {bc}(definition-start colon)는 맨 앞 하나만 오는 게 아니라, 한 dt 안에 짧은 뜻
  // 여러 개를 이어붙일 때 그 사이 구분자로도 쓰인다(실측: "sunlight" → "{bc}the light
  // of the sun {bc}{sx|sunshine||}", MW 자체 shortdef 는 이걸 " : "로 렌더링함
  // — {bc} 를 그냥 지워버리면 "the light of the sun sunshine"처럼 단어가 붙어버린다).
  // 일단 전부 " : "로 바꾸고, 맨 앞에 남는 건(문두라 구분할 대상이 없음) 다음 trim 단계에서 제거한다.
  s = s.replace(/\{bc\}/g, ' : ')
  s = s.replace(/\{ldquo\}/g, '“').replace(/\{rdquo\}/g, '”')
  // 파이프 구분 교차참조 토큰: 첫 필드(표시 텍스트)만 남기고 나머지(링크 대상 등) 버림
  s = s.replace(/\{(?:sx|dxt|a_link|d_link|i_link|et_link|mat)\|([^|}]*)(?:\|[^}]*)?\}/g, '$1')
  // 위에서 못 거른 나머지 토큰은 전부 제거(알 수 없는 태그가 평문에 새는 것을 방지)
  s = s.replace(/\{[^}]*\}/g, '')
  // {bc}→" : " 치환으로 문두에 남는 ": "(구분할 대상이 없는 첫 {bc})는 제거한다.
  return s.replace(/\s+/g, ' ').trim().replace(/^:\s*/, '')
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
  // uros[].ure 실측 확인(2026-07-28, "photosynthesizing" 실API 호출): 음절 경계가
  // '·'(중점)가 아니라 headword/ins[].if 와 동일하게 '*'였다 — 문서에 남아있던 '·' 가정은
  // 오기였고, 이 함수가 '·'만 지워 실제 데이터에선 매칭이 전혀 안 되고 있었다.
  return s.replace(/[·*]/g, '').toLowerCase()
}

/** MW 는 조회어 자체와 무관한 entry 까지 응답에 같이 섞어 보낸다 — 실측 확인(2026-07-28,
 *  "catching" 조회): 정작 관련 있는 entry(`catching`/`catch:1`) 외에도 `catching` 이
 *  구성 성분으로 들어간 관용구(`catch fire`/`catch it`/`catch one's breath`/`(one's)
 *  age is catching up to one`)와, 심지어 **완전히 다른 단어("break:2", stems 에
 *  "catching a break"가 있다는 이유만으로)** 까지 같이 온다. 이걸 다 entry.fl==='phrase'
 *  일 때만 걸러내면 관용구는 잡아도 "break" 같은 완전 무관 단어는 못 거른다. 실제로
 *  구분이 되는 축은 `meta.stems` — 진짜 연관 entry 는 조회어가 **다른 단어와 결합되지
 *  않은 단독 형태**로 stems 에 그대로 들어있고(`catch:1` stems 에 'catching' 단독 원소
 *  있음), 무관한 entry 는 조회어가 항상 다른 단어와 묶인 여러 단어짜리 문자열로만
 *  등장한다(`catching a break`처럼). 그래서 "조회어가 stems 안에 단독 원소로 있는가"로
 *  거른다 — 조회어 자체가 여러 단어 관용구(예: "kick the bucket")인 경우는 그 표현 자체가
 *  stems 에 단독으로 들어있어 정상적으로 살아남는다. */
function isRelevantEntry(entry: MwEntry, word: string): boolean {
  const target = word.toLowerCase()
  if (entry.meta.stems?.some((s) => s.toLowerCase() === target)) return true
  return entry.hwi.hw.replace(/[·*]/g, '').toLowerCase() === target
}

/** uros(파생어) 처리 — 조회한 표면형이 파생 접사가 붙은 형태면 최상위 응답이 항상 원
 *  표제어로 돌아온다(DICTIONARY_SOURCES.md 실측). uros[] 에서 조회 표면형과 일치하는
 *  항목을 찾아 그 fl/발음으로 보정한다(뜻풀이는 uros 에 없어 원 표제어 def 를 그대로 씀). */
function findMatchingUro(entry: MwEntry, queryWord: string): MwUro | undefined {
  const target = normalizeForMatch(queryWord)
  return entry.uros?.find((u) => normalizeForMatch(u.ure) === target)
}

// ---- MwEntry → DictionaryReading -------------------------------------------

function entryToReading(
  entry: MwEntry,
  queryWord: string,
  fallbackPronunciations: DictionaryReading['pronunciations'],
): DictionaryReading | null {
  const uro = findMatchingUro(entry, queryWord)
  const fl = uro?.fl ?? entry.fl
  const pos = flToPos(fl)
  // ins[].if 도 headword 와 같은 '·'(중점) 음절 경계 표기를 씀(실측: "banked, bank·ing, banks").
  const irregularForms = (entry.ins ?? [])
    .map((i) => i.if?.replace(/[·*]/g, ''))
    .filter((v): v is string => !!v)

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
  const ownPronunciations = prs
    ?.map((p) => p.mw)
    .filter((v): v is string => !!v)
    .map((value) => ({ value }))
  // MW 는 같은 hw 를 공유하는 후속 entry(예: bank 명사 다음의 bank 동사)에서 발음이
  // 이전과 같으면 hwi.prs 자체를 생략하는 경우가 실측 확인됨 — 이 경우 직전 entry의
  // 발음을 그대로 물려받는다(완전히 새 단어라 prs 가 없는 경우는 fallback 도 없어 undefined).
  const pronunciations = ownPronunciations?.length ? ownPronunciations : fallbackPronunciations

  return {
    pronunciations,
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
  let lastPronunciations: DictionaryReading['pronunciations']

  for (const entry of entries) {
    if (!isRelevantEntry(entry, word)) continue // 조회어와 무관한 entry(관용구 구성 성분 등) 제외

    headwordSet.add(entry.hwi.hw.replace(/[·*]/g, '')) // MW hw 는 음절 경계를 '·'/'*'로 표시
    if (entry.fl === 'phrase') isIdiom = true

    if (entry.cxs) {
      const sense = cxsToSense(entry)
      if (sense) {
        readings.push({ senses: [sense] })
        continue
      }
    }

    const reading = entryToReading(entry, word, lastPronunciations)
    if (reading) {
      readings.push(reading)
      if (reading.pronunciations?.length) lastPronunciations = reading.pronunciations
    }
  }

  if (!readings.length) return {}

  // 실측 확인(2026-07-28, "banked"/"bank" 직접 호출): MW 는 같은 headword 의 hom 중
  // **가장 먼저 오는 hom(대개 hom=1)에만 hwi.prs 를 채우고 나머지 hom 은 전부 생략**한다
  // — 활용형(예: "banked")으로 직접 조회하면 그 활용형에 대응하는 hom(예: hom=2/4 동사)만
  // 응답에 오는데, 정작 발음을 가진 hom=1은 이 응답에 아예 없어서 위 entry 간 상속으로도
  // 못 채운다. 이 경우에만 원래 headword로 한 번 더 조회해 발음을 가져와 채운다(비용은
  // 발음이 진짜 하나도 없을 때만 발생 — 대부분의 직접 조회는 이 분기를 안 탄다).
  if (!lastPronunciations && headwordSet.size) {
    const baseHeadword = [...headwordSet][0]
    if (baseHeadword.toLowerCase() !== word.toLowerCase()) {
      const basePronunciations = await fetchHeadwordPronunciation(baseHeadword, apiKey)
      if (basePronunciations) {
        for (const r of readings) if (!r.pronunciations?.length) r.pronunciations = basePronunciations
      }
    }
  }

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

/** 위 hom 발음 생략 문제의 폴백 — headword 자체를 다시 조회해 hwi.prs 가 있는 첫
 *  entry의 발음을 가져온다. 실패해도(네트워크 오류 등) 조용히 undefined 반환 —
 *  발음은 부가 정보라 이것 때문에 전체 조회를 실패시키지 않는다. */
async function fetchHeadwordPronunciation(
  headword: string,
  apiKey: string,
): Promise<DictionaryReading['pronunciations']> {
  try {
    const res = await fetch(`${MW_ENDPOINT}/${encodeURIComponent(headword)}?key=${apiKey}`)
    if (!res.ok) return undefined
    const raw = (await res.json()) as MwRaw[]
    for (const entry of raw) {
      if (typeof entry === 'string') continue
      const values = entry.hwi.prs?.map((p) => p.mw).filter((v): v is string => !!v)
      if (values?.length) return values.map((value) => ({ value }))
    }
  } catch {
    /* 발음 폴백 실패는 무시 — 나머지 사전 정보는 이미 확보돼 있음 */
  }
  return undefined
}
