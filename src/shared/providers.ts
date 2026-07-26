import type { LlmProvider } from './types'

// 공동 소유 — LLM provider 별 표기 데이터 단일 출처 (languages.ts와 동일 패턴).
// provider 를 추가하려면 types.ts 의 LlmProvider 유니온에 코드를 추가하고
// 아래 PROVIDERS 에 항목을 채운다 — 빠뜨리면 Record<LlmProvider, ...> 타입 에러로 드러난다.

export interface ProviderInfo {
  /** 설정 화면 등에 보여줄 표기명 */
  label: string
  /** 카드 UI에 쓰는 아이콘(이모지 placeholder — 추후 실제 로고로 교체 가능) */
  icon: string
}

export const PROVIDERS: Record<LlmProvider, ProviderInfo> = {
  gpt: { label: 'GPT', icon: '💬' },
  gemini: { label: 'Gemini', icon: '✨' },
  claude: { label: 'Claude', icon: '🤖' },
}

export const PROVIDER_ORDER: LlmProvider[] = ['gpt', 'gemini', 'claude']

/** provider 별 기본 모델. 설정 화면에서 사용자가 고르지 않으면 이 값이 쓰인다.
 *  gemini 는 'latest' 별칭을 써서 버전 번호 하드코딩으로 인한 404를 피한다
 *  (2026-07-25 실측: 'gemini-1.5-pro' 는 이미 404, 세대 교체가 잦음).
 *  main(adapter) 과 renderer(설정 화면) 가 함께 참조하는 단일 출처. */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gpt: 'gpt-4o',
  gemini: 'gemini-pro-latest',
  claude: 'claude-sonnet-5',
}
