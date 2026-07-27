import type { QuestionResult, SelectionContext } from '@shared/types'
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

const DICTIONARY_JUDGE_TEMPERATURE = 0.2
const DICTIONARY_JUDGE_MAX_TOKENS = 500

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

  if (!lookup.entries?.length) {
    const suggestion = lookup.suggestions?.length
      ? ` (제안: ${lookup.suggestions.slice(0, 5).join(', ')})`
      : ''
    return emit(onChunk, {
      kind: 'dictionary',
      content: `사전에서 "${word}"를 찾지 못했습니다.${suggestion}`,
    })
  }

  const senses = numberSenses(lookup.entries)
  const headword = lookup.entries[0].headword[0]
  const source = lookup.entries[0].source

  if (!senses.length) {
    return emit(onChunk, { kind: 'dictionary', content: `사전에서 "${word}"를 찾지 못했습니다.` })
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
  const system = renderPrompt(dictionaryPromptTemplate, { language: LANGUAGES[ctx.language].name })
  const prompt = `[선택된 표현]: ${word}\n\n[뜻풀이 후보]\n${buildSenseListText(senses)}`

  let reply: string
  try {
    // 판정+번역 전용 호출 — 델타를 onChunk 로 흘리지 않는다. 채팅창에 보일 최종 텍스트는
    // LLM 이 쓴 문장을 그대로 쓰는 게 아니라, 아래 formatDictionaryAnswer 가 그 번역
    // 결과와 사전 원본 데이터(품사·출처·활용형 등)를 조합해 직접 구성한다.
    reply = await client.stream(
      {
        system,
        cacheableContext: buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter),
        messages: [{ role: 'user', content: prompt }],
        model: settings.models[provider] || DEFAULT_MODELS[provider],
        maxTokens: DICTIONARY_JUDGE_MAX_TOKENS,
        temperature: DICTIONARY_JUDGE_TEMPERATURE,
      },
      () => {},
    )
  } catch (err) {
    return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(err), provider))
  }

  const selected = parseJudgeReply(reply, senses)

  return emit(onChunk, {
    kind: 'dictionary',
    content: formatDictionaryAnswer(headword, source, selected),
    meta: { provider, source },
  })
}

function emit(onChunk: (chunk: QuestionResult) => void, result: QuestionResult): QuestionResult {
  onChunk(result)
  return result
}
