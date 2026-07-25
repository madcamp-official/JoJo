import type { ChatTurn, LlmProvider, QuestionResult, SelectionContext } from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { getSettings } from '@main/settingsStore'
import { buildContextText } from '@shared/context'
import { createGptClient } from './gpt'
import { createGeminiClient } from './gemini'
import { createClaudeClient } from './claude'
import { renderPrompt } from '../prompts/template'
import systemPromptTemplate from '../prompts/system.txt?raw'
import { LANGUAGES } from '@shared/languages'
import { buildErrorResult } from '../errors'
import { classifyLlmError } from './errors'

// ============================================================================
// 담당 B — LLM 공통 어댑터 (PLAN.md §4.2 / §7)
// GPT / Gemini / Claude 를 동일 인터페이스로 추상화한다.
//  - 이 파일: provider 추상화 + 문맥 프롬프트 구성 + 스트리밍 오케스트레이션
//  - 각 provider 의 실제 API 호출/스트리밍은 ./gpt|gemini|claude 가 담당(다음 항목)
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

/** provider 별 기본 모델. 설정에서 재정의 가능(추후 설정 영속화 항목).
 *  gemini 는 'latest' 별칭을 써서 버전 번호 하드코딩으로 인한 404를 피한다
 *  (2026-07-25 실측: 'gemini-1.5-pro' 는 이미 404, 세대 교체가 잦음). */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gpt: 'gpt-4o',
  gemini: 'gemini-pro-latest',
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
    case 'gpt':
      return createGptClient(config)
    case 'gemini':
      return createGeminiClient(config)
    case 'claude':
      return createClaudeClient(config)
  }
}

// ---- 문맥 기반 프롬프트 구성 --------------------------------------------------
// 언어별 표기(이름 등)는 @shared/languages 에서 관리(언어 확장 시 그쪽만 수정).

export function buildSystemPrompt(ctx: SelectionContext): string {
  return renderPrompt(systemPromptTemplate, { language: LANGUAGES[ctx.language].name })
}

/**
 * 선택 표현을 ⟦⟧ 로 표시한 근방 문맥 블록. 프롬프트 캐싱 대상.
 * 앞 byteBefore / 뒤 byteAfter 바이트를 포함하되, 순수 바이트 경계에서 문장이 잘리지
 * 않도록 문장 경계까지 확장한다(설정 화면 미리보기와 동일한 @shared/context 로직).
 */
export function buildContextBlock(
  ctx: SelectionContext,
  byteBefore: number,
  byteAfter: number,
): string {
  const full = `${ctx.precedingText}${ctx.selectedText}${ctx.followingText}`
  const selStart = ctx.precedingText.length
  const selEnd = selStart + ctx.selectedText.length
  return buildContextText(full, selStart, selEnd, byteBefore, byteAfter, (s) => `⟦${s}⟧`)
}

export function buildRequest(
  ctx: SelectionContext,
  prompt: string,
  history: ChatTurn[],
  provider: LlmProvider,
  byteBefore: number,
  byteAfter: number,
): LlmRequest {
  return {
    system: buildSystemPrompt(ctx),
    cacheableContext: buildContextBlock(ctx, byteBefore, byteAfter),
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
    const result = buildErrorResult('ask', 'no_active_provider')
    onChunk(result)
    return result
  }

  const apiKey = getApiKey(provider)

  if (!apiKey) {
    const result = buildErrorResult('ask', 'no_api_key', provider)
    onChunk(result)
    return result
  }

  const client = createClient(provider, { apiKey })
  const settings = getSettings()
  const req = buildRequest(
    ctx,
    prompt,
    history,
    provider,
    settings.contextBytesBefore,
    settings.contextBytesAfter,
  )

  try {
    // 델타를 그대로 스트리밍(렌더러가 append), 최종 전체 텍스트를 반환한다.
    const full = await client.stream(req, (delta) => {
      onChunk({ kind: 'ask', content: delta, meta: { provider, streaming: true } })
    })
    return { kind: 'ask', content: full, meta: { provider } }
  } catch (err) {
    // API 키 무효, 사용 한도(크레딧) 소진, 요청 과다, 네트워크 오류 등을 UI가 구분할 수 있는
    // QuestionErrorCode 로 분류해 반환한다. 예외를 그대로 흘려보내 IPC 를 실패시키지 않는다.
    const result = buildErrorResult('ask', classifyLlmError(err), provider)
    onChunk(result)
    return result
  }
}
