// ============================================================================
// 공동 소유 (담당 A ↔ 담당 B 인터페이스 계약) — PLAN.md §8
// A(선택/추출)가 SelectionContext 를 생성해 B(검색/AI)로 넘기고,
// B 는 SearchResult 를 UI 로 반환한다. 이 파일은 양측이 함께 관리한다.
// ============================================================================

export type Language = 'en' | 'ja' | 'zh'

/** 창 선택 UI에 보여줄 캡처 가능 창 1개 (담당 A) */
export interface CaptureSource {
  id: string
  name: string
  thumbnail: string // dataURL
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

// ---- 검색 요청/응답 ----------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export type SearchRequest =
  | { type: 'pronunciation' }
  | { type: 'dictionary' }
  | { type: 'ask'; prompt: string; history?: ChatTurn[] }

/** B → UI : 스트리밍 가능한 검색 결과 */
export interface SearchResult {
  kind: 'pronunciation' | 'dictionary' | 'ask'
  content: string
  meta?: Record<string, unknown>
}

// ---- 앱 모드/설정 -----------------------------------------------------------

export type AppMode = 'normal' | 'select'

export type LlmProvider = 'gpt' | 'gemini' | 'claude'

export interface AppSettings {
  llm: LlmProvider
  language: Language | 'auto'
  modeShortcut: string // 예: 'Ctrl+1'
  contextBytes: 256 | 512 | 1024 | 2048 | 4096
}
