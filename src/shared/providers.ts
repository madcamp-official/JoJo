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
