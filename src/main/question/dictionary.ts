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
import { LANGUAGES } from '@shared/languages'
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

// 담당 B — 사전 검색 (PLAN.md §4.2-2)
// 언어별 정식 폴백 체인(FALLBACK_CHAINS, 아래)으로 원어 뜻(sense) 후보를 모으고, LLM 에
// "문맥상 몇 번인지" 판정과 그 뜻풀이·예문의 한국어 번역을 함께 맡긴다(PLAN.md §5:
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

export async function lookupDictionary(
  ctx: SelectionContext,
  forceSource: DictionarySourceId | undefined,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
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

  let whole = await lookupThroughFallbackChain(word, ctx)
  let lookupWord = word
  if (!whole.senses.length && ctx.language === 'ja') {
    // ja(daijisen·JMdict·Wiktionary 전부) 활용형을 원형으로 자동 변환해주지 않는다
    // (TODO.md 131번 항목) — 통째 표면형 조회가 실패했을 때만(관용구/원형 그대로인
    // 단어는 위에서 이미 성공해 여기까지 안 옴) 기본형으로 바꿔 **같은 체인 전체**를
    // 재시도한다(daijisen→jmdict→wiktionary 전부 기본형으로 다시 탐). 표면형을 먼저
    // 시도하는 이유: "犬も歩けば棒に当たる" 같은 관용구는 활용형 변환 없이 표면형
    // 그대로가 정답이라, 무조건 먼저 기본형화하면 이런 경우를 깨뜨린다.
    const baseForm = await toJapaneseDictionaryBaseForm(word).catch(() => null)
    if (baseForm && baseForm !== word) {
      const retried = await lookupThroughFallbackChain(baseForm, ctx)
      if (retried.senses.length) {
        whole = retried
        lookupWord = baseForm
      }
    }
  }
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
        content: withDebugCountsLine(outcome.formatted, whole.entries, whole.senses.length), // TEMP DEBUG
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
  /** TEMP DEBUG(맨 윗줄 entry/reading/sense 개수 표시용) — 제거 시 이 필드도 같이 삭제. */
  entries?: DictionaryEntry<Language>[]
}

/** FALLBACK_CHAINS 를 앞에서부터 순서대로 시도해 sense 가 하나라도 있는 첫 소스에서
 *  멈춘다("앞 소스가 못 찾을 때만 다음으로" — TODO.md/DICTIONARY_SOURCES.md 확정 순서).
 *  개별 소스 실패(네트워크 에러 등)도 "여기선 못 찾음"과 동일하게 다음 소스로 넘어간다 —
 *  폴백 체인은 중간 실패를 사용자에게 구구절절 보여주기보다 끝까지 시도해보고 그래도
 *  안 되면 그때 "찾지 못함"으로 뭉뚱그린다(개별 에러는 진단용으로 console.warn 만 남김). */
async function lookupThroughFallbackChain(word: string, ctx: SelectionContext): Promise<ChainLookupResult> {
  const chain = FALLBACK_CHAINS[ctx.language]
  let suggestions: string[] | undefined
  for (const source of chain) {
    try {
      const result = await fetchSourceEntries(source, ctx, word)
      suggestions ??= result.suggestions
      if (!result.entries?.length) continue
      const senses = numberSenses(result.entries)
      if (senses.length) return { senses, sourceId: result.entries[0].source, suggestions, entries: result.entries }
    } catch (err) {
      console.warn(`[dictionary] ${source} 조회 실패, 다음 소스로 폴백:`, err)
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
  ctx: SelectionContext,
  client: ReturnType<typeof createClient>,
  model: string,
  cacheableContext: string,
): Promise<{ formatted: string } | { llmError: unknown } | null> {
  const { senses, sourceId, entries } = await lookupThroughFallbackChain(word, ctx)
  if (!senses.length || !sourceId) return null

  const outcome = await judgeAndFormat({ word, source: sourceId, senses, ctx, client, model, cacheableContext })
  if (!outcome.ok) return { llmError: outcome.error }
  return { formatted: withDebugCountsLine(outcome.formatted, entries, senses.length) } // TEMP DEBUG
}

interface JudgeAndFormatArgs {
  word: string
  source: DictionarySourceId
  senses: ReturnType<typeof numberSenses>
  ctx: SelectionContext
  client: ReturnType<typeof createClient>
  model: string
  cacheableContext: string
}

type JudgeAndFormatResult = { ok: true; formatted: string } | { ok: false; error: unknown }

/** LLM 에 뜻풀이 후보를 판정+번역 요청한 뒤 채팅창용 마크다운으로 서식화한다 —
 *  통째 조회 경로와 단어별 폴백 경로가 공유하는 핵심 로직. */
async function judgeAndFormat(args: JudgeAndFormatArgs): Promise<JudgeAndFormatResult> {
  const { word, source, senses, ctx, client, model, cacheableContext } = args
  const system = renderPrompt(dictionaryPromptTemplate, { language: LANGUAGES[ctx.language].name })
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
  return { ok: true, formatted: formatDictionaryAnswer(word, source, selected, ctx.language) }
}

/** ja 활용형(동사/형용사/な형용사+だ, 명사+する 복합동사 등) 표면형 → 사전 기본형 변환
 *  — 통째 표면형 조회가 실패했을 때만 호출된다(lookupDictionary 참고). 형태소 분석
 *  (main/nlp/japanese.ts, JA_ENGINE 설정값)의 첫 토큰만 본다 — ja/zh 는 팝업이 이미
 *  원자 단위로 선택돼 있어 "여러 단어"가 아니라 "하나의 활용된 단어"라는 전제(TODO.md
 *  131번 항목의 en 다중 단어 폴백과 다른 축).
 *  - 첫 토큰 자체가 활용됐으면(baseForm ≠ surface, 실측: 歩いた→歩く, 大きかった→大きい,
 *    静かだ→静か) 그 기본형을 쓴다.
 *  - 첫 토큰은 안 변했는데 뒤에 토큰이 더 있으면(명사+する 복합동사, 실측: 勉強する→
 *    勉強+する 2토큰, "勉強する"는 404지만 "勉強" 단독은 정상 조회됨) 첫 토큰의 표면형만
 *    따로 조회한다 — 뒤에 붙은 する/조사 등을 뗀 값.
 *  - 토큰이 하나뿐이면(활용 문제가 아님, 이미 원형이거나 명사 등) null. */
async function toJapaneseDictionaryBaseForm(word: string): Promise<string | null> {
  const tokens = await tokenizeJapanese(word)
  if (tokens.length < 2) return null
  const first = tokens[0]
  if (first.baseForm && first.baseForm !== first.surface) return first.baseForm
  return first.surface || null
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
): string {
  const entryCount = entries?.length ?? 0
  const readingCount = entries?.reduce((sum, e) => sum + e.readings.length, 0) ?? 0
  return `_[DEBUG] entries: ${entryCount} / readings: ${readingCount} / senses: ${senseCount}_\n\n${formatted}`
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
  ctx: SelectionContext,
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
async function lookupForcedSource(source: DictionarySourceId, ctx: SelectionContext): Promise<QuestionResult> {
  const word = ctx.selectedText.trim()
  if (!word) {
    return { kind: 'dictionary', content: '선택된 표현이 없습니다.' }
  }

  let result: { entries?: DictionaryEntry<Language>[]; suggestions?: string[] }
  try {
    result = await fetchSourceEntries(source, ctx, word)
  } catch (err) {
    return { kind: 'dictionary', content: describeSourceError(source, err) }
  }

  if (!result.entries?.length) {
    return notFoundResult(word, result.suggestions)
  }
  const senses = numberSenses(result.entries)
  if (!senses.length) {
    return notFoundResult(word, result.suggestions)
  }

  const provider = getActiveProvider()
  if (!provider) return buildErrorResult('dictionary', 'no_active_provider')
  const llmKey = getApiKey(provider)
  if (!llmKey) return buildErrorResult('dictionary', 'no_api_key', provider)

  const settings = getSettings()
  const client = createClient(provider, { apiKey: llmKey })
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const outcome = await judgeAndFormat({
    word,
    source: result.entries[0].source,
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
    content: withDebugCountsLine(outcome.formatted, result.entries, senses.length), // TEMP DEBUG
    meta: { provider, source: result.entries[0].source },
  }
}
