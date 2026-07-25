// 담당 B — 자주 쓰는 질문 저장소 (PLAN.md §4.2-3)
//
// ⚠️ 현재는 렌더러 localStorage 에 저장한다(데모/UI 완성용).
//    TODO(담당 B): 앱 설정 영속화(파일 저장) 항목과 통합 — main 프로세스에서
//    userData 경로에 저장하고 IPC 로 CRUD 하도록 이전.

const KEY = 'nuance.frequentQuestions'

/** PLAN §3 화면 구성 예시 기본값 */
const DEFAULTS: string[] = [
  '이 표현이 문맥 속에서 어떤 의미로 쓰였나요?',
  '이 표현의 문법적 역할은 무엇인가요?',
  '격식 있는/객관적인 표현인가요, 구어적인 표현인가요?',
]

export function loadFrequent(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return [...DEFAULTS]
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [...DEFAULTS]
  } catch {
    return [...DEFAULTS]
  }
}

export function saveFrequent(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // 저장 실패는 무시(용량 초과 등) — 다음 CRUD 시 재시도됨
  }
}
