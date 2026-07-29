import type { ChatTurn, LlmProvider, QuestionResult, SelectionContext } from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { getSettings } from '@main/settingsStore'
import { computeContextRange } from '@shared/context'
import { createGptClient } from './gpt'
import { createGeminiClient } from './gemini'
import { createClaudeClient } from './claude'
import { renderPrompt } from '../prompts/template'
import systemPromptTemplate from '../prompts/system.txt?raw'
import { getLanguageName } from '@shared/languages'
import { DEFAULT_MODELS } from '@shared/providers'
import { buildErrorResult } from '../errors'
import { classifyLlmError } from './errors'

// ============================================================================
// 담당 B — LLM 공통 어댑터 (PLAN.md §5.2 / §9)
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
  /** 샘플링 온도. 미지정 시 provider 기본값(대개 1) 적용. 형식이 고정된 판정 작업은 낮게 지정해 이탈을 줄인다. */
  temperature?: number
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
  return renderPrompt(systemPromptTemplate, { language: getLanguageName(ctx.language) })
}

/**
 * 앞 문맥 / 선택된 표현 / 뒤 문맥을 라벨로 구분한 문맥 블록. 프롬프트 캐싱 대상.
 * 앞 byteBefore / 뒤 byteAfter 바이트를 포함하되, 순수 바이트 경계에서 문장이 잘리지
 * 않도록 문장 경계까지 확장한다(설정 화면 미리보기와 동일한 @shared/context 로직).
 * 원문 안에 인라인 마커 문자를 끼워 넣지 않고 세 섹션으로 분리해서, 마커로 쓸 문자가
 * 우연히 원문에 이미 등장해 선택 표시와 헷갈릴 가능성 자체를 없앤다.
 */
export function buildContextBlock(
  ctx: SelectionContext,
  byteBefore: number,
  byteAfter: number,
): string {
  const r = computeContextRange(ctx.fullText, ctx.selStart, ctx.selEnd, byteBefore, byteAfter)
  const before = ctx.fullText.slice(r.extStart, ctx.selStart)
  const after = ctx.fullText.slice(ctx.selEnd, r.extEnd)
  return `[앞 문맥]\n${before}\n\n[선택된 표현]\n${ctx.selectedText}\n\n[뒤 문맥]\n${after}`
}

// ---- 공통 스트리밍 진입점 ------------------------------------------------------
// 'ask'(통합 질문)와 'pronunciation'(발음) 등 문맥 기반 LLM 요청이 공유하는 오케스트레이션.
// system 프롬프트와 사용자 메시지만 호출부에서 다르게 넣으면 된다.

export async function streamLlm(
  kind: QuestionResult['kind'],
  ctx: SelectionContext,
  system: string,
  prompt: string,
  history: ChatTurn[],
  onChunk: (chunk: QuestionResult) => void,
  temperature?: number,
): Promise<QuestionResult> {
  const provider = getActiveProvider()

  if (!provider) {
    const result = buildErrorResult(kind, 'no_active_provider')
    onChunk(result)
    return result
  }

  const apiKey = getApiKey(provider)

  if (!apiKey) {
    const result = buildErrorResult(kind, 'no_api_key', provider)
    onChunk(result)
    return result
  }

  const client = createClient(provider, { apiKey })
  const settings = getSettings()
  const req: LlmRequest = {
    system,
    cacheableContext: buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter),
    messages: [...history, { role: 'user', content: prompt }],
    // "Default" 옵션 선택 시 설정 화면이 빈 문자열을 저장하는데(SettingsScreen.tsx),
    // ??(nullish) 는 빈 문자열을 값 있음으로 취급해 API에 model:"" 로 요청이 나가버린다
    // — || 로 falsy(빈 문자열 포함)일 때도 기본 모델로 대체한다.
    model: settings.models[provider] || DEFAULT_MODELS[provider],
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature,
  }

  try {
    // 델타를 그대로 스트리밍(렌더러가 append), 최종 전체 텍스트를 반환한다.
    const full = await client.stream(req, (delta) => {
      onChunk({ kind, content: delta, meta: { provider, streaming: true } })
    })
    return { kind, content: full, meta: { provider } }
  } catch (err) {
    // API 키 무효, 사용 한도(크레딧) 소진, 요청 과다, 네트워크 오류 등을 UI가 구분할 수 있는
    // QuestionErrorCode 로 분류해 반환한다. 예외를 그대로 흘려보내 IPC 를 실패시키지 않는다.
    const result = buildErrorResult(kind, classifyLlmError(err), provider)
    onChunk(result)
    return result
  }
}

// ---- 통합 질문 진입점 --------------------------------------------------------

export async function askLlm(
  ctx: SelectionContext,
  prompt: string,
  history: ChatTurn[],
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  return streamLlm('ask', ctx, buildSystemPrompt(ctx), prompt, history, onChunk)
}
