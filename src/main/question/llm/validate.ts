import type { LlmProvider, ProviderValidation } from '@shared/types'
import { ensureOk } from './sse'
import { classifyLlmError } from './errors'

// 담당 B — API 키 검증 & 사용 가능 모델 조회 (설정 화면)
//
// 각 provider 의 models 목록 GET 엔드포인트를 호출한다. 이 호출은 무과금이며(토큰 미소비),
// 401/403 이면 키 무효로 판정된다. 잔액/크레딧 조회 API 는 세 provider 모두 제공하지 않으므로
// 여기서는 다루지 않는다("사용 가능 여부"는 실제 질문 시 크레딧 에러로 안내).
//
// 채팅(생성)에 쓸 수 있는 모델만 남긴다:
//  - OpenAI: id 가 gpt- 로 시작 + 오디오/이미지/실시간 등 비채팅 계열 제외
//  - Gemini: supportedGenerationMethods 에 generateContent 포함 + gemini 계열
//  - Claude: /v1/models 가 반환하는 전부(모두 채팅 모델)

async function listOpenAiModels(key: string): Promise<string[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  })
  await ensureOk(res, 'GPT')
  const json = (await res.json()) as { data?: Array<{ id: string }> }
  const NON_CHAT =
    /(realtime|audio|image|transcribe|tts|search|embedding|moderation|whisper|dall|instruct)/
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id) => id.startsWith('gpt-') && !NON_CHAT.test(id))
    .sort()
}

async function listGeminiModels(key: string): Promise<string[]> {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': key },
  })
  await ensureOk(res, 'Gemini')
  const json = (await res.json()) as {
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>
  }
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((id) => id.startsWith('gemini'))
    .sort()
}

async function listClaudeModels(key: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  })
  await ensureOk(res, 'Claude')
  const json = (await res.json()) as { data?: Array<{ id: string }> }
  return (json.data ?? []).map((m) => m.id).sort()
}

const LISTERS: Record<LlmProvider, (key: string) => Promise<string[]>> = {
  gpt: listOpenAiModels,
  gemini: listGeminiModels,
  claude: listClaudeModels,
}

/** provider+키 검증 → 유효성 + 사용 가능 모델 목록. 실패는 QuestionErrorCode 로 분류(예외 미전파). */
export async function validateProvider(
  provider: LlmProvider,
  apiKey: string,
): Promise<ProviderValidation> {
  const key = apiKey.trim()
  if (!key) return { provider, ok: false, models: [], error: 'no_api_key' }
  try {
    const models = await LISTERS[provider](key)
    return { provider, ok: true, models }
  } catch (err) {
    return { provider, ok: false, models: [], error: classifyLlmError(err) }
  }
}
