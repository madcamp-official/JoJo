import type { ChatTurn, LlmProvider, SearchResult, SelectionContext } from '@shared/types'

// 담당 B — LLM 공통 어댑터 (PLAN.md §4.2 / §8)
// GPT / Gemini / Claude 를 동일 인터페이스로 추상화.
// 문맥(preceding/following)은 프롬프트 캐싱 대상.

export interface LlmClient {
  provider: LlmProvider
  stream(messages: ChatTurn[], onChunk: (text: string) => void): Promise<string>
}

// TODO(담당 B): provider 별 클라이언트 생성 (gpt/gemini/claude).
export function createClient(_provider: LlmProvider): LlmClient {
  throw new Error('not implemented: createClient')
}

export async function askLlm(
  ctx: SelectionContext,
  prompt: string,
  history: ChatTurn[],
  onChunk: (chunk: SearchResult) => void,
): Promise<SearchResult> {
  // TODO(담당 B):
  //  1) 시스템 프롬프트 + 문맥(캐싱) + history + prompt 구성
  //  2) 선택 provider 로 스트리밍 → onChunk 로 중계
  void ctx
  void prompt
  void history
  void onChunk
  return { kind: 'ask', content: '' }
}
