import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiKeyId } from '@shared/types'

// 담당 B — API 키 로컬 암호화 저장 (PLAN.md §6 보안).
// safeStorage 로 암호화한 뒤 base64 문자열로 userData/apikeys.json 에 영속화한다.
// 평문은 디스크에 남지 않으며, 외부로 전송하지 않는다.

const store = new Map<ApiKeyId, Buffer>()
let loaded = false

function filePath(): string {
  return join(app.getPath('userData'), 'apikeys.json')
}

/** 최초 호출 시 1회 디스크에서 로드(파일 없으면 빈 상태 유지). */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    const json = JSON.parse(raw) as Partial<Record<ApiKeyId, string>>
    for (const [provider, b64] of Object.entries(json) as [ApiKeyId, string | undefined][]) {
      if (b64) store.set(provider, Buffer.from(b64, 'base64'))
    }
  } catch {
    /* 최초 실행 등 파일이 없으면 무시 */
  }
}

function persist(): void {
  const json: Partial<Record<ApiKeyId, string>> = {}
  for (const [provider, buf] of store) {
    json[provider] = buf.toString('base64')
  }
  writeFileSync(filePath(), JSON.stringify(json), 'utf-8')
}

export function setApiKey(provider: ApiKeyId, plain: string): void {
  ensureLoaded()
  if (!safeStorage.isEncryptionAvailable()) throw new Error('암호화 사용 불가')
  store.set(provider, safeStorage.encryptString(plain))
  persist()
}

export function getApiKey(provider: ApiKeyId): string | null {
  ensureLoaded()
  const enc = store.get(provider)
  return enc ? safeStorage.decryptString(enc) : null
}

export function deleteApiKey(provider: ApiKeyId): void {
  ensureLoaded()
  store.delete(provider)
  persist()
}
