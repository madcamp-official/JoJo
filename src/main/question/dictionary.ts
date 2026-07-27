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
  parseSelectedIndexes,
} from './dictionary/senseSelect'
import { buildContextBlock, createClient, getActiveProvider } from './llm/adapter'
import { classifyLlmError } from './llm/errors'
import { renderPrompt } from './prompts/template'
import dictionaryPromptTemplate from './prompts/dictionary.txt?raw'
import { buildErrorResult } from './errors'

// 담당 B — 사전 검색 (PLAN.md §4.2-2)
// en 은 MW → (TODO: OEWN → Wiktionary 폴백) 로 원어 뜻(sense) 후보를 모으고,
// 후보가 여럿이면 LLM 에 "문맥상 몇 번인지"만 판정시킨다. 채팅창에 보여줄 내용은
// LLM 의 원문 응답이 아니라, 그 판정 번호로 골라낸 사전 데이터를 그대로 서식화한 것
// — LLM 이 뜻풀이 텍스트를 다시 쓰거나 요약하지 않는다(원문 왜곡 방지).
// ja/zh 는 아직 소스 어댑터가 없어 스텁으로 남겨둔다.

const DICTIONARY_JUDGE_TEMPERATURE = 0.2
const DICTIONARY_JUDGE_MAX_TOKENS = 64

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

  // 뜻이 하나뿐이면 문맥 판정이 무의미하므로 LLM 호출 없이 바로 보여준다.
  if (senses.length <= 1) {
    return emit(onChunk, { kind: 'dictionary', content: formatDictionaryAnswer(headword, senses) })
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
    // 판정 전용 호출 — 델타를 onChunk 로 흘리지 않는다. 채팅창에 보일 최종 텍스트는
    // LLM 출력이 아니라 아래 formatDictionaryAnswer 가 사전 데이터로 직접 구성한다.
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

  const selectedIndexes = parseSelectedIndexes(reply, senses)
  const selected = senses.filter((s) => selectedIndexes.includes(s.index))

  return emit(onChunk, {
    kind: 'dictionary',
    content: formatDictionaryAnswer(headword, selected),
    meta: { provider, source: 'merriam-webster' },
  })
}

function emit(onChunk: (chunk: QuestionResult) => void, result: QuestionResult): QuestionResult {
  onChunk(result)
  return result
}
