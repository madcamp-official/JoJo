// ============================================================================
// 공동 소유 (담당 A ↔ 담당 B 인터페이스 계약) — PLAN.md §7
// 경계 = 팝업창. A(팝업 전)가 ExtractedSelection 을 만들어 B 로 넘기고,
// B(팝업 후)가 팝업에서 SelectionContext 를 확정한 뒤 QuestionResult 를 UI 로 반환한다.
// 이 파일은 양측이 함께 관리한다.
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

/** A → B (팝업 트리거): 팝업 직전까지 A 가 추출한 원자료. 최종 선택은 B 가 팝업에서 확정. */
export interface ExtractedSelection {
  /** 클릭 지점 근방의 추출 텍스트(팝업 표시·선택의 기준 문자열) */
  text: string
  /** 클릭한 표현의 text 내 [start, end) 오프셋 = 팝업 초기 선택 */
  anchor: { start: number; end: number }
  /** 단어 분해(+화면 좌표) — 좌표 매핑·하이라이트용 */
  words: Word[]
  language: Language
  source: SelectionSource
  extraction: 'direct' | 'ocr'
}

/** B 가 팝업에서 범위를 확정한 결과. 질문 함수(runQuestion)의 입력. */
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
  llm: LlmProvider | null // 사용자가 아직 고르지 않았으면 null (기본 provider 를 임의로 정하지 않는다)
  language: Language | 'auto'
  modeShortcut: string // Electron accelerator 문자열. 기본값: 'Alt+Q' (macOS 는 Option+Q 로 자동 매핑)
  // 선택 앞/뒤로 포함할 문맥 바이트 예산(자유 지정). 실제로는 문장 경계까지 확장됨.
  contextBytesBefore: number
  contextBytesAfter: number
  contextBytesLinked: boolean // true 면 앞/뒤를 동일 값으로 사용
  // provider 별 사용 모델(설정 화면 드롭다운으로 선택). 미지정 provider 는 DEFAULT_MODELS 사용.
  models: Partial<Record<LlmProvider, string>>
}

/** provider 별 API 키 검증 결과 (설정 화면: 유효성 + 사용 가능 모델 목록). 무과금 GET 기반. */
export interface ProviderValidation {
  provider: LlmProvider
  ok: boolean
  /** ok=true 일 때 사용 가능한(채팅형) 모델 id 목록 */
  models: string[]
  /** ok=false 일 때 사유 — 렌더링용 QuestionErrorCode(invalid_api_key 등) */
  error?: QuestionErrorCode
}
