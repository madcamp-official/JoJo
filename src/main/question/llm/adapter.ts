import type { ChatTurn, LlmProvider, QuestionResult, SelectionContext } from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { createOpenaiClient } from './openai'
import { createGeminiClient } from './gemini'
import { createClaudeClient } from './claude'

// ============================================================================
// 담당 B — LLM 공통 어댑터 (PLAN.md §4.2 / §7)
// ChatGPT / Gemini / Claude 를 동일 인터페이스로 추상화한다.
//  - 이 파일: provider 추상화 + 문맥 프롬프트 구성 + 스트리밍 오케스트레이션
//  - 각 provider 의 실제 API 호출/스트리밍은 ./openai|gemini|claude 가 담당(다음 항목)
// ============================================================================

/** provider 로 넘길 요청 (provider 중립 표현). 생성 파라미터(model·maxTokens)의 단일 출처. */
export interface LlmRequest {
  system: string
  /** 선택 근방 문맥. provider 별 프롬프트 캐싱 대상(비용 절감). */
  cacheableContext?: string
  messages: ChatTurn[]
  /** 사용할 모델. 각 provider 클라이언트가 이 값을 그대로 사용한다. */
  model: string
  /** 응답 최대 토큰. 미지정 시 provider 클라이언트 기본값 적용. */
  maxTokens?: number
}

/** provider 클라이언트 생성 설정 (인증 정보만). 모델·토큰 등 생성 파라미터는 LlmRequest 로. */
export interface LlmConfig {
  apiKey: string
}

/** provider 공통 클라이언트 인터페이스 */
export interface LlmClient {
  provider: LlmProvider
  /** 델타(증분) 텍스트를 onDelta 로 흘리고, 최종 전체 텍스트를 반환한다. */
  stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<string>
}

/** provider 별 기본 모델. 설정에서 재정의 가능(추후 설정 영속화 항목). */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o',
  gemini: 'gemini-1.5-pro',
  claude: 'claude-sonnet-5',
}

/** 응답 최대 토큰 기본값. 추후 설정 영속화([B-UI])와 연결. */
export const DEFAULT_MAX_TOKENS = 1024

// 활성 provider — 추후 설정 영속화([B-UI])와 연결. 그전까진 인메모리.
// 기본값 없음: 사용자가 명시적으로 지정하기 전까지는 진행하지 않는다.
let activeProvider: LlmProvider | null = null
export function getActiveProvider(): LlmProvider | null {
  return activeProvider
}
export function setActiveProvider(p: LlmProvider): void {
  activeProvider = p
}

/** provider 추상화 팩토리 */
export function createClient(provider: LlmProvider, config: LlmConfig): LlmClient {
  switch (provider) {
    case 'openai':
      return createOpenaiClient(config)
    case 'gemini':
      return createGeminiClient(config)
    case 'claude':
      return createClaudeClient(config)
  }
}

// ---- 문맥 기반 프롬프트 구성 --------------------------------------------------

const LANG_NAME: Record<SelectionContext['language'], string> = {
  en: '영어',
  ja: '일본어',
  zh: '중국어',
}

export function buildSystemPrompt(ctx: SelectionContext): string {
  const lang = LANG_NAME[ctx.language]
  return [
    `당신은 한국어 모어 화자가 ${lang} 콘텐츠를 이해하도록 돕는 언어 학습 어시스턴트입니다.`,
    `사용자가 선택한 표현을 그 문맥 안에서 해석해 주세요.`,
    `답변은 한국어로, 간결하고 정확하게 작성합니다.`,
  ].join(' ')
}

/** 선택 표현을 ⟦⟧ 로 표시한 근방 문맥 블록. 프롬프트 캐싱 대상. */
export function buildContextBlock(ctx: SelectionContext): string {
  return `${ctx.precedingText}⟦${ctx.selectedText}⟧${ctx.followingText}`
}

export function buildRequest(
  ctx: SelectionContext,
  prompt: string,
  history: ChatTurn[],
  provider: LlmProvider,
): LlmRequest {
  return {
    system: buildSystemPrompt(ctx),
    cacheableContext: buildContextBlock(ctx),
    messages: [...history, { role: 'user', content: prompt }],
    model: DEFAULT_MODELS[provider],
    maxTokens: DEFAULT_MAX_TOKENS,
  }
}

// ---- 통합 질문 진입점 --------------------------------------------------------

export async function askLlm(
  ctx: SelectionContext,
  prompt: string,
  history: ChatTurn[],
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  const provider = getActiveProvider()

  if (!provider) {
    const content = `사용할 LLM provider 가 지정되지 않았습니다. 설정에서 provider 를 선택해 주세요.`
    onChunk({ kind: 'ask', content, meta: { error: 'no_active_provider' } })
    return { kind: 'ask', content, meta: { error: 'no_active_provider' } }
  }

  const apiKey = getApiKey(provider)

  if (!apiKey) {
    const content = `${provider} API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.`
    onChunk({ kind: 'ask', content, meta: { error: 'no_api_key', provider } })
    return { kind: 'ask', content, meta: { error: 'no_api_key', provider } }
  }

  const client = createClient(provider, { apiKey })
  const req = buildRequest(ctx, prompt, history, provider)

  // 델타를 그대로 스트리밍(렌더러가 append), 최종 전체 텍스트를 반환한다.
  const full = await client.stream(req, (delta) => {
    onChunk({ kind: 'ask', content: delta, meta: { provider, streaming: true } })
  })
  return { kind: 'ask', content: full, meta: { provider } }
}
