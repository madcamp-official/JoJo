import type { SearchRequest, SearchResult, SelectionContext } from '@shared/types'
import { getPronunciation } from './pronunciation'
import { lookupDictionary } from './dictionary'
import { askLlm } from './llm/adapter'

// ============================================================================
// 담당 B — 검색 & AI 파이프라인 (PLAN.md §4.2 / §8)
// SelectionContext 를 받아 발음/사전/통합질문을 처리하고
// SearchResult 를 (스트리밍으로) 반환한다.
// ============================================================================

export async function runSearch(
  ctx: SelectionContext,
  req: SearchRequest,
  onChunk: (chunk: SearchResult) => void,
): Promise<SearchResult> {
  switch (req.type) {
    case 'pronunciation':
      return getPronunciation(ctx, onChunk)
    case 'dictionary':
      return lookupDictionary(ctx, onChunk)
    case 'ask':
      return askLlm(ctx, req.prompt, req.history ?? [], onChunk)
  }
}
