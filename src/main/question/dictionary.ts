import type { QuestionResult, SelectionContext, DictionarySourceId } from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { getSettings } from '@main/settingsStore'
import { DEFAULT_MODELS } from '@shared/providers'
import { LANGUAGES } from '@shared/languages'
import { fetchMwEntry } from './dictionary/mw'
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
// en 은 MW → (TODO: OEWN → Wiktionary 폴백) 로 원어 뜻(sense) 후보를 모으고, LLM 에
// "문맥상 몇 번인지" 판정과 그 뜻풀이·예문의 한국어 번역을 함께 맡긴다(PLAN.md §5:
// 사전 API는 원어 뜻만 제공, 한국어 설명·번역은 LLM 담당). 채팅창에 보일 최종 텍스트는
// 그 번역 결과와 사전 원본 데이터(품사·출처·활용형 등)를 조합해 여기서 직접 구성한다.
// ja/zh 는 아직 소스 어댑터가 없어 스텁으로 남겨둔다.
//
// 다중 단어 선택 폴백(TODO.md 참고): 선택 텍스트 전체를 표제어로 먼저 조회하고("kick the
// bucket" 같은 관용구는 통째로 사전에 있을 수 있음), 못 찾으면 단어 단위로 쪼개 각각
// 독립적으로 같은 파이프라인(lookupSingleWord)을 병렬 호출한다. 단어별 뜻은 서로 무관해
// 하나의 프롬프트/판정으로 억지로 합칠 필요가 없어 이 구조를 택함 — 단, MW+LLM 호출이
// 단어 수만큼 늘어나므로 MAX_FALLBACK_WORDS 로 상한을 둔다.

const DICTIONARY_JUDGE_TEMPERATURE = 0.2
const DICTIONARY_JUDGE_MAX_TOKENS = 500
/** 폴백 시 개별 조회할 단어 수 상한 — MW 무료 티어(일 1,000회)와 LLM 호출 비용 보호용.
 *  이보다 길게 드래그하면 폴백 없이 "찾지 못했습니다"로 처리한다. */
const MAX_FALLBACK_WORDS = 5

export async function lookupDictionary(
  ctx: SelectionContext,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  if (ctx.language !== 'en') {
    return emit(onChunk, { kind: 'dictionary', content: '이 언어는 아직 사전 검색을 지원하지 않습니다.' })
  }

  const word = ctx.selectedText.trim()
  if (!word) {
    return emit(onChunk, { kind: 'dictionary', content: '선택된 표현이 없습니다.' })
  }

  const mwKey = getApiKey('mw')
  if (!mwKey) {
    return emit(onChunk, {
      kind: 'dictionary',
      content: 'Merriam-Webster 사전 API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.',
    })
  }

  let lookup
  try {
    lookup = await fetchMwEntry(word, mwKey)
  } catch {
    return emit(onChunk, buildErrorResult('dictionary', 'network_error'))
  }

  if (lookup.entries?.length) {
    const senses = numberSenses(lookup.entries)
    if (senses.length) {
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
      const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

      const outcome = await judgeAndFormat({
        word,
        headword: lookup.entries[0].headword[0],
        source: lookup.entries[0].source,
        senses,
        ctx,
        client,
        model: settings.models[provider] || DEFAULT_MODELS[provider],
        cacheableContext,
      })

      if (outcome.ok) {
        return emit(onChunk, {
          kind: 'dictionary',
          content: outcome.formatted,
          meta: { provider, source: lookup.entries[0].source },
        })
      }
      return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(outcome.error), provider))
    }
  }

  // 통째 조회 실패 — 여러 단어로 쪼개지면 단어별로 폴백 시도.
  const words = splitIntoWords(word)
  if (words.length <= 1) {
    return emit(onChunk, notFoundResult(word, lookup.suggestions))
  }
  if (words.length > MAX_FALLBACK_WORDS) {
    // 긴 속담/관용구는 사용자가 실제로 드래그한 표면형(대명사·부속어 포함)으로는 통째
    // 조회가 거의 항상 실패하지만(실측: "don't count your chickens before they hatch" 등),
    // MW 가 정규화된 표제어를 suggestions 로 이미 알려주는 경우가 많아(실측: "count one's
    // chickens (before they hatch)") 단어별 폴백보다 이게 더 쓸모 있다 — 버리지 않고 보여준다.
    const suggestion = lookup.suggestions?.length
      ? ` (제안: ${lookup.suggestions.slice(0, 5).join(', ')})`
      : ''
    return emit(onChunk, {
      kind: 'dictionary',
      content: `선택 범위가 너무 넓어 사전 검색을 건너뜁니다(단어 ${words.length}개, 최대 ${MAX_FALLBACK_WORDS}개).${suggestion}`,
    })
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
  // 원문맥(cacheableContext)은 원래 선택 전체 기준으로 한 번만 만들어 모든 단어 호출에
  // 재사용한다 — 어차피 캐시 대상이라 매번 새로 만들면 캐시 적중률만 낮아진다.
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const perWordResults = await Promise.allSettled(
    words.map((w) => lookupSingleWord(w, mwKey, ctx, client, model, cacheableContext)),
  )

  const formattedBlocks = perWordResults
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is string => v !== null)

  if (!formattedBlocks.length) {
    return emit(onChunk, notFoundResult(word, lookup.suggestions))
  }

  return emit(onChunk, {
    kind: 'dictionary',
    content: formattedBlocks.join('\n\n---\n\n'),
    meta: { provider },
  })
}

/** 단어 하나를 MW 조회 → LLM 판정/번역까지 끝내 서식화된 마크다운으로 돌려준다.
 *  폴백 경로 전용 — 못 찾거나 개별 호출이 실패하면(네트워크/LLM 에러 포함) null 을 돌려주고
 *  조용히 건너뛴다(이미 통째 조회 단계에서 네트워크·API 키는 확인이 끝난 상태라, 여기서
 *  나는 실패는 그 단어 하나만의 문제로 본다). */
async function lookupSingleWord(
  word: string,
  mwKey: string,
  ctx: SelectionContext,
  client: ReturnType<typeof createClient>,
  model: string,
  cacheableContext: string,
): Promise<string | null> {
  let lookup
  try {
    lookup = await fetchMwEntry(word, mwKey)
  } catch {
    return null
  }
  if (!lookup.entries?.length) return null

  const senses = numberSenses(lookup.entries)
  if (!senses.length) return null

  const outcome = await judgeAndFormat({
    word,
    headword: lookup.entries[0].headword[0],
    source: lookup.entries[0].source,
    senses,
    ctx,
    client,
    model,
    cacheableContext,
  })
  return outcome.ok ? outcome.formatted : null
}

interface JudgeAndFormatArgs {
  word: string
  headword: string
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
  const { word, headword, source, senses, ctx, client, model, cacheableContext } = args
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
  return { ok: true, formatted: formatDictionaryAnswer(headword, source, selected) }
}

/** en 폴백용 단어 분리 — 공백·하이픈 기준(팝업 atom 규칙과 동일한 축, 문장부호는 버림).
 *  "kick the bucket" → ["kick", "the", "bucket"]. 관사·조사 등 사전에 뜻이 없는 기능어는
 *  별도로 걸러내지 않는다 — MW 가 그 단어에 대해 못 찾으면 자연히 결과에서 빠진다. */
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
