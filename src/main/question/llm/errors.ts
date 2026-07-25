import type { QuestionErrorCode } from '@shared/types'

// 담당 B — LLM HTTP 에러 → QuestionErrorCode 분류 (PLAN.md §4.2)
// provider 마다 실제 에러 응답 형태가 다르므로(예: OpenAI 는 크레딧 소진도 429,
// Anthropic/Gemini 는 상태 코드 체계가 다름) 상태 코드를 우선 기준으로 삼고,
// 429 는 본문에 quota/credit/billing 키워드가 있으면 사용 한도 소진으로 재분류한다.
// 실제 서비스 중 관찰되는 응답에 맞춰 계속 다듬을 것.

export class LlmHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string,
  ) {
    super(message)
    this.name = 'LlmHttpError'
  }
}

const CREDIT_HINTS = ['quota', 'insufficient_quota', 'credit', 'billing']

export function classifyLlmError(err: unknown): QuestionErrorCode {
  if (err instanceof LlmHttpError) {
    const { status, body } = err
    const lower = body.toLowerCase()
    if (status === 401 || status === 403) return 'invalid_api_key'
    if (status === 402) return 'insufficient_credit'
    if (status === 429) {
      return CREDIT_HINTS.some((hint) => lower.includes(hint)) ? 'insufficient_credit' : 'rate_limited'
    }
    if (status >= 500) return 'network_error'
    return 'unknown'
  }
  // fetch 자체 실패(연결 불가 등)는 TypeError 로 던져진다.
  if (err instanceof TypeError) return 'network_error'
  return 'unknown'
}
