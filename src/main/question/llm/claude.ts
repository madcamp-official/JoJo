import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, readSse, withTemperatureFallback } from './sse'

// 담당 B — Claude(Anthropic) 클라이언트 (Messages API 스트리밍 + 프롬프트 캐싱)
// https://docs.anthropic.com/en/api/messages-streaming
// 문맥 블록에 cache_control(ephemeral)을 붙여 반복 질문 시 비용을 절감한다.
export function createClaudeClient(config: LlmConfig): LlmClient {
  return {
    provider: 'claude',
    async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string> {
      const system: Array<Record<string, unknown>> = [{ type: 'text', text: req.system }]
      if (req.cacheableContext) {
        system.push({
          type: 'text',
          text: `[문맥]\n${req.cacheableContext}`,
          cache_control: { type: 'ephemeral' },
        })
      }

      const requestMessage = (includeTemperature: boolean): Promise<Response> =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.model,
            max_tokens: req.maxTokens ?? 1024,
            ...(includeTemperature ? { temperature: req.temperature } : {}),
            stream: true,
            system,
            messages: req.messages,
          }),
        })

      // 실측 확인(2026-07-30): claude-sonnet-5/claude-opus-5는 temperature를 "deprecated
      // for this model" 400 invalid_request_error로 거부하는데, claude-haiku-4-5는
      // 그대로 받아준다(GPT 5.6 세대 전체가 temperature를 거부하는 것과는 다르게, Claude는
      // 모델 등급별로 갈림) — 이 경우에만 temperature 없이 한 번 더 시도한다.
      const res = await withTemperatureFallback(
        requestMessage,
        (detail) => detail.includes('temperature') && detail.includes('deprecated'),
      )
      await ensureOk(res, 'Claude')

      let full = ''
      for await (const data of readSse(res)) {
        try {
          const json = JSON.parse(data)
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
            const delta: string = json.delta.text ?? ''
            if (delta) {
              full += delta
              onDelta(delta)
            }
          }
        } catch {
          /* 부분 청크 무시 */
        }
      }
      return full
    },
  }
}
