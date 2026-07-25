import type { ChatTurn } from '@shared/types'
import type { LlmClient } from './adapter'

// 담당 B — GPT 클라이언트. TODO: 실제 API 연동 + 스트리밍.
export const gptClient: LlmClient = {
  provider: 'gpt',
  async stream(_messages: ChatTurn[], _onChunk) {
    throw new Error('not implemented: gpt.stream')
  },
}
