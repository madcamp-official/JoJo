// ============================================================================
// 공동 소유 (담당 A ↔ 담당 B 인터페이스 계약) — PLAN.md §8
// 경계 = 팝업창. A(팝업 전)가 ExtractedSelection 을 만들어 B 로 넘기고,
// B(팝업 후)가 팝업에서 SelectionContext 를 확정한 뒤 QuestionResult 를 UI 로 반환한다.
// 이 파일은 양측이 함께 관리한다.
// ============================================================================

/** zh 는 스크립트 기준으로 zh-Hans(간체/대륙식)/zh-Hant(번체/대만식)로 나뉜다 — 사전 API가
 * 스크립트별로 다른 소스를 쓰고(汉典/CC-CEDICT vs 萌典), 변환(OpenCC 등) 없이 원문 스크립트에
 * 맞는 사전으로 바로 라우팅하기 위함. 판별(어느 스크립트인지)은 변환(다른 스크립트로 바꾸기)과
 * 달리 모호함이 적다 — 대부분의 상용한자가 스크립트별 고유 형태를 가진다(国/國, 汉/漢 등). */
export type Language = 'en' | 'ja' | 'zh-Hans' | 'zh-Hant'

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
  /**
   * 원문 전체(트리밍 없음, ExtractedSelection.text 그대로) — LLM 문맥 구성 시
   * settings.contextBytesBefore/After 만큼 여기서 직접 잘라 쓴다. 팝업이 화면에 보여주는
   * 범위(256바이트 창)와는 별개다 — 표시용 트리밍이 LLM 문맥 범위를 제한하지 않도록 함.
   */
  fullText: string
  /** selectedText 의 fullText 내 [selStart, selEnd) 오프셋 */
  selStart: number
  selEnd: number
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

// ---- 사전(Dictionary) 통일 스키마 --------------------------------------------
// PLAN.md §5 — en(MW/WordNet/Wiktionary)·ja(Kotobank/JMdict)·zh(汉典/萌典/CC-CEDICT)
// 8개 소스가 전부 다른 응답 형식(JMdict의 'v1'/'vt' 같은 약어 코드, MW의 sseq/dt/vis
// 중첩 구조, CC-CEDICT의 슬래시 구분 평문 등)을 가지므로, 각 어댑터가 원본을 파싱해
// 이 공통 타입으로 변환한 뒤에만 LLM 프롬프트에 들어가게 한다(llm/adapter.ts 가
// GPT/Gemini/Claude 를 QuestionResult 하나로 통일하는 것과 동일한 패턴).

/** 언어 간 품사 분류를 최대한 겹치게 정리한 것 — 언어마다 없는 품사도 있다(일/중엔
 *  관사가 없고, 영어엔 조사가 없는 등). ja 助詞/zh 助词는 이름은 같지만 실제 기능이
 *  다르다(전자는 격조사 중심, 후자는 상 표지·구조조사 중심) — 세부 차이는 posRaw 로 보존. */
export type CanonicalPos =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'preposition' // en 전치사 / zh 介词(개사)
  | 'conjunction' // en 접속사 / ja 接続詞 / zh 连词
  | 'article' // en 전용(a/an/the) — ja/zh 엔 없음
  | 'particle' // ja 助詞 / zh 助词 — 사전 조회 실패가 잦은 기능어 묶음(LLM이 문법 설명 전담)
  | 'interjection'
  | 'classifier' // zh 量词 — 다른 언어엔 대응 품사 없음
  | 'other'

export interface DictionarySense {
  /** 표준화된 품사 — 萌典/CC-CEDICT처럼 품사 필드 자체가 없는 소스는 undefined */
  pos?: CanonicalPos
  /** 원본 품사 표기 보존(JMdict 'v1' 등) — 디버깅/검수용, LLM 프롬프트에는 넣지 않음.
   *  CanonicalPos 로 뭉뚱그리며 사라지는 세부 정보 자체는 이 필드에 남아있지만, LLM에
   *  전달 안 하기로 했으므로 "문법 설명에 실제로 쓸 정보"는 반드시 conjugationClass 처럼
   *  별도 필드로 승격해야 한다 — 그러지 않으면 이 필드에 있어도 없는 것과 같다. */
  posRaw?: string
  /** 활용 분류 — 언어별로 canonical pos 하나로는 못 담는 문법 정보를 사람이 읽을 수 있게
   *  디코딩해 보존한다(이 필드는 LLM에도 전달). 예: ja 동사 "一段"/"五段(う)"/"サ変",
   *  ja 형용사 "い형용사"/"な형용사". 활용형(て形·과거형 등) 설명에 실제로 필요한 정보라
   *  posRaw 와 달리 버리지 않는다. zh 이합사(离合词) 등 다른 언어의 특이 문법도 필요해지면
   *  같은 방식으로 여기에 추가. */
  conjugationClass?: string
  /** 타동사/자동사 — JMdict 의 vt/vi 는 품사가 아니라 별도 축이라 분리 */
  transitive?: boolean
  /** 중국어 양사(CC-CEDICT의 "CL:") — 다른 언어는 항상 undefined */
  classifiers?: string[]
  /** 뜻풀이 원문(번역하지 않음, 원어 그대로) */
  gloss: string
  /** 있는 소스만(JMdict/萌典/CC-CEDICT 는 예문 자체가 없는 포맷) */
  example?: string
}

export type DictionarySourceId =
  | 'merriam-webster'
  | 'wordnet'
  | 'wiktionary'
  | 'kotobank'
  | 'jmdict'
  | 'hanyu-dict' // 汉典
  | 'moedict' // 萌典
  | 'cc-cedict'

export interface DictionaryEntry {
  headword: string
  /** 병음/가나/IPA 등 발음 표기 — 있으면 */
  reading?: string
  senses: DictionarySense[]
  source: DictionarySourceId
}

// ---- 앱 모드/설정 -----------------------------------------------------------

export type AppMode = 'normal' | 'select'

export type LlmProvider = 'gpt' | 'gemini' | 'claude'

/** keyStore 가 관리하는 모든 API 키의 식별자 — LLM provider 3종 + 사전 API(MW). */
export type ApiKeyId = LlmProvider | 'mw'

export interface AppSettings {
  llm: LlmProvider | null // 사용자가 아직 고르지 않았으면 null (기본 provider 를 임의로 정하지 않는다)
  language: Language | 'auto'
  modeShortcut: string // Electron accelerator 문자열. 기본값: 'Alt+Q' (macOS 는 Option+Q 로 자동 매핑). 빈 문자열 = 단축키 해제
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

/** kuromoji 형태소 분석 결과 토큰 하나 (팝업 원문 문맥의 가나 atom 병합용, main/nlp/japanese.ts) */
export interface JaToken {
  surface: string
  /** 品詞(품사) — 예: 助詞, 助動詞, 動詞, 名詞, 記号 */
  pos: string
  /** 분석 대상 문자열 상 0-based 문자 오프셋 */
  start: number
}
