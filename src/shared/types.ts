// ============================================================================
// 공동 소유 (담당 A ↔ 담당 B 인터페이스 계약) — PLAN.md §7
// A(선택/추출)가 SelectionContext 를 생성해 B(질문/AI)로 넘기고,
// B 는 QuestionResult 를 UI 로 반환한다. 이 파일은 양측이 함께 관리한다.
// ============================================================================

export type Language = 'en' | 'ja' | 'zh'

/** 창 선택 UI에 보여줄 캡처 가능 창 1개 (담당 A) */
export interface CaptureSource {
  id: string
  name: string
  thumbnail: string // dataURL
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 화면상 단어 1개 + (가능하면) 좌표 */
export interface Word {
  text: string
  bbox?: Rect
}

export type SourceKind =
  | 'youtube'
  | 'netflix'
  | 'pdf'
  | 'txt'
  | 'epub'
  | 'web'
  | 'ocr'

export interface SelectionSource {
  kind: SourceKind
  url?: string
  appName?: string
}

/** A → B : 사용자가 확정한 선택 + 문맥 */
export interface SelectionContext {
  selectedText: string
  language: Language
  precedingText: string
  followingText: string
  words: Word[]
  source: SelectionSource
  extraction: 'direct' | 'ocr'
}

// ---- 질문 요청/응답 ----------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export type QuestionRequest =
  | { type: 'pronunciation' }
  | { type: 'dictionary' }
  | { type: 'ask'; prompt: string; history?: ChatTurn[] }

/** API 키 미설정/무효, 사용 한도(크레딧) 소진 등 UI가 구분해 안내해야 하는 실패 종류 */
export type QuestionErrorCode =
  | 'no_active_provider'
  | 'no_api_key'
  | 'invalid_api_key'
  | 'insufficient_credit'
  | 'rate_limited'
  | 'network_error'
  | 'unknown'

export interface QuestionError {
  code: QuestionErrorCode
  /** 렌더링용 한국어 메시지(이미 완성된 문장) */
  message: string
  provider?: LlmProvider
}

/** B → UI : 스트리밍 가능한 질문 결과 */
export interface QuestionResult {
  kind: 'pronunciation' | 'dictionary' | 'ask'
  content: string
  /** 설정된 경우, 이 결과가 실패임을 뜻함. UI는 이 필드 유무로 성공/실패를 구분한다. */
  error?: QuestionError
  meta?: Record<string, unknown>
}

// ---- 앱 모드/설정 -----------------------------------------------------------

export type AppMode = 'normal' | 'select'

export type LlmProvider = 'gpt' | 'gemini' | 'claude'

export interface AppSettings {
  llm: LlmProvider
  language: Language | 'auto'
  modeShortcut: string // 예: 'Alt+Q'
  contextBytes: 256 | 512 | 1024 | 2048 | 4096
}
