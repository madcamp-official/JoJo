import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, readSse } from './sse'

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

      const systemText = req.cacheableContext
        ? `${req.system}\n\n[문맥]\n${req.cacheableContext}`
        : req.system

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
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
