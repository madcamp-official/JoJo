import type { QuestionResult, SelectionContext } from '@shared/types'
import { getLanguageName, getPronunciationNotation } from '@shared/languages'
import { PRONUNCIATION_QUESTION } from '@shared/questionText'
import { renderPrompt } from './prompts/template'
import pronunciationPromptTemplate from './prompts/pronunciation.txt?raw'
import { streamLlm } from './llm/adapter'

// 담당 B — 발음 (PLAN.md §4.2-1)
// 영: IPA / 일: 히라가나 / 중: 한어병음. 맥락 의존 발음을 LLM 으로 판정.
// 예) read(현재/과거), 後(あと/ご/のち), 得(de/dé/děi)
// tier2(2026-07-30 추가)는 사전 조회는 없지만 발음은 LLM 프롬프트만으로 되는 기능이라
// 그대로 지원한다 — 표기 체계는 전부 IPA로 통일(getPronunciationNotation).

// 형식이 고정된 판정 작업이라 낮은 temperature 로 응답 이탈(엉뚱한 토큰 삽입 등)을 줄인다.
const PRONUNCIATION_TEMPERATURE = 0.2

function buildPronunciationSystemPrompt(ctx: SelectionContext): string {
  return renderPrompt(pronunciationPromptTemplate, {
    language: getLanguageName(ctx.language),
    notation: getPronunciationNotation(ctx.language),
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
