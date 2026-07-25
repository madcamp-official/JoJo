import type { LlmClient, LlmConfig, LlmRequest } from './adapter'

// 담당 B — Claude(Anthropic) 클라이언트.
// TODO([B-LLM-2]): Messages API 스트리밍 + 프롬프트 캐싱(cache_control) 연동.
export function createClaudeClient(config: LlmConfig): LlmClient {
  return {
    provider: 'claude',
    async stream(_req: LlmRequest, _onDelta: (delta: string) => void): Promise<string> {
      void config
      throw new Error('not implemented: claude.stream')
    },
  }
}
