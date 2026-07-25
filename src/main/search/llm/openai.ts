import type { LlmClient, LlmConfig, LlmRequest } from './adapter'

// 담당 B — ChatGPT(OpenAI) 클라이언트.
// TODO([B-LLM-2]): Chat Completions API 스트리밍(SSE) 연동.
export function createOpenaiClient(config: LlmConfig): LlmClient {
  return {
    provider: 'openai',
    async stream(_req: LlmRequest, _onDelta: (delta: string) => void): Promise<string> {
      void config
      throw new Error('not implemented: openai.stream')
    },
  }
}
