import type { QuestionError } from '@shared/types'

// 담당 B — 팝업 채팅 메시지 (렌더 전용 뷰 모델)
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 스트리밍 진행 중이면 true (커서/타이핑 표시용) */
  streaming?: boolean
  /** 답변이 나오기 전까지만 보여줄 진행 상황 로그(사전 검색 단계별 안내, 2026-07-31) —
   *  main 이 meta.progress 청크로 한 줄씩 보내오는 걸 순서대로 쌓아 두고(dictionary.ts
   *  createProgressEmitter), 최종 결과가 도착하면 통째로 지운다. 답변 본문(content)과는
   *  완전히 별개라 최종 답변에 "검색 중…" 같은 문구가 섞이지 않는다. */
  progress?: string[]
  /** 설정 시 이 메시지가 실패임을 뜻함 → 에러 배너로 렌더 */
  error?: QuestionError
}

export function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
