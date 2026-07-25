import type { QuestionError } from '@shared/types'

// 담당 B — 팝업 채팅 메시지 (렌더 전용 뷰 모델)
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 스트리밍 진행 중이면 true (커서/타이핑 표시용) */
  streaming?: boolean
  /** 설정 시 이 메시지가 실패임을 뜻함 → 에러 배너로 렌더 */
  error?: QuestionError
}

export function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
