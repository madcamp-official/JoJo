import type { QuestionResult, SelectionContext } from '@shared/types'
import { LANGUAGES } from '@shared/languages'
import { PRONUNCIATION_QUESTION } from '@shared/questionText'
import { renderPrompt } from './prompts/template'
import pronunciationPromptTemplate from './prompts/pronunciation.txt?raw'
import { streamLlm } from './llm/adapter'

// 담당 B — 발음 (PLAN.md §4.2-1)
// 영: IPA / 일: 히라가나 / 중: 한어병음. 맥락 의존 발음을 LLM 으로 판정.
// 예) read(현재/과거), 後(あと/ご/のち), 得(de/dé/děi)

// 형식이 고정된 판정 작업이라 낮은 temperature 로 응답 이탈(엉뚱한 토큰 삽입 등)을 줄인다.
const PRONUNCIATION_TEMPERATURE = 0.2

function buildPronunciationSystemPrompt(ctx: SelectionContext): string {
  const info = LANGUAGES[ctx.language]
  return renderPrompt(pronunciationPromptTemplate, {
    language: info.name,
    notation: info.pronunciationNotation,
  })
}

export async function getPronunciation(
  ctx: SelectionContext,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  return streamLlm(
    'pronunciation',
    ctx,
    buildPronunciationSystemPrompt(ctx),
    PRONUNCIATION_QUESTION,
    [],
    onChunk,
    PRONUNCIATION_TEMPERATURE,
  )
}
