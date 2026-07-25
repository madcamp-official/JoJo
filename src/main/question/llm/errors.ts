import type { QuestionErrorCode } from '@shared/types'

// 담당 B — LLM HTTP 에러 → QuestionErrorCode 분류 (PLAN.md §4.2)
// provider 마다 실제 에러 응답 형태가 다르므로 상태 코드를 우선 기준으로 삼고,
// 크레딧 소진처럼 provider 마다 다른 상태코드로 오는 경우는 본문 키워드로 재분류한다.
// 실측(2026-07-25):
//  - OpenAI  크레딧 소진 → 429 + "quota"
//  - Gemini  크레딧 소진 → 429 + "quota"/"billing" (RESOURCE_EXHAUSTED)
//  - Claude  크레딧 소진 → 400(!) invalid_request_error + "credit balance is too low"
//            (402 를 쓰지 않으므로 402 단독 판별에 기대면 안 됨)

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
const hasCreditHint = (lower: string): boolean => CREDIT_HINTS.some((hint) => lower.includes(hint))

export function classifyLlmError(err: unknown): QuestionErrorCode {
  if (err instanceof LlmHttpError) {
    const { status, body } = err
    const lower = body.toLowerCase()
    if (status === 401 || status === 403) return 'invalid_api_key'
    if (status === 402) return 'insufficient_credit'
    // Claude 는 크레딧 소진도 400(invalid_request_error)으로 온다. 다른 400은 대부분
    // 요청 형식 오류라 무조건 insufficient_credit 으로 단정하지 않고 키워드로만 구분한다.
    if (status === 400 && hasCreditHint(lower)) return 'insufficient_credit'
    if (status === 429) {
      return hasCreditHint(lower) ? 'insufficient_credit' : 'rate_limited'
    }
    if (status >= 500) return 'network_error'
    return 'unknown'
  }
  // fetch 자체 실패(연결 불가 등)는 TypeError 로 던져진다.
  if (err instanceof TypeError) return 'network_error'
  return 'unknown'
}
