import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, mergeSystemWithContext, readSse, withTemperatureFallback } from './sse'

// 담당 B — GPT(OpenAI) 클라이언트 (Chat Completions 스트리밍)
// https://platform.openai.com/docs/api-reference/chat/streaming
export function createGptClient(config: LlmConfig): LlmClient {
  return {
    provider: 'gpt',
    async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string> {
      // 문맥은 system 메시지에 합쳐 전달(OpenAI 는 명시적 캐시 제어가 없어 prefix 재사용에 의존).
      const system = mergeSystemWithContext(req.system, req.cacheableContext)
      const messages = [{ role: 'system', content: system }, ...req.messages]

      const requestChatCompletion = (includeTemperature: boolean): Promise<Response> =>
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.model,
            stream: true,
            ...(includeTemperature ? { temperature: req.temperature } : {}),
            messages,
          }),
        })

      // 실측 확인(2026-07-28 "gpt-5.6-sol", 2026-07-30 재확인 — terra/luna도 동일):
      // 추론형(sol)뿐 아니라 지금은 GPT 5.6 세대 전체(terra/luna 포함)가 temperature
      // 기본값(1) 외를 거부한다 — "Unsupported value: 'temperature' does not support
      // 0.2 with this model." 이 경우에만 temperature 없이 한 번 더 시도한다.
      const res = await withTemperatureFallback(
        requestChatCompletion,
        (detail) => detail.includes('temperature') && detail.includes('unsupported_value'),
      )
      await ensureOk(res, 'GPT')

      let full = ''
      for await (const data of readSse(res)) {
        if (data === '[DONE]') break
        try {
          const json = JSON.parse(data)
          const delta: string = json.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            full += delta
            onDelta(delta)
          }
        } catch {
          /* 부분 청크 무시 */
        }
      }
      return full
    },
  }
}
