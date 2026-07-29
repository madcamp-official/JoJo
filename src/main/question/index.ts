import type { QuestionRequest, QuestionResult, SelectionContext } from '@shared/types'
import { getPronunciation } from './pronunciation'
import { lookupDictionary } from './dictionary'
import { askLlm } from './llm/adapter'

// ============================================================================
// 담당 B — 질문 & AI 파이프라인 (PLAN.md §5.2 / §9)
// SelectionContext 를 받아 발음/사전/통합질문을 처리하고
// QuestionResult 를 (스트리밍으로) 반환한다.
// ============================================================================

export async function runQuestion(
  ctx: SelectionContext,
  req: QuestionRequest,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  switch (req.type) {
    case 'pronunciation':
      return getPronunciation(ctx, onChunk)
    case 'dictionary':
      return lookupDictionary(ctx, req.source, onChunk)
    case 'ask':
      return askLlm(ctx, req.prompt, req.history ?? [], onChunk)
  }
}
