import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// 담당 B — 자주 쓰는 질문 영속화 (PLAN.md §3/§4.2-3)
// userData/frequent.json 에 문자열 배열로 저장한다(민감정보 없음 — 평문 JSON).
// 설정(settingsStore)·API 키(keyStore)와 동일하게 userData 경로에 두어 앱 재시작·재설치 후에도 유지된다.

/** PLAN §3 화면 구성 예시 기본값 */
const DEFAULTS: string[] = [
  '이 표현이 문맥 속에서 어떤 의미로 쓰였나요?',
  '이 표현의 문법적 역할은 무엇인가요?',
  '격식 있는/객관적인 표현인가요, 구어적인 표현인가요?',
]

function filePath(): string {
  return join(app.getPath('userData'), 'frequent.json')
}

let cached: string[] | null = null

/** 디스크에서 로드(없으면 기본값)하고 캐시한다. */
export function loadFrequent(): string[] {
  if (cached) return cached
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    cached = Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [...DEFAULTS]
  } catch {
    cached = [...DEFAULTS]
  }
  return cached
}

export function getFrequent(): string[] {
  return loadFrequent()
}

export function setFrequent(list: string[]): string[] {
  const next = list.filter((x) => typeof x === 'string')
  cached = next
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
