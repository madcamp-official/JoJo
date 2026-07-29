import type { LlmProvider, QuestionErrorCode, QuestionError, QuestionResult } from '@shared/types'
import { PROVIDERS } from '@shared/providers'

// 담당 B — 질문 파이프라인 에러 메시지 단일 출처 (PLAN.md §4.2)
// API 키 미설정/무효, 사용 한도(크레딧) 소진 등을 UI가 그대로 렌더링할 수 있는
// 완성된 한국어 문장으로 변환한다. 새 에러 종류를 추가하려면:
//   1. shared/types.ts 의 QuestionErrorCode 에 코드 추가
//   2. 아래 MESSAGES 에 해당 코드의 메시지를 채운다 (빠뜨리면 타입 에러로 드러남)

// provider 코드('gpt'/'gemini'/'claude')를 그대로 문장에 꽂으면 소문자로 보여
// 어색하다(예: "claude 계정의...") — PROVIDERS 의 표기명(GPT/Gemini/Claude)을 쓴다.
function providerLabel(p?: LlmProvider): string {
  return p ? PROVIDERS[p].label : 'LLM'
}

const MESSAGES: Record<QuestionErrorCode, (provider?: LlmProvider) => string> = {
  no_active_provider: () => '사용할 AI 모델이 설정되어 있지 않습니다. 설정에서 모델을 선택해 주세요.',
  no_api_key: (p) => `${providerLabel(p)} API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.`,
  invalid_api_key: (p) => `${providerLabel(p)} API 키가 유효하지 않습니다. 설정에서 키를 다시 확인해 주세요.`,
  insufficient_credit: (p) =>
    `${providerLabel(p)} 계정의 사용 한도(크레딧)가 부족합니다. 결제 정보를 확인해 주세요.`,
  rate_limited: (p) => `${providerLabel(p)} 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.`,
  invalid_model: (p) =>
    `설정에서 선택한 ${providerLabel(p)} 모델을 찾을 수 없습니다(단종되었거나 이름이 바뀌었을 수 있습니다). 설정에서 다른 모델을 선택해 주세요.`,
  network_error: () => '네트워크 연결에 문제가 있어 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  unknown: () => '알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
}

export function buildQuestionError(code: QuestionErrorCode, provider?: LlmProvider): QuestionError {
  return { code, provider, message: MESSAGES[code](provider) }
}

/** UI 로 바로 내려보낼 수 있는 실패 QuestionResult. content 에도 같은 메시지를 담아 최소 UI로도 표시 가능. */
export function buildErrorResult(
  kind: QuestionResult['kind'],
  code: QuestionErrorCode,
  provider?: LlmProvider,
): QuestionResult {
  const error = buildQuestionError(code, provider)
  return { kind, content: error.message, error }
}
