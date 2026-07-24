import type { ChatTurn } from '@shared/types'
import type { LlmClient } from './adapter'

// 담당 B — ChatGPT(OpenAI) 클라이언트. TODO: 실제 API 연동 + 스트리밍.
export const openaiClient: LlmClient = {
  provider: 'openai',
  async stream(_messages: ChatTurn[], _onChunk) {
    throw new Error('not implemented: openai.stream')
  },
}
