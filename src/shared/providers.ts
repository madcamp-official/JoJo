import type { LlmProvider } from './types'

// 공동 소유 — LLM provider 별 표기 데이터 단일 출처 (languages.ts와 동일 패턴).
// provider 를 추가하려면 types.ts 의 LlmProvider 유니온에 코드를 추가하고
// 아래 PROVIDERS 에 항목을 채운다 — 빠뜨리면 Record<LlmProvider, ...> 타입 에러로 드러난다.

export interface ProviderInfo {
  /** 설정 화면 등에 보여줄 표기명 */
  label: string
  /** 카드 UI에 쓰는 아이콘(이모지 placeholder — 추후 실제 로고로 교체 가능) */
  icon: string
  /** API 키 발급 페이지 URL — 설정 화면의 "발급받기" 링크가 새 창(외부 브라우저)으로 연다. */
  signupUrl: string
}

export const PROVIDERS: Record<LlmProvider, ProviderInfo> = {
  gpt: { label: 'GPT', icon: '💬', signupUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini', icon: '✨', signupUrl: 'https://aistudio.google.com/app/apikey' },
  claude: { label: 'Claude', icon: '🤖', signupUrl: 'https://console.anthropic.com/settings/keys' },
}

export const PROVIDER_ORDER: LlmProvider[] = ['gpt', 'gemini', 'claude']

/** provider 별 기본 모델. 설정 화면에서 사용자가 고르지 않으면 이 값이 쓰인다.
 *  gemini 는 'latest' 별칭을 써서 버전 번호 하드코딩으로 인한 404를 피한다
 *  (2026-07-25 실측: 'gemini-1.5-pro' 는 이미 404, 세대 교체가 잦음).
 *  main(adapter) 과 renderer(설정 화면) 가 함께 참조하는 단일 출처.
 *
 *  **2026-07-28 정정**: 세 provider 모두 "프론티어(가장 비싸고 강력한) 티어"가 아니라
 *  "가격-성능 중간 티어"로 맞춤 — 이 필드는 사용자가 드롭다운에서 직접 고르지 않았을 때만
 *  쓰이는 fallback이라, 여기 프론티어 모델을 박아두면 사용자가 모르고 고가 모델을 계속
 *  호출하게 될 위험이 있고, 이 앱의 실제 호출(발음 판정/사전 서식화/짧은 질답)도 그 정도
 *  성능이 굳이 필요하지 않다. gpt: 프론티어 Sol/저가 Luna 사이의 중간 티어 Terra.
 *  gemini: 프론티어 Pro 대신 가격-성능 중간 Flash. claude: Opus(프론티어)/Haiku(초저가)
 *  사이의 중간 티어 Sonnet — 이미 이 값이었으므로 변경 없음. */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gpt: 'gpt-5.6-terra',
  gemini: 'gemini-flash-latest',
  claude: 'claude-sonnet-5',
}
