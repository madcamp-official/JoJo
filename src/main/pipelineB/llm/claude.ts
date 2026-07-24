import type { ChatTurn } from '@shared/types'
import type { LlmClient } from './adapter'

// 담당 B — Claude(Anthropic) 클라이언트. TODO: 실제 API 연동 + 스트리밍 + 프롬프트 캐싱.
export const claudeClient: LlmClient = {
  provider: 'claude',
  async stream(_messages: ChatTurn[], _onChunk) {
    throw new Error('not implemented: claude.stream')
  },
}
