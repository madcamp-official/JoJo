import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, readSse } from './sse'

// 담당 B — ChatGPT(OpenAI) 클라이언트 (Chat Completions 스트리밍)
// https://platform.openai.com/docs/api-reference/chat/streaming
export function createOpenaiClient(config: LlmConfig): LlmClient {
  return {
    provider: 'openai',
    async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string> {
      // 문맥은 system 메시지에 합쳐 전달(OpenAI 는 명시적 캐시 제어가 없어 prefix 재사용에 의존).
      const system = req.cacheableContext
        ? `${req.system}\n\n[문맥]\n${req.cacheableContext}`
        : req.system

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: [{ role: 'system', content: system }, ...req.messages],
        }),
      })
      await ensureOk(res, 'OpenAI')

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
