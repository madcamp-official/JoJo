import type { QuestionResult, SelectionContext, DictionarySourceId } from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { getSettings } from '@main/settingsStore'
import { DEFAULT_MODELS } from '@shared/providers'
import { LANGUAGES } from '@shared/languages'
import { fetchMwEntry, MwHttpError } from './dictionary/mw'
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
  } catch (err) {
    return emit(onChunk, { kind: 'dictionary', content: describeMwError(err) })
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
  const outcomes = perWordResults.map((r) => (r.status === 'fulfilled' ? r.value : null))

  const formattedBlocks = outcomes
    .filter((o): o is { formatted: string } => o !== null && 'formatted' in o)
    .map((o) => o.formatted)

  if (!formattedBlocks.length) {
    // 단어 전부가 사전에 없는 것과, MW/LLM 요청 자체가 전부 실패한 것(무효 키, 잘못된
    // 모델 등)은 원인이 다르다 — 후자를 "사전에서 못 찾음"으로 뭉개면 사용자가 엉뚱한
    // 곳을 의심하게 되므로, 둘 중 하나라도 있었으면 그걸 그대로 보여준다.
    const llmError = outcomes.find((o): o is { llmError: unknown } => o !== null && 'llmError' in o)
    if (llmError) {
      return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(llmError.llmError), provider))
    }
    const mwError = outcomes.find((o): o is { mwError: unknown } => o !== null && 'mwError' in o)
    if (mwError) {
      return emit(onChunk, { kind: 'dictionary', content: describeMwError(mwError.mwError) })
    }
    return emit(onChunk, notFoundResult(word, lookup.suggestions))
  }

  return emit(onChunk, {
    kind: 'dictionary',
    content: formattedBlocks.join('\n\n---\n\n'),
    meta: { provider },
  })
}

/** 단어 하나를 MW 조회 → LLM 판정/번역까지 끝내 서식화된 마크다운으로 돌려준다.
 *  폴백 경로 전용 — "사전에 없는 단어"(null)와 "MW/LLM 호출 자체가 실패함"(mwError/
 *  llmError)을 구분해 돌려준다. sense 없음은 그 단어 하나만의 문제로 보고 null 처리하지만,
 *  MW 요청 실패(무효 키 등)나 LLM 호출 실패(잘못된 모델 등)는 모든 단어에서 똑같이 날
 *  가능성이 높아 호출부가 원인을 그대로 보여줄 수 있게 구분해서 넘긴다 — 통째 조회
 *  단계에서 이미 성공적으로 MW/LLM 을 호출한 뒤라 "웬만하면 괜찮겠지"로 여기서만
 *  조용히 null 처리하면, 그 사이 키가 만료되는 등 드문 케이스에서 원인을 숨기게 된다. */
async function lookupSingleWord(
  word: string,
  mwKey: string,
  ctx: SelectionContext,
  client: ReturnType<typeof createClient>,
  model: string,
  cacheableContext: string,
): Promise<{ formatted: string } | { llmError: unknown } | { mwError: unknown } | null> {
  let lookup
  try {
    lookup = await fetchMwEntry(word, mwKey)
  } catch (err) {
    return { mwError: err }
  }
  if (!lookup.entries?.length) return null

  const senses = numberSenses(lookup.entries)
  if (!senses.length) return null

  const outcome = await judgeAndFormat({
    word,
    source: lookup.entries[0].source,
    senses,
    ctx,
    client,
    model,
    cacheableContext,
  })
  return outcome.ok ? { formatted: outcome.formatted } : { llmError: outcome.error }
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
  return { ok: true, formatted: formatDictionaryAnswer(word, source, selected) }
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

/** MW 요청 실패를 사람이 읽을 수 있는 메시지로 바꾼다. MW는 provider(LlmProvider)가
 *  아니라 classifyLlmError 대상이 아니고, 실측 확인(2026-07-28, 무효 키 직접 호출)한
 *  MW 특유의 함정도 있다 — 키가 무효해도 HTTP 200을 그대로 주고 본문에 "Invalid API
 *  key. Not subscribed for this reference." 같은 평문만 담아 보낸다(JSON 이 아니라
 *  파싱도 실패함). 이걸 구분 안 하면 죄다 "네트워크 오류"로 뭉뚱그려져 실제로는 키가
 *  잘못된 건데 사용자가 인터넷 연결을 의심하게 된다. */
function describeMwError(err: unknown): string {
  if (err instanceof MwHttpError) {
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
  return '네트워크 연결에 문제가 있어 사전 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

function notFoundResult(word: string, suggestions?: string[]): QuestionResult {
  const suggestion = suggestions?.length ? ` (제안: ${suggestions.slice(0, 5).join(', ')})` : ''
  return { kind: 'dictionary', content: `사전에서 "${word}"를 찾지 못했습니다.${suggestion}` }
}

function emit(onChunk: (chunk: QuestionResult) => void, result: QuestionResult): QuestionResult {
  onChunk(result)
  return result
}
