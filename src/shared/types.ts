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
  // source: 병렬 어댑터 구현 디버깅용 임시 필드(2026-07-28) — 팝업 드롭다운에서 고른
  // DictionarySourceId. 없으면(undefined) 정식 폴백 순서를 따른다(오케스트레이션 구현 후).
  | { type: 'dictionary'; source?: DictionarySourceId }
  | { type: 'ask'; prompt: string; history?: ChatTurn[] }

/** API 키 미설정/무효, 사용 한도(크레딧) 소진 등 UI가 구분해 안내해야 하는 실패 종류 */
export type QuestionErrorCode =
  | 'no_active_provider'
  | 'no_api_key'
  | 'invalid_api_key'
  | 'insufficient_credit'
  | 'rate_limited'
  /** 설정에 선택된 모델이 provider 에 더 이상 없음(단종/오타 등) — HTTP 404 model_not_found
   *  실측 확인(2026-07-28, "gpt-5.3-pro": 한때 있었으나 세대교체로 없어진 모델을 설정 화면이
   *  캐싱해둔 목록에서 계속 보여주고 있었던 사례). 이전엔 이 케이스가 전부 unknown 으로
   *  뭉뚱그려져 원인 파악이 안 됐다. */
  | 'invalid_model'
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

/** 3개 언어 전부에 대응 품사가 있는 것들 — CanonicalPos<L> 이 언어별로 여기에 각자의
 *  전용 품사를 더한다. */
type CanonicalPosCommon = 'noun' | 'verb' | 'adjective' | 'adverb' | 'pronoun' | 'conjunction' | 'interjection' | 'other'

/** 언어 간 품사 분류를 최대한 겹치게 정리한 것 — 언어마다 없는 품사도 있다(일/중엔
 *  관사가 없고, 영어엔 조사가 없는 등). ja 助詞/zh 助词는 이름은 같지만 실제 기능이
 *  다르다(전자는 격조사 중심, 후자는 상 표지·구조조사 중심) — 세부 차이는 posRaw 로 보존.
 *
 *  **2026-07-28: `DictionaryEntry<L>` 과 같은 이유로 제네릭화** — `article`(en 전용)/
 *  `particle`(ja/zh)/`classifier`(zh 전용)/`adnominal`(ja 전용)처럼 언어 전용 값이
 *  섞여 있으면, en 어댑터가 실수로 `pos: 'classifier'`를 넣어도 컴파일러가 못 잡았다.
 *  `L` 을 구체 언어로 좁히면 그 언어에 실제로 없는 품사 값은 타입 자체에서 배제된다. */
export type CanonicalPos<L extends Language = Language> = L extends 'en'
  ? CanonicalPosCommon | 'preposition' | 'article' // en 전치사, 관사(a/an/the)
  : L extends 'ja'
    ? CanonicalPosCommon | 'particle' | 'adnominal' // ja 助詞, 連体詞(この/あの/いわゆる 등 — 활용 없이 체언 수식만, 실측: JMdict "Pre-noun adjectival (rentaishi)")
    : L extends 'zh-Hans' | 'zh-Hant'
      ? CanonicalPosCommon | 'preposition' | 'particle' | 'classifier' // zh 介词(개사), 助词, 量词
      : never

/** usageTags 태그 하나의 성격 — 격식/사용역(register)인지, 격식과 무관한 표기·형태 관례
 *  (convention)인지, 방언 표시(dialect)인지를 최소한으로 구분한다(2026-07-28 신설). 분류가
 *  애매한 라벨(예: CC-CEDICT `(loanword)`/`(bound form)` — 어원·형태 결합 제약 표시라
 *  격식도 방언도 아님)을 억지로 셋 중 하나로 우기지 않고 'other'로 둔다. LLM 프롬프트엔
 *  `text`만 넣고 `kind`는 어댑터/기능(예: PLAN §3 "격식 여부" 자주 쓰는 질문)이 태그를
 *  걸러 쓸 때만 사용. */
export type UsageTagKind = 'register' | 'convention' | 'dialect' | 'other'

export interface UsageTag {
  /** 원문 라벨 그대로(예: "informal", "often attributive") — 정규화하지 않음. */
  text: string
  kind?: UsageTagKind
}

/** seeAlso 포인터 하나의 관계 성격 — CC-CEDICT 교차참조가 실측상 이렇게 갈렸다(2026-07-28
 *  신설): `variant` (이형 표기, "variant of"/"also written"), `dialectVariant` (음운
 *  변이, "erhua variant of" 등 발음만 다른 같은 말), `abbreviation` (줄임말↔원말 — 관계
 *  방향이 "variant"와 다름: 같은 말의 다른 표기가 아니라 축약 관계), `usedIn` (이 표제어가
 *  다른 복합어의 구성 성분으로 쓰인다는 표시), `related` (그 외 느슨한 "그냥 참고" 관계,
 *  JMdict `see_also`/`related`·萌典 `link`가 기본적으로 여기 해당). 분류 안 되면 undefined. */
export type SeeAlsoKind = 'variant' | 'dialectVariant' | 'abbreviation' | 'usedIn' | 'related'

export interface SeeAlsoRef {
  /** 원문 그대로(예: "族[zu2]", "一箭双雕", "一人で") — 정규화하지 않음. */
  text: string
  kind?: SeeAlsoKind
}

/** 언어 무관 공통 필드 중 gloss/parentIndex 를 제외한 나머지 — 8개 소스 전부가 이 축을 갖는다
 *  (값이 없으면 undefined일 뿐, "이 언어엔 이 개념 자체가 없다"는 아님). 언어 전용 필드는 아래
 *  `DictionarySenseExt<L>`에 분리해뒀다(2026-07-28, 판별 유니온 도입 — 이유는
 *  DICTIONARY_SOURCES.md#공통-스키마-결정-사항 참고: `classifiers`(zh)/`conjugationClass`(ja)
 *  등 언어 전용 필드가 계속 늘면서 원래 "공통 베이스+옵셔널"로 버티기로 한 전제(언어 전용 필드
 *  2~3개 규모)가 ja 기준 이미 넘어서 있었음). gloss/parentIndex 는 gloss 필수 여부가
 *  parentIndex 유무에 따라 갈려야 해서(그룹 헤더 sense는 gloss가 없을 수 있음) 아래
 *  `DictionarySenseGloss`로 별도 분리했다. */
interface DictionarySenseCommon<L extends Language = Language> {
  /** 표준화된 품사 — CC-CEDICT처럼 품사 필드 자체가 없는 소스만 undefined. **萌典도 품사
   *  필드가 있음**(실측 확인: `definitions[].type` — 名/動/形/副/連/介/代/助/歎, 순서대로
   *  명사/동사/형용사/부사/접속사/전치사/대명사/조사/감탄사에 대응). 단, 양사(量詞)는 별도
   *  type 값이 없고 `名`(명사) 안에 "量詞：" 라는 평문으로만 표시돼 있어(예: "隻") classifier
   *  판정은 이 필드만으론 안 되고 gloss 텍스트 파싱이 추가로 필요함. */
  pos?: CanonicalPos<L>
  /** 원본 품사 표기 보존(JMdict 'v1' 등) — 디버깅/검수용, LLM 프롬프트에는 넣지 않음.
   *  CanonicalPos 로 뭉뚱그리며 사라지는 세부 정보 자체는 이 필드에 남아있지만, LLM에
   *  전달 안 하기로 했으므로 "문법 설명에 실제로 쓸 정보"는 반드시 conjugationClass 처럼
   *  별도 필드로 승격해야 한다 — 그러지 않으면 이 필드에 있어도 없는 것과 같다. */
  posRaw?: string
  /** 있는 소스만(JMdict/CC-CEDICT 는 예문 자체가 없는 포맷). **萌典은 있음** — `definitions[].
   *  example`(현대 용례, "如：「...」" 형태) 실측 확인, `DICTIONARY_SOURCES.md` 참고. 단
   *  萌典의 `definitions[].quote`(고전 문헌 인용+출처)는 이 필드로 흡수하지 않고 스키마
   *  자체에서 제외하기로 결정(2026-07-28) — 문어체·비구조화 출처라 학습 실익이 낮음. 한
   *  뜻에 예문이 여러 개인 경우가 흔해서(MW 실측: "run" 93개 뜻 중 20개가 2개 이상, 최대
   *  4개) 배열로 둔다 — WordNet 처럼 예문이 gloss 문자열에 세미콜론으로 뭉쳐 오는 소스는
   *  어댑터가 분리해서 채움. */
  examples?: string[]
  /** 유의어 — 실측 확인: JMdict("高い"의 일부 뜻), Wiktionary(예: "ate"→consume/swallow/
   *  dine 등), 汉典(近反义词 섹션). 뜻(sense) 단위로 붙는 정보라 여기 둔다 — 같은 표제어의
   *  다른 뜻엔 없을 수 있음(실측: "高い" 5개 뜻 중 1개만 반의어 있었음). */
  synonyms?: string[]
  /** 반의어 — 위 synonyms 와 동일 근거(실측: JMdict "高い"→"低い"). */
  antonyms?: string[]
  /** 동의어 보장이 없는 "관련어 참조" — JMdict `see_also`/`related`(jisho.org 실측:
   *  "一人"의 "being alone" 뜻 → 見よ: 一人で), CC-CEDICT 교차참조 포인터(`variant of`/
   *  `abbr. for`/`see also` 등, 실측: "一族" → "see also 族[zu2]"), 萌典 `link` 필드
   *  (실측: "蟑螂" → "也稱為「蜚蠊」", 완결된 용어가 아니라 문장형이면 usageNote 로 대체
   *  처리) 실측 확인(2026-07-28 신설). synonyms 와 달리 "같은 뜻"이 보장되지 않는
   *  포인터라 별도 필드로 분리.
   *
   *  **2026-07-28 정정: `string[]`에서 `SeeAlsoRef[]`로 구조화.** CC-CEDICT의 교차참조가
   *  `variant of`(이형 표기)/`erhua variant of`(음운 변이)/`abbr. for`(줄임말↔원말,
   *  관계 방향이 다름)/`used in`(다른 복합어의 구성 성분)/`see also`(그냥 느슨한 관련어)로
   *  관계 성격이 다 다른데 문자열 하나에 뭉쳐 있어서, `usageTags`와 같은 이유로 `kind`를
   *  추가. **`usageTags`(이 뜻 자체의 성질을 나타내는 라벨)와는 합치지 않기로 결정** —
   *  `seeAlso`는 다른 표제어를 가리키는 포인터라 성격이 근본적으로 다르고(나중에 "클릭해서
   *  재조회" 같은 기능이 붙을 수 있는 것도 이쪽), 합치면 kind 종류만 늘어나 오히려 이번에
   *  고치려던 문제를 재현하게 됨. */
  seeAlso?: SeeAlsoRef[]
  /** 전문분야/도메인 라벨 — JMdict `field`(jmdict-simplified 원본, 컴퓨터·의학·법률 등)
   *  실측 확인. jisho.org 라이브 API는 이 축을 `misc`(usageTags 대응)와 뭉쳐 `tags`
   *  하나로 노출하지만, 로컬 데이터셋을 직접 번들하는 어댑터는 원본 구분을 살려 이
   *  필드로 분리해 받는다(2026-07-28 신설). CC-CEDICT 전문분야 라벨(`(math.)`/
   *  `(computing)` 등)도 이 필드로 매핑 가능 — 파싱 시 usageTags 와 구분해서 라우팅. */
  domain?: string[]
  /** 격식/사용역 + 표기 관례 라벨(복수 가능) — MW 의 `sls`(status label sequence) 필드
   *  실측 확인(예: "ain't"→["informal"]). PLAN.md §3 "자주 쓰는 질문"에 이미 "격식·객관
   *  표현 여부"가 있어 이 앱 기능과 직결되는 정보라 추가 — 사전 API가 이미 판정해주는 걸
   *  LLM이 처음부터 다시 추측하지 않아도 됨. 원래 필드명은 `register`였으나 JMdict `misc`
   *  (실측: "しどい"→["Slang"], "薔薇"→["Usually written using kana alone"])가 격식뿐
   *  아니라 표기 관례 같은 이질적 태그까지 섞여 있어 `register`란 이름이 좁아서
   *  `usageTags`로 개명(2026-07-28) — 격식 라벨(MW `sls`, CC-CEDICT `(coll.)`/`(slang)` 등)과
   *  JMdict `misc` 둘 다 이 필드 하나로 수용한다. **MW `lbs`도 여기 합류**(실측 확인,
   *  "deco" → entry 최상위 `lbs: ["often attributive"]`) — 전문분야 라벨이 아니라 `sls`와
   *  같은 성격의 일반 표기 관례 라벨이라 domain이 아니라 이 필드로 매핑한다. 단 `lbs`는
   *  entry 최상위 필드라 sense 레벨인 이 필드와 위치가 다르므로, 어댑터가 그 entry의 모든
   *  sense 에 복제해 넣어야 한다.
   *
   *  **2026-07-28 정정: `string[]`에서 `UsageTag[]`로 구조화.** 격식(register)·표기 관례
   *  (convention)·방언 표시(dialect)가 전부 문자열 하나에 섞여 있으면, PLAN §3 "격식·객관
   *  표현 여부" 자주 쓰는 질문 기능이 이 필드로 격식 여부를 판단할 때 격식과 무관한
   *  태그(예: JMdict "Usually written using kana alone")까지 같이 LLM에 들어가 판단을
   *  오염시킬 수 있음을 뒤늦게 발견 — `kind`로 최소 분류해 어댑터/프롬프트 구성 단계에서
   *  걸러 쓸 수 있게 한다. */
  usageTags?: UsageTag[]
  /** 화용론적 사용법 설명 — MW 의 `uns`(usage note) 실측 확인(예: "close"(동사) →
   *  뜻풀이 "to suspend or stop the operations of" 옆에 별도로 "often used with down"
   *  설명). gloss(뜻풀이)·examples(예문) 어디에도 안 들어가는 제3의 콘텐츠 타입이라
   *  별도 필드로 분리. **주의**: `uns`가 `dt`의 유일한 내용(진짜 `text` 튜플이 따로
   *  없음)인 경우도 있다(실측: "the"/"a" 같은 관사, "ain't hay") — 이때는 `uns` 안
   *  내용이 보충 설명이 아니라 그 sense의 유일한 뜻풀이이므로 어댑터가 `gloss`로
   *  승격해야 하고, `usageNote`는 `text`가 실제로 있을 때만 채워야 한다. */
  usageNote?: string
}

/** gloss(뜻풀이)와 parentIndex(계층 포인터)를 함께 판별하는 부분 — 원래 각각 독립된 필드였으나
 *  gloss 필수 여부가 parentIndex 유무에 따라 갈려야 해서(아래 설명) 하나의 유니온으로 묶었다.
 *
 *  **parentIndex**: 이 sense 가 다른 sense 의 더 좁은 하위 구분일 때, 그 부모 sense 를 가리키는
 *  인덱스(같은 `DictionaryReading.senses` 배열 안에서의 위치, 0-based) — 2026-07-28 신설. MW
 *  `sdsense`(예: "photosynthesis" 주 정의 아래 "especially: ..." 하위 정의)와 Kotobank
 *  精選版日本国語大辞典의 `[一]`→`①②③`→`(イ)(ロ)` 다단 번호매김(예: "花"는 대분류 5개 아래
 *  세부 뜻 30개 이상)이 둘 다 "병렬 대안 뜻"이 아니라 "상위 뜻의 더 좁은 하위 구분"이라는 계층
 *  구조인데, 이 배열 자체는 평면이라 그냥 순서대로 넣으면 이 관계가 사라진다 — 어댑터가 하위
 *  sense 를 만들 때 그 직속 부모의 배열 인덱스를 채워 넣어 트리 구조를 재구성할 수 있게 한다
 *  (다단이면 부모의 parentIndex 를 따라가며 조상까지 거슬러 올라감). 계층이 없는 소스(en
 *  OEWN/Wiktionary, zh CC-CEDICT 등)는 항상 undefined. LLM 프롬프트/UI 가 이 정보를 어떻게
 *  실제로 활용할지(들여쓰기 표시 등)는 아직 미정 — 어댑터 구현 시점에 정하기로 함(우선 필드만
 *  마련).
 *
 *  **gloss 필수 여부(2026-07-28 신설)**: `parentIndex`가 없는(=최상위) sense 는 지금까지처럼
 *  `gloss`가 필수다. 반면 `parentIndex`가 있는(=누군가의 하위 구분인) sense 는 두 경우가 섞여
 *  있을 수 있다 — Kotobank 精選版의 `①②③`처럼 실제 뜻풀이를 가진 리프 sense도 있지만, `[一]`
 *  처럼 그 자체론 뜻풀이 없이 하위 항목을 묶기만 하는 "그룹 헤더" sense도 있다(실측 기록상
 *  `[一]` 레벨은 자체 정의 없이 分類 역할만 하는 경우가 흔함). 그룹 헤더까지 `gloss`를 억지로
 *  채우게 하면 어댑터마다 "자식 gloss 복제" 또는 "빈 문자열" 같은 임기응변이 갈릴 위험이 있어,
 *  `parentIndex`가 있을 때만 `gloss`를 선택적으로 풀어준다 — 실제 하위 뜻풀이가 있는 sense는
 *  어댑터가 그대로 채우면 되고, 순수 그룹 헤더만 생략하면 된다. */
type DictionarySenseGloss =
  | { parentIndex?: undefined; gloss: string[] }
  | { parentIndex: number; gloss?: string[] }

export type DictionarySenseBase<L extends Language = Language> = DictionarySenseCommon<L> & DictionarySenseGloss

/** 언어 전용 필드 — L 이 구체 언어 하나('en' 등)면 그 언어의 확장 필드만 남고, L 이
 *  Language(유니온) 그대로 들어오면 조건부 타입이 분배(distribute)돼 4개 언어 케이스의
 *  유니온이 된다("언어 안 가리는 공용 sense" 타입이 필요할 때는 이쪽).
 *
 *  **주의**: `DictionaryEntry<L>`에서 L 을 구체 언어로 좁힌 뒤(`entry.language === 'ja'`
 *  같은 판별) 그 entry 안의 sense 를 참조하면 TS 가 제네릭을 타고 내려가 `conjugationClass`
 *  등에 바로 접근 가능하지만, entry 와 분리된 채 `sense: DictionarySense<Language>` 하나만
 *  받는 함수는(narrowing 할 discriminant 가 sense 자체엔 없음) `'classifiers' in sense`
 *  같은 속성 존재 체크로 좁혀야 한다 — 판별을 최상위(entry)에만 두기로 한 트레이드오프. */
/** 타동사/자동사 — en/ja 공유 개념이라 두 언어 확장 타입이 공통으로 물려받는다(2026-07-28,
 *  설명을 한 곳에만 두도록 정리 — 이전엔 en/ja 양쪽에 각자 적어두고 서로 참고하라고
 *  써놔서 한쪽만 고치고 다른 쪽을 놓칠 위험이 있었음). MW 는 entry.fl 이 아니라
 *  `def[].vd`("verb divider")에 "transitive verb"/"intransitive verb"로 옴(실측 확인,
 *  예: "run"은 def 블록이 2개로 갈려 하나는 intransitive, 하나는 transitive) — `vd`는
 *  그 def 블록 전체(=여러 sense)에 적용되는 라벨이라, entry 최상위 `lbs`를 모든 sense 에
 *  복제했던 것과 같은 패턴으로 그 def 안의 senses 전부에 전파해야 함. JMdict 는 sense
 *  자체에 `vt`/`vi` 태그가 붙어 레벨이 다름(전파 불필요). zh 는 대응 개념 없음. */
interface TransitiveExt {
  transitive?: boolean
}

type DictionarySenseExt<L extends Language> = L extends 'en'
  ? {
      /** 불규칙 활용형(en 전용) — MW 의 `ins`(inflections) 필드 실측 확인(예: run → "ran").
       *  **OEWN도 실측 확인**(GitHub 공식 JSON 릴리스 직접 다운로드해 확인) — entry의 `form`
       *  필드가 배열로 제공(예: run(v) → `["ran", "running"]`), MW의 반쯤 자유 텍스트인
       *  `ins`보다 오히려 더 깔끔한 구조. ja 의 conjugationClass 와 마찬가지로 문법 설명에
       *  실제로 쓰이는 정보라 LLM에도 전달. Wiktionary 등 다른 en 소스는 이 필드가 비어있을
       *  수 있음. */
      irregularForms?: string[]
      /** 정관사/부정관사 구분(en 전용) — 3개 en 소스 실측 비교(2026-07-28): **MW만** `fl`이
       *  "definite article"/"indefinite article"로 구조화돼 안전하게 판별 가능(예:
       *  "the"→definite article, "a"/"an"→indefinite article). **OEWN은 아예 커버리지가
       *  없음**(GitHub Releases 번들 `entries.json` 직접 확인: "the" 자체가 키로 없고,
       *  "a"는 명사(알파벳 글자 "a") 뜻만 있고 관사 표제어가 없음 — WordNet류가 원래
       *  관사 같은 기능어를 안 실음). **Wiktionary REST API도 구조화된 필드가 없음** —
       *  `partOfSpeech`는 그냥 "Article"이고, "definite"/"indefinite" 구분은 definition
       *  텍스트 산문 안에 자연어로만 섞여 있어(예: "the" definition 텍스트 안에 "The
       *  definite grammatical article...") 안정적으로 파싱할 필드가 아님 — 텍스트 패턴
       *  매칭은 위키 편집자가 표현을 바꾸면 깨지므로 채택 안 함. 그래서 이 필드는 MW만
       *  채우고, 나머지 두 소스는 항상 undefined로 두어 UI가 자동으로 "관사"로만 표시하게
       *  한다(사용자 요청: "구분 안되면 그냥 관사로"). */
      definite?: boolean
    } & TransitiveExt
  : L extends 'ja'
    ? {
        /** 활용 분류(ja 전용) — 언어별로 canonical pos 하나로는 못 담는 문법 정보를 사람이
         *  읽을 수 있게 디코딩해 보존한다(이 필드는 LLM에도 전달). 예: 동사 "一段"/
         *  "五段(う)"/"サ変", 형용사 "い형용사"/"な형용사". 활용형(て形·과거형 등) 설명에
         *  실제로 필요한 정보라 posRaw 와 달리 버리지 않는다. (zh 이합사(离合词)는 실측
         *  확인 결과(2026-07-28, 汉典 `结婚`/萌典 `見面` 페이지 직접 확인 포함) 汉典·萌典·
         *  CC-CEDICT 어디에도 태깅 안 되어 있어 스키마에 별도 자리를 안 만들기로 함.) */
        conjugationClass?: string
      } & TransitiveExt
    : L extends 'zh-Hans' | 'zh-Hant'
      ? {
          /** 이 명사(headword)와 함께 쓰는 양사(예: "書"→"本") — CC-CEDICT의 `CL:` 태그로만
           *  구조화돼 실측 확인(2026-07-28). **萌典은 이 정보 자체가 없음**(실측 확인: "書"
           *  조회 시 이런 매칭이 전혀 없음) — 萌典의 "量詞："는 이것과 다른 축으로, 隻/個
           *  같은 **양사 단어 자체를 조회했을 때 그 단어의 한 뜻풀이가 "양사로 쓰인다"는
           *  의미**일 뿐이라 `pos` 판정(CanonicalPos 'classifier') 문제이지 이 필드완
           *  무관(`DictionarySenseBase.pos` 주석 참고). 汉典도 이런 명사-양사 매칭 정보는
           *  확인 안 됨. 사실상 CC-CEDICT 전용 필드. */
          classifiers?: string[]
        }
      : object

export type DictionarySense<L extends Language = Language> = DictionarySenseBase<L> & DictionarySenseExt<L>

export type DictionarySourceId =
  | 'merriam-webster'
  | 'wordnet'
  | 'wiktionary'
  | 'kotobank'
  | 'jmdict'
  | 'hanyu-dict' // 汉典
  | 'moedict' // 萌典
  | 'cc-cedict'

/** 사전 소스별 어댑터가 en/ja/zh 각자 다른 워크트리에서 병렬 구현 중이라(2026-07-28),
 *  디버깅용으로 팝업에서 실제 검색에 쓸 소스를 직접 골라볼 수 있게 하는 임시 드롭다운의
 *  옵션 하나. `priority`가 낮을수록(1이 최우선) 폴백 순위가 높다 — 여러 개면 드롭다운
 *  기본 선택값은 이 순서로 정렬했을 때 첫 번째. 실제 목록은 main 프로세스가
 *  `question/dictionary/registry.ts`에서 "그 언어의 어댑터 파일이 실제로 존재하는가"로
 *  감지해 IPC 로 내려준다(어댑터 구현 완료 시 재등록 없이 자동으로 뜬다). */
export interface DictionarySourceOption {
  id: DictionarySourceId
  label: string
  priority: number
}

/** 발음 하나에 딸린 sense 묶음 — 같은 표기라도 발음(따라서 뜻 집합)이 갈리는 경우가
 *  실측으로 확인됨: MW "read"는 hom(homograph) 별로 발음이 다름(동사 hom=1 "ˈrēd" vs
 *  형용사 hom=2 "ˈred"), 萌典 "行"은 heteronyms 4개가 각각 다른 병음(háng/hàng/xíng/xìng)에
 *  전혀 다른 뜻풀이 세트를 가짐 — 萌典은 이 구조를 필드명(heteronyms, 복수)에 그대로
 *  반영해뒀을 정도. reading 을 DictionaryEntry 최상위에 하나만 두면 이 경우를 표현 못 해서
 *  발음 그룹 단위로 내렸다. */
/** 발음 표기 하나 — 지역/변이별로 여러 개 올 수 있어(아래 DictionaryReading.pronunciations
 *  참고) value 만으론 안 되고 variety 로 구분해야 하는 경우가 있다. */
export interface DictionaryPronunciation {
  value: string
  /** 지역/변이 태그 — **OEWN 실측 확인**(`pronunciation[].variety`, 미국/영국 등 원본
   *  코드 그대로 보존, 정규화하지 않음). 소스가 변이를 구분 안 해주면 undefined. */
  variety?: string
}

/** 언어 무관 공통 필드(reading 레벨) — DictionaryReading<L> 이 senses 를 통해 L 을 그대로
 *  물려준다. */
export interface DictionaryReadingBase<L extends Language = Language> {
  /** 병음/가나 등 소스 자체의 발음 표기 — 배열인 이유가 위 DictionaryReading 레벨 분리
   *  사유(동음이의/hom)와는 다르다: **OEWN은 같은 sense 집합에 지역별 발음이 여러 개
   *  붙는 구조**(실측: `pronunciation[]`에 원소가 여러 개, 각각 `variety` 태그 — 예를 들어
   *  같은 뜻인데 미국식/영국식 발음이 나란히 옴)라서, "발음이 다르면 뜻도 다르다"는
   *  DictionaryReading 분리 기준과는 별개로 표기 자체의 지역 변이만 담을 자리가 필요했다.
   *  소스가 발음별로 안 나누면(단일 발음) 1개만 옴. 표기 체계는 소스마다 제각각이라
   *  정규화하지 않고 원문 그대로 둔다(실측):
   *  - MW: `prs.mw` 필드, **IPA 아님** — 자체 표기법(매크론 ā/ē/ī/ō/ū 등, 인쇄사전
   *    시절부터 쓰던 방식). IPA 필드 자체가 응답에 없음. variety 구분 없음(단일 값).
   *  - **OEWN: 발음 필드 있음, IPA**(`pronunciation[].value`, 예: run(v) → "ɹʌn") — GitHub
   *    공식 JSON 릴리스를 직접 받아 확인(라이브 API en-word.net은 실측 내내 503으로 불안정).
   *    원본 Princeton WNDB(발음 정보 없음)와 달리 OEWN은 이 필드를 갖고 있음 — WordNet 계열이라고
   *    무조건 undefined 로 가정하면 안 됨.
   *  - Wiktionary(dictionaryapi.dev 등): `phonetic` 필드, **실제 IPA**(예: "/beɪs/").
   *  이 앱의 발음 기능(IPA 등)은 이 필드가 아니라 question/pronunciation.ts 가 LLM에
   *  직접 요청하는 별도 파이프라인이라 위 불일치와 무관하게 동작한다. */
  pronunciations?: DictionaryPronunciation[]
  senses: DictionarySense<L>[]
}

/** 언어 전용 필드(reading 레벨) — 지금은 ja(JMdict) 뿐. */
type DictionaryReadingExt<L extends Language> = L extends 'ja'
  ? {
      /** JMdict(jisho.org) 전용 — 이 reading 그룹이 흔히 쓰이는지. 필드명을 원본(`is_common`)
       *  그대로 씀. **sense 가 아니라 reading 레벨에 두는 이유가 실측으로 확인됨**: jisho.org
       *  API로 "上手" 검색 시 `is_common` 이 sense 배열 안이 아니라 각 entry(result) 최상위에만
       *  있고, 그 밑 senses(예: じょうず 그룹의 "능숙한"/"아첨" 두 sense)는 전부 같은 값을
       *  공유함 — 원본 JMdict XML 이 우선도 태그(`ke_pri`/`re_pri`)를 한자/읽기 요소에만 붙이고
       *  sense 요소엔 안 붙이는 구조라 애초에 sense 단위로 갈릴 수 없다. LLM 프롬프트엔
       *  넣지 않고, 어댑터가 같은 표기의 여러 reading(DictionaryReading[]) 을 안정 정렬할 때만 씀.
       *  (당초 함께 뒀던 `DictionarySense.tagCount`(OEWN 전용)는 실제 OEWN JSON 릴리스에 그런
       *  필드가 없어 폐기함 — 2026-07-28.) */
      isCommon?: boolean
      /** 이 reading 이 headword 배열 중 일부 표기에만 적용될 때만 채움(undefined = 전체 적용) —
       *  jmdict-simplified `Kana.appliesToKanji` 실측 확인(인덱스가 아니라 한자 표기 문자열
       *  자체로 매칭, 예: "一人" 엔트리에서 いちにん reading 의 appliesToKanji 는 ["一人","１人"]
       *  뿐이고 "独り"는 빠짐 — 独り는 ひとり로만 읽힘). headword 를 `{text,...}[]` 객체 배열
       *  대신 `string[]`로 단순화했기 때문에 이 필드도 인덱스가 아니라 headword 배열의 문자열
       *  값 그대로를 담아 매칭한다. */
      appliesToHeadwords?: string[]
    }
  : object

export type DictionaryReading<L extends Language = Language> = DictionaryReadingBase<L> & DictionaryReadingExt<L>

/** `interface DictionaryEntry<L> {...}` 로 뒀더니 `entry.language`로 좁혀도 안쪽
 *  `readings[].senses[]`까지 타입이 안 좁혀지는 문제가 있었다(2026-07-28 발견) — 제네릭
 *  인터페이스는 타입 매개변수를 자동으로 분배(distribute)하지 않기 때문. `L extends
 *  Language ? {...} : never` 형태의 조건부 타입으로 바꿔서, `DictionaryEntry`(L 기본값
 *  = Language, 즉 유니온)를 실제로 4개 언어별 구체 타입의 유니온으로 만들었다 — 이래야
 *  `entry.language === 'ja'` 로 좁혔을 때 `entry.readings[].senses[].conjugationClass`
 *  까지 안전하게 좁혀진다(직접 검증: 임시 파일로 `entry.language` 판별 후 접근/미판별
 *  접근 두 경우를 tsc 로 확인함). */
export type DictionaryEntry<L extends Language = Language> = L extends Language
  ? {
      /** 이 entry 가 어느 언어 소스에서 왔는지 — 판별 유니온의 유일한 판별 필드(2026-07-28
       *  신설). `entry.language === 'ja'`처럼 이 필드로 좁히면 TS 가 제네릭 L 을 타고 내려가
       *  `readings[].senses[].conjugationClass` 같은 언어 전용 필드에 안전하게 접근 가능해진다
       *  — sense/reading 자체엔 이 판별 필드를 반복해서 두지 않았다(`DictionarySenseExt`
       *  주석의 트레이드오프 참고). */
      language: L
      /** 이표기(異表記) 전부 — 대부분의 소스는 길이 1인 배열이면 충분하지만, ja(JMdict)는
       *  한 표제어가 여러 한자로 쓰이는 경우가 실측 확인됨(예: "さびしい/さみしい"→["寂しい",
       *  "淋しい"]). 순서는 어댑터가 원본 우선도(JMdict `ke_pri`/`Kanji.common` 등)로 정렬해
       *  `headword[0]`이 대표 표기가 되게 한다. 이표기별 개별 우선도·주석(ateji/구자체 등,
       *  jmdict-simplified `Kanji.tags`)은 스코프에서 제외 — 이 앱에 표기별 우선순위 UI가
       *  없어 당장 필요성이 낮음(dialect 필드를 뺀 것과 동일 판단). */
      headword: string[]
      /** 이 표제어가 단일 단어가 아니라 여러 단어로 굳어진 관용구/구(句)인지 — 다중 단어
       *  선택 시 "부분 조합 해석이 아니라 통째로 뜻을 취해야 한다"는 판단에 실제로 쓰임.
       *  boolean 하나라 크기 부담은 없음(앞서 raw 필드를 크기 문제로 뺀 것과는 별개 사안).
       *  실측 확인 — MW: `fl`(functional label)이 "phrase"(예: "kick the bucket"). JMdict:
       *  `partOfSpeech`가 "exp"(Expressions, 예: "一石二鳥"), 세부적으로 "Yojijukugo"(사자성어)
       *  같은 태그까지 있음. **CC-CEDICT: `(idiom)` 라벨**(실측: 124,732개 항목 중 5,703회) —
       *  다른 사용역 라벨과 똑같이 `usageTags`로 흘려보내지 않고 이 필드로 승격해야 한다(2026-07-28
       *  정정, 이전엔 usageTags 로만 매핑되고 있었음). **Wiktionary(dictionaryapi.dev)는 이 표시가
       *  없음** — "kick the bucket"도 그냥 `partOfSpeech: "verb"`로만 나와 관용구 여부를 알 길이
       *  없음. 이 소스는 이 필드가 항상 undefined. */
      isIdiom?: boolean
      readings: DictionaryReading<L>[]
      source: DictionarySourceId
    }
  : never

// ---- 앱 모드/설정 -----------------------------------------------------------

export type AppMode = 'normal' | 'select'

export type LlmProvider = 'gpt' | 'gemini' | 'claude'

/** keyStore 가 관리하는 모든 API 키의 식별자 — LLM provider 3종 + 사전 API(MW). */
export type ApiKeyId = LlmProvider | 'mw'

export interface AppSettings {
  llm: LlmProvider | null // 사용자가 아직 고르지 않았으면 null (기본 provider 를 임의로 정하지 않는다)
  language: Language | 'auto'
  modeShortcut: string // Electron accelerator 문자열. 기본값: 'Alt+Q' (macOS 는 Option+Q 로 자동 매핑). 빈 문자열 = 단축키 해제
  settingsShortcut: string // 어디서나 설정 화면을 여는 전역 단축키. 기본값: macOS 'Command+,' / 그 외 'Control+,'(settingsStore.ts). 빈 문자열 = 단축키 해제
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

/** 일본어 형태소 분석 엔진 선택지 — main/nlp/japanese.ts JA_ENGINE 상수로만 전환한다(개발자 전용,
 *  사용자 UI 없음). 어느 걸 골라도 아래 tokenizeJapanese/segmentJapaneseWords 계약은 동일하다. */
export type JaEngine = 'lindera' | 'sudachi-b' | 'sudachi-c'

/**
 * 형태소 분석 결과 토큰 하나 — OCR 단어 분리(main/nlp/japanese.ts)와 팝업 원문 문맥 atom
 * 병합(renderer popup/selection.ts) 양쪽에서 공용으로 쓴다. pos/posDetail1 체계는 엔진마다
 * 다르다(lindera=IPADIC 自立·非自立, sudachi=UniDic 一般·非自立可能) — 병합 로직도 그래서
 * 엔진별로 나뉜다(@shared/nlp/ja.ts=IPADIC 용, @shared/nlp/ja-unidic.ts=UniDic 용).
 */
export interface JaToken {
  surface: string
  /** 品詞(품사) 대분류 — 예: 助詞, 助動詞, 動詞, 名詞, 記号 */
  pos: string
  /** 品詞細分類1(품사 세분류 1) — 엔진별 체계가 다름(JaToken 주석 참고). 미분류는 "*" */
  posDetail1: string
  /** 표제어/기본형(예: 活用된 "向かっ" → "向かう") — UniDic 기반 병합(ja-unidic.ts)의 보조동사
   *  판별에 필요. IPADIC 엔진(lindera)도 채워주지만 그쪽 병합 로직은 안 씀. */
  baseForm?: string
  /** 분석 대상 문자열 상 0-based 문자 오프셋 */
  start: number
}

/** IPC TOKENIZE_JA 응답 — 렌더러가 병합 함수(mergeJaTokens vs mergeJaTokensUnidic)를
 *  고르려면 토큰이 어느 엔진 결과인지 알아야 해서 engine 태그를 같이 내려준다. */
export interface JaTokenizeResult {
  engine: JaEngine
  tokens: JaToken[]
}

/** 중국어 분절 엔진 선택지 — zh-Hant(번체) 전용 스위치. main/nlp/chinese.ts ZH_HANT_ENGINE
 *  상수로만 전환한다(개발자 전용, 사용자 UI 없음). zh-Hans(간체)는 항상 jieba(@node-rs/jieba)
 *  고정 — 실측 비교(사내 비교 보고서)로 간체는 jieba 계열이 명확히 앞서 스위치가 불필요했다.
 *  번체는 완전한 승자가 없어(각자 다른 문장에서 실패) 스위치로 남겨둔다.
 *  - 'intl': Intl.Segmenter(ICU 내장) — 의존성 0, 흔한 복합명사·고유명사 과다분절 경향
 *  - 'chinese-tokenizer': CC-CEDICT 그리디 매칭(resources/cedict.u8) — 가든패스 중의성에 약함,
 *    사람 이름 인식은 더 강함 */
export type ZhEngine = 'intl' | 'chinese-tokenizer'

/**
 * 중국어 분절 결과 단어 하나 — OCR 단어 분리(main/nlp/chinese.ts)와 팝업 원문 문맥 atom
 * 구성(renderer popup/selection.ts) 양쪽에서 공용으로 쓴다. jaTokens 와 달리 이미 단어
 * 경계까지 확정된 결과라 병합 없이 그대로 atom 으로 쓸 수 있다. 어느 엔진(jieba/intl/
 * chinese-tokenizer) 결과든 이 shape 로 통일된다.
 */
export interface ZhWord {
  text: string
  /** 분석 대상 문자열 상 0-based 문자 오프셋 */
  start: number
  end: number
}
