import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, mergeSystemWithContext, readSse } from './sse'

// 담당 B — Gemini(Google) 클라이언트 (streamGenerateContent, SSE)
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
export function createGeminiClient(config: LlmConfig): LlmClient {
  return {
    provider: 'gemini',
    async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string> {
      // Gemini 는 role 이 'user' | 'model'. assistant → model 로 매핑.
      const contents = req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

      const systemText = mergeSystemWithContext(req.system, req.cacheableContext)

      // 키는 URL 쿼리 대신 헤더로 전달(로깅 유출 방지).
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${req.model}:streamGenerateContent?alt=sse`

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          generationConfig:
            req.temperature !== undefined ? { temperature: req.temperature } : undefined,
        }),
      })
      await ensureOk(res, 'Gemini')

      let full = ''
      for await (const data of readSse(res)) {
        try {
          const json = JSON.parse(data)
          const parts: Array<{ text?: string }> = json.candidates?.[0]?.content?.parts ?? []
          for (const p of parts) {
            if (p.text) {
              full += p.text
              onDelta(p.text)
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
