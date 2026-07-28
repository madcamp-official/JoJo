import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, readSse } from './sse'

// 담당 B — GPT(OpenAI) 클라이언트 (Chat Completions 스트리밍)
// https://platform.openai.com/docs/api-reference/chat/streaming
export function createGptClient(config: LlmConfig): LlmClient {
  return {
    provider: 'gpt',
    async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string> {
      // 문맥은 system 메시지에 합쳐 전달(OpenAI 는 명시적 캐시 제어가 없어 prefix 재사용에 의존).
      const system = req.cacheableContext
        ? `${req.system}\n\n[문맥]\n${req.cacheableContext}`
        : req.system
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

      let res = await requestChatCompletion(true)
      if (!res.ok && res.status === 400) {
        const detail = await res.clone().text()
        // 실측 확인(2026-07-28, "gpt-5.6-sol"): 추론형(reasoning) 모델은 temperature 를
        // 기본값(1) 외로 못 받는다 — "Unsupported value: 'temperature' does not support
        // 0.2 with this model." 이 경우에만 temperature 없이 한 번 더 시도한다.
        if (detail.includes('temperature') && detail.includes('unsupported_value')) {
          res = await requestChatCompletion(false)
        }
      }
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
