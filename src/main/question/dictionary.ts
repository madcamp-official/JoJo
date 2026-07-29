import type {
  DictionaryEntry,
  DictionarySourceId,
  Language,
  QuestionResult,
  SelectionContext,
} from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { tokenizeJapanese } from '@main/nlp/japanese'
import { getSettings } from '@main/settingsStore'
import { DEFAULT_MODELS } from '@shared/providers'
import { getLanguageName, isFullLanguage } from '@shared/languages'
import { fetchCcCedictEntry } from './dictionary/cccedict'
import { fetchDaijisenEntry, DaijisenHttpError } from './dictionary/daijisen'
import { fetchHanyuEntry, HanyuHttpError } from './dictionary/hanyu'
import { fetchJmdictEntry } from './dictionary/jmdict'
import { fetchGuoyuCidianEntry, GuoyuCidianHttpError } from './dictionary/guoyuCidian'
import { fetchMerriamWebsterEntry, MerriamWebsterHttpError } from './dictionary/merriamWebster'
import { fetchOewnEntry } from './dictionary/oewn'
import { fetchWiktionaryEntry, WiktionaryHttpError } from './dictionary/wiktionary'
import {
  buildSenseListText,
  formatDictionaryAnswer,
  numberSenses,
  parseJudgeReply,
} from './dictionary/senseSelect'
import { buildContextBlock, createClient, getActiveProvider } from './llm/adapter'
import { classifyLlmError } from './llm/errors'
import { renderPrompt } from './prompts/template'
import dictionaryPromptTemplate from './prompts/dictionary.txt?raw'
import { buildErrorResult } from './errors'

// 담당 B — 사전 검색 (PLAN.md §5.2-2)
// 언어별 정식 폴백 체인(FALLBACK_CHAINS, 아래)으로 원어 뜻(sense) 후보를 모으고, LLM 에
// "문맥상 몇 번인지" 판정과 그 뜻풀이·예문의 한국어 번역을 함께 맡긴다(PLAN.md §6:
// 사전 API는 원어 뜻만 제공, 한국어 설명·번역은 LLM 담당). 채팅창에 보일 최종 텍스트는
// 그 번역 결과와 사전 원본 데이터(품사·출처·활용형 등)를 조합해 여기서 직접 구성한다.
//
// 다중 단어 선택 폴백(TODO.md 참고, en 전용 — 공백으로 단어가 갈리는 언어만 의미가 있음):
// 선택 텍스트 전체를 표제어로 먼저 조회하고("kick the bucket" 같은 관용구는 통째로
// 사전에 있을 수 있음), 못 찾으면 단어 단위로 쪼개 각각 독립적으로 같은 폴백 체인
// (lookupThroughFallbackChain)을 병렬 호출한다. 단어별 뜻은 서로 무관해 하나의
// 프롬프트/판정으로 억지로 합칠 필요가 없어 이 구조를 택함 — 단, 체인 호출이 단어
// 수만큼 늘어나므로 MAX_FALLBACK_WORDS 로 상한을 둔다.

const DICTIONARY_JUDGE_TEMPERATURE = 0.2
const DICTIONARY_JUDGE_MAX_TOKENS = 500
/** 폴백 시 개별 조회할 단어 수 상한 — MW 무료 티어(일 1,000회)와 LLM 호출 비용 보호용.
 *  이보다 길게 드래그하면 폴백 없이 "찾지 못했습니다"로 처리한다. */
const MAX_FALLBACK_WORDS = 5

/** 정식 폴백 순서(TODO.md/DICTIONARY_SOURCES.md 에 확정된 순서 그대로) — 앞 소스가
 *  못 찾거나 실패하면 조용히 다음으로 넘어간다. */
const FALLBACK_CHAINS: Record<Language, DictionarySourceId[]> = {
  en: ['merriam-webster', 'wordnet', 'wiktionary'],
  ja: ['daijisen', 'jmdict', 'wiktionary'],
  'zh-Hans': ['hanyu-dict', 'cc-cedict', 'wiktionary'],
  'zh-Hant': ['guoyu-cidian', 'hanyu-dict', 'cc-cedict', 'wiktionary'],
}

/** 이 파일 전체는 tier1(LLM 사전 지원 언어) 전용이다 — tier2/3는 팝업 UI가 애초에 "사전"
 *  버튼 자체를 안 보여주므로(Toolbar.tsx) 정상 경로로는 여기 안 들어오지만, 방어적으로
 *  lookupDictionary 진입 시 한 번 좁혀서 그 아래 모든 헬퍼가 Language(4개)만 다루도록
 *  한다 — SelectionContext.language 가 tier2까지 포함하는 AnyLanguage 로 넓어졌기
 *  때문에(2026-07-30) 필요해진 타입. */
type DictSelectionContext = Omit<SelectionContext, 'language'> & { language: Language }

export async function lookupDictionary(
  rawCtx: SelectionContext,
  forceSource: DictionarySourceId | undefined,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  // tier2/3(AnyLanguage 중 Language 4개가 아닌 나머지)는 여기서 한 번만 걸러낸다 — 이
  // 아래로는 전부 DictSelectionContext(language: Language 로 좁혀짐)만 다닌다.
  if (!isFullLanguage(rawCtx.language)) {
    return emit(onChunk, { kind: 'dictionary', content: '이 언어는 아직 사전 검색을 지원하지 않습니다.' })
  }
  const ctx: DictSelectionContext = { ...rawCtx, language: rawCtx.language }

  // ============================================================================
  // 임시 디버깅 강제 소스 선택 — 제거 예정(팝업 드롭다운+토글, registry.ts 와 한 세트).
  // 사용자가 팝업의 "폴백/직접 선택" 토글을 "직접 선택"으로 켰을 때만 forceSource 가
  // 채워져 들어온다(기본값은 토글 꺼짐=폴백, PopupScreen.tsx 참고) — 이 경로는 정식
  // 폴백 체인을 완전히 건너뛰고 고른 소스 하나만 호출한다. 이 기능 자체를 나중에
  // 걷어낼 때는 이 if 블록 + forceSource 매개변수 + registry.ts + 팝업 토글/드롭다운
  // (Toolbar.tsx/PopupScreen.tsx)만 지우면 되고, 아래 폴백 체인 로직은 전혀 안
  // 건드려도 된다.
  if (forceSource) {
    return emit(onChunk, await lookupForcedSource(forceSource, ctx))
  }
  // ============================================================================

  const chain = FALLBACK_CHAINS[ctx.language]
  if (!chain.length) {
    return emit(onChunk, { kind: 'dictionary', content: '이 언어는 아직 사전 검색을 지원하지 않습니다.' })
  }

  const word = ctx.selectedText.trim()
  if (!word) {
    return emit(onChunk, { kind: 'dictionary', content: '선택된 표현이 없습니다.' })
  }

  const provider = getActiveProvider()
  if (!provider) {
    return emit(onChunk, buildErrorResult('dictionary', 'no_active_provider'))
  }
  const llmKey = getApiKey(provider)
  if (!llmKey) {
    return emit(onChunk, buildErrorResult('dictionary', 'no_api_key', provider))
  }

  const settings = getSettings()
  const client = createClient(provider, { apiKey: llmKey })
  const model = settings.models[provider] || DEFAULT_MODELS[provider]
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const whole = await lookupThroughFallbackChain(word, ctx)
  const lookupWord = whole.matchedWord ?? word
  if (whole.senses.length && whole.sourceId) {
    const outcome = await judgeAndFormat({
      word: lookupWord,
      source: whole.sourceId,
      senses: whole.senses,
      ctx,
      client,
      model,
      cacheableContext,
    })
    if (outcome.ok) {
      return emit(onChunk, {
        kind: 'dictionary',
        content: withDebugCountsLine(outcome.formatted, whole.entries, whole.senses.length, outcome.selected), // TEMP DEBUG
        meta: { provider, source: whole.sourceId },
      })
    }
    return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(outcome.error), provider))
  }

  // 통째 조회가 체인 끝까지 실패 — 공백으로 단어가 갈리는 en 만 단어 단위로 쪼개
  // 각각 같은 체인을 재시도한다(ja/zh 는 popup 이 이미 원자 단위로 정확히 선택돼 있어
  // 이런 재분할이 의미가 없다).
  if (ctx.language !== 'en') {
    return emit(onChunk, notFoundResult(word, whole.suggestions))
  }
  const words = splitIntoWords(word)
  if (words.length <= 1) {
    return emit(onChunk, notFoundResult(word, whole.suggestions))
  }
  if (words.length > MAX_FALLBACK_WORDS) {
    // 긴 속담/관용구는 사용자가 실제로 드래그한 표면형(대명사·부속어 포함)으로는 통째
    // 조회가 거의 항상 실패하지만(실측: "don't count your chickens before they hatch" 등),
    // MW 가 정규화된 표제어를 suggestions 로 이미 알려주는 경우가 많아(실측: "count one's
    // chickens (before they hatch)") 단어별 폴백보다 이게 더 쓸모 있다 — 버리지 않고 보여준다.
    const suggestion = whole.suggestions?.length
      ? ` (제안: ${whole.suggestions.slice(0, 5).join(', ')})`
      : ''
    return emit(onChunk, {
      kind: 'dictionary',
      content: `선택 범위가 너무 넓어 사전 검색을 건너뜁니다(단어 ${words.length}개, 최대 ${MAX_FALLBACK_WORDS}개).${suggestion}`,
    })
  }

  const perWordResults = await Promise.allSettled(
    words.map((w) => lookupSingleWordThroughChain(w, ctx, client, model, cacheableContext)),
  )
  const outcomes = perWordResults.map((r) => (r.status === 'fulfilled' ? r.value : null))

  const formattedBlocks = outcomes
    .filter((o): o is { formatted: string } => o !== null && 'formatted' in o)
    .map((o) => o.formatted)

  if (!formattedBlocks.length) {
    // 단어 전부가 사전에 없는 것과, LLM 호출 자체가 전부 실패한 것(잘못된 모델 등)은
    // 원인이 다르다 — 후자를 "사전에서 못 찾음"으로 뭉개면 사용자가 엉뚱한 곳을
    // 의심하게 되므로, 있었으면 그걸 그대로 보여준다(개별 소스 조회 실패는 체인 내부에서
    // 이미 다음 소스로 흡수되므로 여기까지 올라오지 않는다 — lookupThroughFallbackChain 참고).
    const llmError = outcomes.find((o): o is { llmError: unknown } => o !== null && 'llmError' in o)
    if (llmError) {
      return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(llmError.llmError), provider))
    }
    return emit(onChunk, notFoundResult(word, whole.suggestions))
  }

  return emit(onChunk, {
    kind: 'dictionary',
    content: formattedBlocks.join('\n\n---\n\n'),
    meta: { provider },
  })
}

// ---- 폴백 체인 실행 -----------------------------------------------------------

interface ChainLookupResult {
  senses: ReturnType<typeof numberSenses>
  sourceId?: DictionarySourceId
  suggestions?: string[]
  /** 실제로 결과를 준 표면형 — ja 는 원래 조회어와 다를 수 있다(활용형→기본형 재시도,
   *  아래 lookupThroughFallbackChain 참고). undefined 면 원래 조회어 그대로 성공한 것. */
  matchedWord?: string
  /** TEMP DEBUG(맨 윗줄 entry/reading/sense 개수 표시용) — 제거 시 이 필드도 같이 삭제. */
  entries?: DictionaryEntry<Language>[]
}

/** ja 전용 — 조회 후보 목록(표면형 + 있으면 활용형 기본형)을 만든다. daijisen·JMdict가
 *  전부 활용형을 원형으로 자동 변환해주지 않아서(TODO.md 131번 항목), 표면형만으로는
 *  둘 다 "못 찾음"으로 끝나 버리는데, 이 상태로 다음 소스(Wiktionary)까지 넘어가면
 *  안 된다 — Wiktionary는 활용형 자체에도 "conjunctive form of 歩く" 같은 한 줄짜리
 *  굴절 안내 페이지를 갖고 있어(실측: 歩いて/食べた) daijisen/JMdict가 원형으로는
 *  풍부하게 줄 수 있는 뜻풀이 대신 이 얇은 한 줄로 조용히 만족해버리기 때문. 그래서
 *  daijisen/JMdict **각각**이 표면형에 이어 기본형까지 시도해보고, 그래도 둘 다 못
 *  찾을 때만 Wiktionary로 넘어가게 후보를 소스보다 안쪽 루프에 둔다(아래
 *  lookupThroughFallbackChain 참고). 표면형을 항상 먼저 두는 이유는 "犬も歩けば棒に
 *  当たる" 같은 관용구는 활용형 변환 없이 표면형 그대로가 정답이라, 기본형을 먼저
 *  시도하면 이런 경우를 깨뜨리기 때문. */
async function japaneseWordCandidates(word: string): Promise<string[]> {
  const baseForm = await toJapaneseDictionaryBaseForm(word).catch(() => null)
  return baseForm && baseForm !== word ? [word, baseForm] : [word]
}

/** en 전용 — 규칙동사/규칙명사 활용형의 원형 후보를 추측한다(WordNet Morphy 알고리즘의
 *  detachment rule 일부를 재구현, 별도 라이브러리 없이 접미사 규칙만). MW는 자체
 *  교차참조(uros/stems)로, OEWN은 formIndex(비정규 활용형 위주)로 각자 활용형을 어느
 *  정도 처리하지만, **OEWN의 formIndex는 정규 활용(-ed/-ing/-s)을 거의 안 담고 있어서**
 *  (실측: "close"/"want"/"walk"/"look" 전부 `form: null`) "walked"/"looked" 같은 흔한
 *  규칙동사 과거형은 OEWN 단독으로 못 찾는다(2026-07-28 확인) — MW 키가 없으면 이
 *  간극이 그대로 Wiktionary의 얇은 굴절 안내 한 줄("simple past and past participle of
 *  walk")로 이어진다. 정확한 철자 규칙 판별(사전 대조) 없이 후보를 여러 개 만들어
 *  전부 시도하는 방식이라(예: "closed" → "clos"/"close"/"clos" 자음축약 등) 틀린
 *  후보는 각 소스에서 조용히 "못 찾음"으로 끝나 무해하다. */
function guessEnglishBaseForms(word: string): string[] {
  const lower = word.toLowerCase()
  if (lower === word && lower.length < 4) return []
  if (word.includes("'")) return [] // 축약형("they're" 등)은 stripContraction이 따로 처리
  const candidates = new Set<string>()

  const maybeUndoubleAndAdd = (stem: string) => {
    candidates.add(stem)
    candidates.add(`${stem}e`)
    const last = stem.at(-1)
    const secondLast = stem.at(-2)
    if (last && last === secondLast && !'aeiou'.includes(last)) candidates.add(stem.slice(0, -1))
  }

  if (lower.endsWith('ied') && lower.length > 4) candidates.add(`${lower.slice(0, -3)}y`)
  else if (lower.endsWith('ed') && lower.length > 3) maybeUndoubleAndAdd(lower.slice(0, -2))

  if (lower.endsWith('ing') && lower.length > 4) maybeUndoubleAndAdd(lower.slice(0, -3))

  if (lower.endsWith('ies') && lower.length > 4) candidates.add(`${lower.slice(0, -3)}y`)
  else if (lower.endsWith('es') && lower.length > 3) candidates.add(lower.slice(0, -2))
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) candidates.add(lower.slice(0, -1))

  candidates.delete(word)
  candidates.delete(lower)
  return [...candidates]
}

/** en 축약형("they're"/"isn't" 등)의 원래 단어 후보를 뽑는다 — 실사용 중 발견(2026-07-29):
 *  "they're"를 MW로 조회하면 `posRaw: "contraction", gloss: ["they are"]` 한 줄짜리
 *  얇은 답만 나오는데(문법적 설명일 뿐, 대명사 "they" 자체의 뜻풀이가 아님), 정작
 *  유용한 답은 "they"(대명사, "누구를 가리키는지" 등 실제 뜻풀이 여러 개)에 있다.
 *  "n't"(isn't/don't/won't 등)는 어미를 통째로 떼야 하고("aren't"→"are", 어간+"n't"
 *  분리가 아님), "won't"/"can't"는 규칙과 다른 불규칙 축약이라 따로 처리한다. 나머지
 *  ('re/'ve/'ll/'d/'m/'s)는 어퍼스트로피 앞부분을 그대로 쓰면 된다. */
function stripContraction(word: string): string | null {
  const lower = word.toLowerCase()
  if (lower === "won't") return 'will'
  if (lower === "can't") return 'can'
  if (lower.endsWith("n't") && lower.length > 3) return word.slice(0, -3)
  for (const suffix of ["'re", "'ve", "'ll", "'d", "'m", "'s"]) {
    if (lower.endsWith(suffix)) return word.slice(0, -suffix.length)
  }
  return null
}

function englishWordCandidates(word: string): string[] {
  const candidates = [word, ...guessEnglishBaseForms(word)]
  const contractionBase = stripContraction(word)
  if (contractionBase && !candidates.includes(contractionBase)) candidates.push(contractionBase)
  return candidates
}

/** FALLBACK_CHAINS 를 앞에서부터 순서대로 시도해 sense 가 하나라도 있는 첫 소스에서
 *  멈춘다("앞 소스가 못 찾을 때만 다음으로" — TODO.md/DICTIONARY_SOURCES.md 확정 순서).
 *  개별 소스 실패(네트워크 에러 등)도 "여기선 못 찾음"과 동일하게 다음 소스로 넘어간다 —
 *  폴백 체인은 중간 실패를 사용자에게 구구절절 보여주기보다 끝까지 시도해보고 그래도
 *  안 되면 그때 "찾지 못함"으로 뭉뚱그린다(개별 에러는 진단용으로 console.warn 만 남김).
 *  ja/en 은 소스 하나당 여러 후보 표면형(japaneseWordCandidates/englishWordCandidates)을
 *  안쪽에서 전부 시도한 뒤에야 다음 소스로 넘어간다 — "daijisen/JMdict/OEWN이 활용형
 *  이라 못 찾은 것"과 "이 단어 자체가 그 소스엔 아예 없는 것"을 구분해, 전자면
 *  Wiktionary로 넘어가기 전에 상위 소스 안에서 기본형으로 먼저 구제한다.
 *
 *  **후보 전부를 시도하고 결과를 합친다(첫 성공에서 멈추지 않음)** — 처음엔 후보 중
 *  하나라도 성공하면 바로 반환했는데, 실측으로 발견: OEWN에 "closed"를 그대로 물으면
 *  그 자체로 형용사 표제어("not open")가 있어 "성공"으로 끝나버려서, 뒤에 이어 시도할
 *  "close"(동사, "닫다") 후보를 아예 안 물어보게 된다 — 문맥이 동사 용법("She closed
 *  the door")이어도 LLM 후보 목록에 동사 뜻 자체가 없어 고를 수가 없었다. 표면형과
 *  추측 후보가 서로 다른 뜻일 수 있으니(동형이의어), 소스 하나 안에서는 후보 전부를
 *  시도해 나온 entries 를 전부 합쳐 LLM 후보 목록에 넣는다. **트레이드오프**: ja 관용구
 *  ("犬も歩けば棒に当たる")도 첫 토큰("犬")이 그 자체로 유효한 표제어라 관용구 자체의
 *  뜻과 "犬"(개) 단독의 여러 뜻이 함께 후보에 섞인다 — 틀린 답이 되는 건 아니고
 *  후보만 늘어나는 정도라 감수하기로 함(2026-07-29). */
async function wordCandidatesFor(word: string, language: Language): Promise<string[]> {
  if (language === 'ja') return japaneseWordCandidates(word)
  if (language === 'en') return englishWordCandidates(word)
  return [word]
}

async function lookupThroughFallbackChain(word: string, ctx: DictSelectionContext): Promise<ChainLookupResult> {
  const chain = FALLBACK_CHAINS[ctx.language]
  const candidates = await wordCandidatesFor(word, ctx.language)
  let suggestions: string[] | undefined
  for (const source of chain) {
    const collectedEntries: DictionaryEntry<Language>[] = []
    const matchedCandidates: string[] = []
    for (const candidate of candidates) {
      try {
        const result = await fetchSourceEntries(source, ctx, candidate)
        suggestions ??= result.suggestions
        if (result.entries?.length) {
          collectedEntries.push(...result.entries)
          matchedCandidates.push(candidate)
        }
      } catch (err) {
        console.warn(`[dictionary] ${source}(${candidate}) 조회 실패, 다음으로 폴백:`, err)
      }
    }
    if (collectedEntries.length) {
      const senses = numberSenses(collectedEntries)
      if (senses.length) {
        return {
          senses,
          sourceId: collectedEntries[0].source,
          suggestions,
          entries: collectedEntries,
          matchedWord: matchedCandidates.includes(word) ? undefined : matchedCandidates[0],
        }
      }
    }
  }
  return { senses: [], suggestions }
}

/** 단어 하나를 폴백 체인 조회 → LLM 판정/번역까지 끝내 서식화된 마크다운으로 돌려준다.
 *  폴백 경로 전용 — "사전에 없는 단어"(null)와 "LLM 호출 자체가 실패함"(llmError)을
 *  구분해 돌려준다. 개별 소스 조회 실패는 lookupThroughFallbackChain 안에서 이미 다음
 *  소스로 흡수되므로 여기서 따로 구분할 필요가 없다. */
async function lookupSingleWordThroughChain(
  word: string,
  ctx: DictSelectionContext,
  client: ReturnType<typeof createClient>,
  model: string,
  cacheableContext: string,
): Promise<{ formatted: string } | { llmError: unknown } | null> {
  const { senses, sourceId, entries } = await lookupThroughFallbackChain(word, ctx)
  if (!senses.length || !sourceId) return null

  const outcome = await judgeAndFormat({ word, source: sourceId, senses, ctx, client, model, cacheableContext })
  if (!outcome.ok) return { llmError: outcome.error }
  return { formatted: withDebugCountsLine(outcome.formatted, entries, senses.length, outcome.selected) } // TEMP DEBUG
}

interface JudgeAndFormatArgs {
  word: string
  source: DictionarySourceId
  senses: ReturnType<typeof numberSenses>
  ctx: DictSelectionContext
  client: ReturnType<typeof createClient>
  model: string
  cacheableContext: string
}

type JudgeAndFormatResult =
  | { ok: true; formatted: string; selected: ReturnType<typeof parseJudgeReply> }
  | { ok: false; error: unknown }

/** LLM 에 뜻풀이 후보를 판정+번역 요청한 뒤 채팅창용 마크다운으로 서식화한다 —
 *  통째 조회 경로와 단어별 폴백 경로가 공유하는 핵심 로직. */
async function judgeAndFormat(args: JudgeAndFormatArgs): Promise<JudgeAndFormatResult> {
  const { word, source, senses, ctx, client, model, cacheableContext } = args
  const system = renderPrompt(dictionaryPromptTemplate, { language: getLanguageName(ctx.language) })
  const prompt = `[선택된 표현]: ${word}\n\n[뜻풀이 후보]\n${buildSenseListText(senses)}`

  let reply: string
  try {
    // 판정+번역 전용 호출 — 델타를 onChunk 로 흘리지 않는다. 채팅창에 보일 최종 텍스트는
    // LLM 이 쓴 문장을 그대로 쓰는 게 아니라, formatDictionaryAnswer 가 그 번역 결과와
    // 사전 원본 데이터(품사·출처·활용형 등)를 조합해 직접 구성한다.
    reply = await client.stream(
      {
        system,
        cacheableContext,
        messages: [{ role: 'user', content: prompt }],
        model,
        maxTokens: DICTIONARY_JUDGE_MAX_TOKENS,
        temperature: DICTIONARY_JUDGE_TEMPERATURE,
      },
      () => {},
    )
  } catch (err) {
    return { ok: false, error: err }
  }

  const selected = parseJudgeReply(reply, senses)
  return { ok: true, formatted: formatDictionaryAnswer(word, source, selected, ctx.language), selected }
}

/** ja 활용형(동사/형용사/な형용사+だ, 명사+する 복합동사 등) 표면형 → 사전 기본형 변환
 *  — 통째 표면형 조회가 실패했을 때만 호출된다(lookupDictionary 참고). 형태소 분석
 *  (main/nlp/japanese.ts, JA_ENGINE 설정값)의 첫 토큰만 본다 — ja/zh 는 팝업이 이미
 *  원자 단위로 선택돼 있어 "여러 단어"가 아니라 "하나의 활용된 단어"라는 전제(TODO.md
 *  131번 항목의 en 다중 단어 폴백과 다른 축).
 *  - 첫 토큰 자체가 활용됐으면(baseForm ≠ surface, 실측: 歩いた→歩く, 大きかった→大きい,
 *    静かだ→静か, はしゃぎ→はしゃぐ) 토큰 개수와 무관하게 그 기본형을 쓴다 — **활용된
 *    단어가 항상 토큰 2개(어간+활용어미)로 쪼개지는 건 아니다**(2026-07-29 실측 발견:
 *    "はしゃぎ"(동사 連用形이 그대로 명사처럼 쓰인 형태)는 단일 토큰인데도 baseForm이
 *    "はしゃぐ"로 이미 채워져 있음 — 예전엔 `tokens.length < 2`로 이런 단일 토큰 활용형을
 *    전부 걸러내 daijisen/JMdict 둘 다 표면형만으로 조회를 시도하다 실패했다).
 *  - 첫 토큰은 안 변했는데 뒤에 토큰이 더 있으면(명사+する 복합동사, 실측: 勉強する→
 *    勉強+する 2토큰, "勉強する"는 404지만 "勉強" 단독은 정상 조회됨) 첫 토큰의 표면형만
 *    따로 조회한다 — 뒤에 붙은 する/조사 등을 뗀 값.
 *  - 토큰이 하나뿐이고 활용도 없으면(이미 원형이거나 명사 등) null. */
async function toJapaneseDictionaryBaseForm(word: string): Promise<string | null> {
  const tokens = await tokenizeJapanese(word)
  const first = tokens[0]
  if (!first) return null
  if (first.baseForm && first.baseForm !== first.surface) return first.baseForm
  return tokens.length >= 2 ? first.surface || null : null
}

/** en 폴백용 단어 분리 — 공백·하이픈 기준(팝업 atom 규칙과 동일한 축, 문장부호는 버림).
 *  "kick the bucket" → ["kick", "the", "bucket"]. 관사·조사 등 사전에 뜻이 없는 기능어는
 *  별도로 걸러내지 않는다 — 체인 끝까지 못 찾으면 자연히 결과에서 빠진다. */
function splitIntoWords(text: string): string[] {
  return text
    .split(/[\s-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
}

function notFoundResult(word: string, suggestions?: string[]): QuestionResult {
  const suggestion = suggestions?.length ? ` (제안: ${suggestions.slice(0, 5).join(', ')})` : ''
  return { kind: 'dictionary', content: `사전에서 "${word}"를 찾지 못했습니다.${suggestion}` }
}

function emit(onChunk: (chunk: QuestionResult) => void, result: QuestionResult): QuestionResult {
  onChunk(result)
  return result
}

// ============================================================================
// TEMP DEBUG — LLM에 넘긴 entry/reading/sense 개수를 결과 맨 윗줄에 표시(임시, 제거
// 예정). 제거할 때는 이 함수 하나 + 호출부의 `// TEMP DEBUG` 표시가 붙은 줄들만
// 지우면 된다(각 호출부는 `withDebugCountsLine(outcome.formatted, ...)` →
// `outcome.formatted` 로 되돌리면 끝, 다른 로직은 안 건드려도 됨).
// ============================================================================
function withDebugCountsLine(
  formatted: string,
  entries: DictionaryEntry<Language>[] | undefined,
  senseCount: number,
  selected: ReturnType<typeof parseJudgeReply>,
): string {
  const entryCount = entries?.length ?? 0
  const readingCount = entries?.reduce((sum, e) => sum + e.readings.length, 0) ?? 0
  // LLM이 "대응어:" 줄을 실제로 줬는지 — combineTranslation이 길이 비율로 걸러내
  // 최종 번역에서는 대응어가 안 보일 수 있어(senseSelect.ts 참고), "LLM이 아예 안
  // 줬는지" vs "줬는데 로컬에서 걸렀는지"를 구분할 방법이 없다는 사용자 피드백으로
  // 추가(2026-07-29). 없으면 명시적으로 "없음"이라고 표시한다.
  const counterparts = selected
    .map((s) => `${s.sense.index}번: ${s.rawCounterpart ? `"${s.rawCounterpart}"` : '없음'}`)
    .join(', ')
  return `_[DEBUG] entries: ${entryCount} / readings: ${readingCount} / senses: ${senseCount} / 대응어(LLM 원본) — ${counterparts || '없음'}_\n\n${formatted}`
}

// ---- 소스별 조회 디스패치 — 폴백 체인과 forceSource 디버깅 경로가 공유 ----------------

/** API 키가 필요한데 없는 소스(현재 MW 뿐) — 폴백 체인에선 "이 소스 건너뜀"으로,
 *  forceSource 에선 "키를 입력해 주세요" 안내로 각자 소비한다. */
class MissingDictionaryApiKeyError extends Error {
  constructor(public source: DictionarySourceId) {
    super(`${source}: api key missing`)
  }
}

/** 언어 전용 소스를 그 언어가 아닌데 강제로 호출했을 때(forceSource 전용 케이스 — 정식
 *  폴백 체인은 FALLBACK_CHAINS 자체가 언어별로 이미 걸러져 있어 이 경로를 안 탄다). */
class UnsupportedLanguageDictionaryError extends Error {
  constructor(
    public source: DictionarySourceId,
    message: string,
  ) {
    super(message)
  }
}

/** 아직 어댑터가 이 디스패치에 안 붙은 소스. */
class SourceNotImplementedError extends Error {
  constructor(public source: DictionarySourceId) {
    super(`${source}: not implemented`)
  }
}

/** 소스 하나를 실제로 조회해 entries 를 뽑아온다 — 폴백 체인과 forceSource 디버깅 경로가
 *  공유하는 유일한 진입점(어댑터별 반환 모양이 다 달라 여기서 한 번만 흡수한다). 어댑터가
 *  던지는 에러(네트워크 실패 등)는 그대로 다시 던진다 — "이 소스만 건너뛰고 다음으로"
 *  (폴백 체인)와 "에러를 그대로 보여주기"(forceSource)를 호출부가 각자 판단하게 한다.
 *  MW만 suggestions 를 준다(나머지는 항상 undefined). */
async function fetchSourceEntries(
  source: DictionarySourceId,
  ctx: DictSelectionContext,
  word: string,
): Promise<{ entries?: DictionaryEntry<Language>[]; suggestions?: string[] }> {
  switch (source) {
    case 'merriam-webster': {
      if (ctx.language !== 'en') {
        throw new UnsupportedLanguageDictionaryError(source, 'Merriam-Webster는 영어 전용 사전입니다.')
      }
      const key = getApiKey('mw')
      if (!key) throw new MissingDictionaryApiKeyError(source)
      const lookup = await fetchMerriamWebsterEntry(word, key)
      return { entries: lookup.entries, suggestions: lookup.suggestions }
    }
    case 'wordnet': {
      if (ctx.language !== 'en') {
        throw new UnsupportedLanguageDictionaryError(source, 'OEWN은 영어 전용 사전입니다.')
      }
      return { entries: (await fetchOewnEntry(word)).entries }
    }
    case 'wiktionary': {
      const lookup = await fetchWiktionaryEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'daijisen': {
      if (ctx.language !== 'ja') {
        throw new UnsupportedLanguageDictionaryError(source, 'daijisen(デジタル大辞泉)은 일본어 전용 사전입니다.')
      }
      const lookup = await fetchDaijisenEntry(word)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'jmdict': {
      if (ctx.language !== 'ja') {
        throw new UnsupportedLanguageDictionaryError(source, 'JMdict는 일본어 전용 사전입니다.')
      }
      return { entries: (await fetchJmdictEntry(word)).entries }
    }
    case 'hanyu-dict': {
      if (ctx.language !== 'zh-Hans' && ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, '汉典은 중국어 전용 사전입니다.')
      }
      const lookup = await fetchHanyuEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'guoyu-cidian': {
      if (ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, '教育部重編國語辭典(萌典)은 중국어(번체) 전용 사전입니다.')
      }
      const lookup = await fetchGuoyuCidianEntry(word)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'cc-cedict': {
      if (ctx.language !== 'zh-Hans' && ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, 'CC-CEDICT는 중국어 전용 사전입니다.')
      }
      const lookup = await fetchCcCedictEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    default:
      throw new SourceNotImplementedError(source)
  }
}

/** MW 요청 실패를 사람이 읽을 수 있는 메시지로 바꾼다. MW는 provider(LlmProvider)가
 *  아니라 classifyLlmError 대상이 아니고, 실측 확인(2026-07-28, 무효 키 직접 호출)한
 *  MW 특유의 함정도 있다 — 키가 무효해도 HTTP 200을 그대로 주고 본문에 "Invalid API
 *  key. Not subscribed for this reference." 같은 평문만 담아 보낸다(JSON 이 아니라
 *  파싱도 실패함). 이걸 구분 안 하면 죄다 "네트워크 오류"로 뭉뚱그려져 실제로는 키가
 *  잘못된 건데 사용자가 인터넷 연결을 의심하게 된다. */
function describeMerriamWebsterError(err: MerriamWebsterHttpError): string {
  const lower = err.body.toLowerCase()
  if (err.status === 401 || err.status === 403 || lower.includes('invalid api key')) {
    return 'Merriam-Webster API 키가 유효하지 않습니다. 설정에서 키를 다시 확인해 주세요.'
  }
  if (err.status === 429) {
    return 'Merriam-Webster 요청이 너무 많습니다(무료 티어 일일 한도를 초과했을 수 있습니다). 잠시 후 다시 시도해 주세요.'
  }
  if (err.status >= 500) {
    return 'Merriam-Webster 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
  }
  return 'Merriam-Webster 사전 조회에 실패했습니다.'
}

/** fetchSourceEntries 가 던진 에러를 forceSource(디버깅 강제 호출) 전용으로 사람이 읽을
 *  메시지로 바꾼다 — 폴백 체인은 이 함수를 쓰지 않고 에러를 그냥 흡수한다(위
 *  lookupThroughFallbackChain 참고). 개별 소스 실패 원인을 사용자에게 바로 보여줘야
 *  하는 건 forceSource 뿐이라 여기 몰아뒀다. */
function describeSourceError(source: DictionarySourceId, err: unknown): string {
  if (err instanceof UnsupportedLanguageDictionaryError) return err.message
  if (err instanceof SourceNotImplementedError) {
    return `"${source}" 어댑터는 아직 디버깅 강제 호출에 연결되지 않았습니다.`
  }
  if (err instanceof MissingDictionaryApiKeyError) {
    return 'Merriam-Webster 사전 API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.'
  }
  if (err instanceof MerriamWebsterHttpError) return describeMerriamWebsterError(err)
  if (
    err instanceof DaijisenHttpError ||
    err instanceof HanyuHttpError ||
    err instanceof GuoyuCidianHttpError ||
    err instanceof WiktionaryHttpError
  ) {
    if (err.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
    if (err.status >= 500) return '사전 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
    return '사전 조회에 실패했습니다.'
  }
  return '네트워크 연결에 문제가 있어 사전 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

// ============================================================================
// 임시 디버깅 강제 소스 선택 구현부 — 위 forceSource 블록과 한 세트, 제거 예정.
// fetchSourceEntries(위, 정식 폴백 체인과 공유)로 고른 소스 하나만 호출하고, 그 뒤(sense
// 번호매김 → LLM 판정/번역 → 서식화)는 위 정식 플로우와 완전히 같은 judgeAndFormat/
// numberSenses(senseSelect.ts)를 그대로 재사용한다 — 로직을 복붙하지 않기 위함.
// 정식 폴백 오케스트레이션이 이미 완성됐으니, 이 기능을 걷어낼 땐 이 함수 전체 + 위
// forceSource 분기 + registry.ts + 팝업 토글/드롭다운만 지우면 되고, fetchSourceEntries/
// judgeAndFormat 등 폴백 체인이 계속 쓰는 헬퍼는 그대로 둔다.
// ============================================================================
async function lookupForcedSource(source: DictionarySourceId, ctx: DictSelectionContext): Promise<QuestionResult> {
  const word = ctx.selectedText.trim()
  if (!word) {
    return { kind: 'dictionary', content: '선택된 표현이 없습니다.' }
  }

  // 강제 소스 선택도 정식 폴백 체인(lookupThroughFallbackChain)과 동일하게 활용형→기본형
  // 후보(japaneseWordCandidates/englishWordCandidates)를 전부 시도해 entries 를 합친다
  // (2026-07-29) — 이전엔 표면형 하나만 쿼리해서 "行って"(行く의 て형)처럼 daijisen/
  // JMdict/Wiktionary 어느 소스를 골라도 항상 "못 찾음"이었다. 후보 중 하나가 그 자체로도
  // 표제어일 수 있어도(실측: "食べられる"가 JMdict에 가능형 "to be able to eat"으로 직접
  // 등재돼 있음) 첫 성공에서 멈추지 않고 기본형("食べる") 후보까지 마저 시도해 entries 를
  // 합친다 — 그래야 LLM 후보 목록에 원형 타동사 "먹다" 뜻도 함께 들어가 문맥에 맞게 고를
  // 수 있다(체인 쪽 "closed"/"close" 사례와 동일한 이유, 위 lookupThroughFallbackChain
  // 주석 참고). 표면형(첫 후보) 조회 실패만 설정 문제(키 미설정 등)일 수 있어 그대로
  // 보여주고, 그 다음 후보들의 실패는 체인과 동일하게 조용히 다음 후보로 넘어간다.
  const candidates = await wordCandidatesFor(word, ctx.language)
  const collectedEntries: DictionaryEntry<Language>[] = []
  const matchedCandidates: string[] = []
  let suggestions: string[] | undefined
  let firstCandidateError: unknown
  for (const [i, candidate] of candidates.entries()) {
    try {
      const r = await fetchSourceEntries(source, ctx, candidate)
      suggestions ??= r.suggestions
      if (r.entries?.length) {
        collectedEntries.push(...r.entries)
        matchedCandidates.push(candidate)
      }
    } catch (err) {
      if (i === 0) firstCandidateError = err
      else console.warn(`[dictionary] ${source}(${candidate}) 강제 조회 실패, 다음 후보로:`, err)
    }
  }

  if (!collectedEntries.length) {
    if (firstCandidateError) return { kind: 'dictionary', content: describeSourceError(source, firstCandidateError) }
    return notFoundResult(word, suggestions)
  }
  const senses = numberSenses(collectedEntries)
  if (!senses.length) {
    return notFoundResult(word, suggestions)
  }

  const provider = getActiveProvider()
  if (!provider) return buildErrorResult('dictionary', 'no_active_provider')
  const llmKey = getApiKey(provider)
  if (!llmKey) return buildErrorResult('dictionary', 'no_api_key', provider)

  const settings = getSettings()
  const client = createClient(provider, { apiKey: llmKey })
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const outcome = await judgeAndFormat({
    word: matchedCandidates.includes(word) ? word : (matchedCandidates[0] ?? word),
    source: collectedEntries[0].source,
    senses,
    ctx,
    client,
    model: settings.models[provider] || DEFAULT_MODELS[provider],
    cacheableContext,
  })

  if (!outcome.ok) {
    return buildErrorResult('dictionary', classifyLlmError(outcome.error), provider)
  }
  return {
    kind: 'dictionary',
    content: withDebugCountsLine(outcome.formatted, collectedEntries, senses.length, outcome.selected), // TEMP DEBUG
    meta: { provider, source: collectedEntries[0].source },
  }
}
