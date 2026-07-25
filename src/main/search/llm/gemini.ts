import type { LlmClient, LlmConfig, LlmRequest } from './adapter'

// 담당 B — Gemini(Google) 클라이언트.
// TODO([B-LLM-2]): generateContent streaming API 연동.
export function createGeminiClient(config: LlmConfig): LlmClient {
  return {
    provider: 'gemini',
    async stream(_req: LlmRequest, _onDelta: (delta: string) => void): Promise<string> {
      void config
      throw new Error('not implemented: gemini.stream')
    },
  }
}
