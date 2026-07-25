import { setApiKey, getApiKey } from './keyStore'
import { setActiveProvider } from './question/llm/adapter'
import type { LlmProvider } from '@shared/types'

// 개발 전용 — .env(MAIN_VITE_*)에 넣어둔 키를 keyStore 에 seed 한다.
// keyStore 는 인메모리라 매 실행마다 다시 주입해야 하며, 프로덕션에서는 호출하지 않는다.
// .env 는 .gitignore 대상이므로 실제 키가 커밋되지 않는다.
export function seedApiKeysFromEnv(): void {
  // env 변수명은 하위 호환을 위해 MAIN_VITE_OPENAI_API_KEY 그대로 둔다(내부 LlmProvider 값만 'gpt').
  const envKeys: Record<LlmProvider, string | undefined> = {
    gpt: import.meta.env.MAIN_VITE_OPENAI_API_KEY,
    gemini: import.meta.env.MAIN_VITE_GEMINI_API_KEY,
    claude: import.meta.env.MAIN_VITE_CLAUDE_API_KEY,
  }

  for (const [provider, key] of Object.entries(envKeys) as [LlmProvider, string | undefined][]) {
    if (key && key.trim()) {
      setApiKey(provider, key.trim())
    }
  }

  // 활성 provider 지정(선택). 예: MAIN_VITE_ACTIVE_PROVIDER=gpt
  const active = import.meta.env.MAIN_VITE_ACTIVE_PROVIDER as LlmProvider | undefined
  if (active && getApiKey(active)) {
    setActiveProvider(active)
  }
}
