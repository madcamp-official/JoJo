import type { DictionaryKeyValidation } from '@shared/types'

// 담당 B — Merriam-Webster 키 유효성 검사 (PLAN.md §5)
// LLM provider들과 달리 MW 는 무과금 전용 검증 엔드포인트가 없어(모델 목록 조회 같은
// 부가 엔드포인트 부재), 실제 사전 조회 1건("test" 표제어, 항상 존재)으로 확인한다 —
// 일일 1,000회 한도 중 1회를 소비하지만 무시할 수준.
// 이 엔드포인트가 바로 Collegiate 전용이라, Learner's 등 다른 사전으로만 등록된 키를
// 넣으면 이 확인에서 자연스럽게 무효로 걸러진다(설정 화면 안내 문구의 "Collegiate로
// 발급받아야 한다"는 요구사항이 검증 단계에서도 그대로 강제됨).
//
// 무효 키는 HTTP 상태코드가 200 그대로 오고, 본문이 JSON 배열이 아니라
// "Invalid API key. Not subscribed for this reference." 같은 평문 문자열로 온다
// (실측 확인) — 상태 코드로는 구분 불가능해서 응답이 유효한 JSON 배열인지로 판별한다.

const MW_TEST_WORD = 'test'

export async function validateMwKey(apiKey: string): Promise<DictionaryKeyValidation> {
  try {
    const res = await fetch(
      `https://dictionaryapi.com/api/v3/references/collegiate/json/${MW_TEST_WORD}?key=${encodeURIComponent(apiKey)}`,
    )
    if (!res.ok) return { ok: false, error: 'network_error' }
    const body: unknown = await res.json().catch(() => null)
    if (!Array.isArray(body) || body.length === 0) return { ok: false, error: 'invalid_api_key' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}
