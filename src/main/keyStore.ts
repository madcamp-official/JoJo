import { safeStorage } from 'electron'
import type { LlmProvider } from '@shared/types'

// 담당 B — API 키 로컬 암호화 저장 (PLAN.md §5 보안).
// safeStorage 로 암호화하여 디스크에 저장, 외부로 전송하지 않는다.
// TODO: 암호문을 userData 경로의 json 파일로 영속화.

const store = new Map<LlmProvider, Buffer>()

export function setApiKey(provider: LlmProvider, plain: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('암호화 사용 불가')
  store.set(provider, safeStorage.encryptString(plain))
}

export function getApiKey(provider: LlmProvider): string | null {
  const enc = store.get(provider)
  return enc ? safeStorage.decryptString(enc) : null
}

export function deleteApiKey(provider: LlmProvider): void {
  store.delete(provider)
}
