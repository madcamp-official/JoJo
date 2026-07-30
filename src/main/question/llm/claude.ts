import type { LlmClient, LlmConfig, LlmRequest } from './adapter'
import { ensureOk, readSse } from './sse'

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

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 1024,
          // temperature 는 안 보낸다(2026-07-30) — 현재 모델이 이 파라미터 자체를
          // "deprecated for this model" 400 에러로 거부한다(실측: pronunciation/
          // dictionary 처럼 명시적 temperature 를 보내는 요청만 매번 실패, temperature
          // 를 아예 안 보내는 자유 질문은 정상 동작 — req.temperature 가 undefined 면
          // JSON.stringify 가 키 자체를 생략하는 걸로 실측 확인). classifyLlmError 가
          // 이 메시지의 "credit"/"quota" 키워드 부재로 'unknown'(원인불명 오류)으로
          // 뭉개서 크레딧 문제처럼 보였을 뿐, 실제로는 이 파라미터 문제였다.
          stream: true,
          system,
          messages: req.messages,
        }),
      })
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
