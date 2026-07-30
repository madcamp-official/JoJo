import type { AnyLanguage, Language, LinkLanguage } from './types'

// 공동 소유 — 언어별 정적 데이터 단일 출처 (PLAN.md §1: 영어/일본어/중국어 tier1 + 2026-07-30
// 확장된 tier2/tier3 언어 등급제). 언어 하나에 대해 필요한 값(한국어 표기명/원어 표기명/
// 구글 발음 검색 접미어/발음 표기 체계/네이버 사전 연결 정보/OCR 언어팩 코드)이 전부 이
// 파일 하나의 LANGUAGES(tier1)/LINK_LANGUAGES(tier2) 두 레지스트리에만 있다 — 다른 파일은
// 절대 이 값들을 직접 하드코딩하지 않고 아래 get* 접근자를 통해서만 읽는다(예전엔
// PopupScreen.tsx가 이름을 자체 Record로 중복 관리하고 있었음, 2026-07-30 정리).
//
// tier1(LANGUAGES) 언어를 추가하려면:
//   1. types.ts 의 `Language` 유니온에 코드 추가 (예: 'fr')
//   2. 아래 LANGUAGES 에 해당 코드의 항목을 채운다.
//      → 빠뜨리면 `Record<Language, LanguageInfo>` 타입 에러로 즉시 드러난다.
//   3. `Record<Language, ...>` 를 쓰는 다른 곳(신규 파일 포함)도 동일하게 컴파일 에러로 안내된다.
//   4. `question/dictionary.ts`의 `FALLBACK_CHAINS`에 사전 소스 체인을 추가한다(LLM 사전
//      기능은 tier1 전용).
//
// tier2(LINK_LANGUAGES) 언어를 tier1로 승격하려면: types.ts의 LinkLanguage 유니온에서
// 빼서 Language 유니온으로 옮기고, 아래 LINK_LANGUAGES 항목을 LANGUAGES로 그대로 옮긴 뒤
// (koName/nativeName/googleSearchSuffix/pronunciationNotation/ocrLang 필드 구조가 동일해서
// 값 그대로 재사용 가능) naverDictSubdomain만 다시 정하고, FALLBACK_CHAINS에 사전 소스를
// 추가하면 된다.

export interface LanguageInfo {
  /** LLM 프롬프트·팝업 헤더 등에 쓰는 한국어 표기 언어명 */
  koName: string
  /** 그 언어 자체로 쓴 이름(예: 프랑스어 → Français) — 설정 화면 언어 선택지처럼
   * 원어 표기가 필요한 곳에서 쓴다. */
  nativeName: string
  /** 구글 발음 검색 시 텍스트 뒤에 붙일 접미어 */
  googleSearchSuffix: string
  /** 발음 프롬프트에서 LLM에게 요구할 표기 체계(한국어 설명) */
  pronunciationNotation: string
  /** 네이버 사전 서브도메인(en/ja/zh.dict.naver.com) — 네이버는 간체/번체를 구분하지 않고
   * 하나의 zh 서브도메인만 제공하므로 zh-Hans/zh-Hant 모두 'zh'로 매핑한다. */
  naverDictSubdomain: string
  /** Tesseract 언어팩 코드(ISO 639-2/3, `createWorker()`에 그대로 넘김) */
  ocrLang: string
}

export const LANGUAGES: Record<Language, LanguageInfo> = {
  en: {
    koName: '영어',
    nativeName: 'English',
    googleSearchSuffix: 'pronunciation',
    pronunciationNotation: '국제음성기호(IPA)',
    naverDictSubdomain: 'en',
    ocrLang: 'eng',
  },
  ja: {
    koName: '일본어',
    nativeName: '日本語',
    googleSearchSuffix: '読み方',
    pronunciationNotation: '히라가나',
    naverDictSubdomain: 'ja',
    ocrLang: 'jpn',
  },
  'zh-Hans': {
    koName: '중국어(간체)',
    nativeName: '简体中文',
    googleSearchSuffix: '拼音',
    pronunciationNotation: '한어병음(성조 표시 포함)',
    naverDictSubdomain: 'zh',
    ocrLang: 'chi_sim',
  },
  'zh-Hant': {
    koName: '중국어(번체)',
    nativeName: '繁體中文',
    googleSearchSuffix: '拼音',
    pronunciationNotation: '한어병음(성조 표시 포함)',
    naverDictSubdomain: 'zh',
    ocrLang: 'chi_tra',
  },
}

export const LANGUAGE_ORDER: Language[] = ['en', 'ja', 'zh-Hans', 'zh-Hant']

/** tier2 언어 정보 — LLM 사전(FALLBACK_CHAINS)만 없을 뿐 필드 구조는 LanguageInfo와 동일하게
 * 맞춰서, tier1로 승격할 때 값을 그대로 옮길 수 있게 했다. `naverDictCode`가 있으면
 * tier2-A(구글+네이버), 없으면 tier2-B(구글만)다 — 네이버 사전 URL은 tier1과 패턴이 달라서
 * (서브도메인이 아니라 `dict.naver.com/{code}kodict/` 경로, 2026-07-30 실측 확인) 별도
 * 필드/빌더로 뒀다. */
export interface LinkLanguageInfo {
  koName: string
  nativeName: string
  googleSearchSuffix: string
  /** tier2는 전부 IPA로 통일(2026-07-30 결정) — 언어별 학습 관행상 IPA보다 자연스러운
   * 대안 표기(예: 태국어 RTGS+성조, 러시아어 강세표시 키릴)가 있는 언어도 있으나, 그런
   * 예외를 언어별로 검증하는 비용이 커서 우선 보류. 실사용 후 필요해지면 이 값만 바꾸면 됨. */
  pronunciationNotation: string
  /** dict.naver.com/{code}kodict/ 의 {code} — 없으면(undefined) 네이버 사전 미지원(tier2-B) */
  naverDictCode?: string
  ocrLang: string
}

export const LINK_LANGUAGES: Record<LinkLanguage, LinkLanguageInfo> = {
  // ── tier2-A: 구글 + 네이버 사전 둘 다 ──────────────────────────────────────
  ar: { koName: '아랍어', nativeName: 'العربية', googleSearchSuffix: 'نُطْق', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'ar', ocrLang: 'ara' },
  cs: { koName: '체코어', nativeName: 'Čeština', googleSearchSuffix: 'výslovnost', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'cs', ocrLang: 'ces' },
  da: { koName: '덴마크어', nativeName: 'Dansk', googleSearchSuffix: 'udtale', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'da', ocrLang: 'dan' },
  de: { koName: '독일어', nativeName: 'Deutsch', googleSearchSuffix: 'Aussprache', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'de', ocrLang: 'deu' },
  el: { koName: '그리스어', nativeName: 'Ελληνικά', googleSearchSuffix: 'προφορά', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'el', ocrLang: 'ell' },
  es: { koName: '스페인어', nativeName: 'Español', googleSearchSuffix: 'pronunciación', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'es', ocrLang: 'spa' },
  fa: { koName: '페르시아어', nativeName: 'فارسی', googleSearchSuffix: 'تَلَفُّظ', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'fa', ocrLang: 'fas' },
  fi: { koName: '핀란드어', nativeName: 'Suomi', googleSearchSuffix: 'ääntämys', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'fi', ocrLang: 'fin' },
  fr: { koName: '프랑스어', nativeName: 'Français', googleSearchSuffix: 'prononciation', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'fr', ocrLang: 'fra' },
  he: { koName: '히브리어', nativeName: 'עברית', googleSearchSuffix: 'הֲגִיָּה', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'he', ocrLang: 'heb' },
  hi: { koName: '힌디어', nativeName: 'हिन्दी', googleSearchSuffix: 'उच्चारण', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'hi', ocrLang: 'hin' },
  hr: { koName: '크로아티아어', nativeName: 'Hrvatski', googleSearchSuffix: 'izgovor', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'hr', ocrLang: 'hrv' },
  hu: { koName: '헝가리어', nativeName: 'Magyar', googleSearchSuffix: 'kiejtés', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'hu', ocrLang: 'hun' },
  it: { koName: '이탈리아어', nativeName: 'Italiano', googleSearchSuffix: 'pronuncia', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'it', ocrLang: 'ita' },
  ka: { koName: '조지아어', nativeName: 'ქართული', googleSearchSuffix: 'წარმოთქმა', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'ka', ocrLang: 'kat' },
  lo: { koName: '라오어', nativeName: 'ລາວ', googleSearchSuffix: 'ການອອກສຽງ', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'lo', ocrLang: 'lao' },
  nl: { koName: '네덜란드어', nativeName: 'Nederlands', googleSearchSuffix: 'uitspraak', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'nl', ocrLang: 'nld' },
  no: { koName: '노르웨이어', nativeName: 'Norsk', googleSearchSuffix: 'uttale', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'no', ocrLang: 'nor' },
  pl: { koName: '폴란드어', nativeName: 'Polski', googleSearchSuffix: 'wymowa', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'pl', ocrLang: 'pol' },
  pt: { koName: '포르투갈어', nativeName: 'Português', googleSearchSuffix: 'pronúncia', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'pt', ocrLang: 'por' },
  ro: { koName: '루마니아어', nativeName: 'Română', googleSearchSuffix: 'pronunție', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'ro', ocrLang: 'ron' },
  ru: { koName: '러시아어', nativeName: 'Русский', googleSearchSuffix: 'произношение', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'ru', ocrLang: 'rus' },
  sq: { koName: '알바니아어', nativeName: 'Shqip', googleSearchSuffix: 'shqiptim', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'sq', ocrLang: 'sqi' },
  sv: { koName: '스웨덴어', nativeName: 'Svenska', googleSearchSuffix: 'uttal', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'sv', ocrLang: 'swe' },
  th: { koName: '태국어', nativeName: 'ไทย', googleSearchSuffix: 'การออกเสียง', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'th', ocrLang: 'tha' },
  // 타갈로그어: 네이버/eld 둘 다 코드는 'tl'이지만, Tesseract 경량(양자화) 언어팩엔 'tgl'이
  // 없다(2026-07-30 실측, jsdelivr 404) — 대신 사실상 표준화된 타갈로그어인 'fil'(필리핀어)
  // 팩을 씀. 1.5MB로 다른 언어들과 비슷한 크기.
  tl: { koName: '타갈로그어', nativeName: 'Tagalog', googleSearchSuffix: 'bigkas', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'tl', ocrLang: 'fil' },
  tr: { koName: '터키어', nativeName: 'Türkçe', googleSearchSuffix: 'telaffuz', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'tr', ocrLang: 'tur' },
  uk: { koName: '우크라이나어', nativeName: 'Українська', googleSearchSuffix: 'вимова', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'uk', ocrLang: 'ukr' },
  ur: { koName: '우르두어', nativeName: 'اردو', googleSearchSuffix: 'تَلَفُّظ', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'ur', ocrLang: 'urd' },
  vi: { koName: '베트남어', nativeName: 'Tiếng Việt', googleSearchSuffix: 'cách phát âm', pronunciationNotation: '국제음성기호(IPA)', naverDictCode: 'vi', ocrLang: 'vie' },

  // ── tier2-B: 구글만(네이버 사전 없음) ──────────────────────────────────────
  am: { koName: '암하라어', nativeName: 'አማርኛ', googleSearchSuffix: 'አነጋገር', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'amh' },
  az: { koName: '아제르바이잔어', nativeName: 'Azərbaycanca', googleSearchSuffix: 'tələffüz', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'aze' },
  be: { koName: '벨라루스어', nativeName: 'Беларуская', googleSearchSuffix: 'вымаўленне', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'bel' },
  bg: { koName: '불가리아어', nativeName: 'Български', googleSearchSuffix: 'произношение', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'bul' },
  bn: { koName: '벵골어', nativeName: 'বাংলা', googleSearchSuffix: 'উচ্চারণ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'ben' },
  ca: { koName: '카탈루냐어', nativeName: 'Català', googleSearchSuffix: 'pronunciació', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'cat' },
  et: { koName: '에스토니아어', nativeName: 'Eesti', googleSearchSuffix: 'hääldus', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'est' },
  eu: { koName: '바스크어', nativeName: 'Euskara', googleSearchSuffix: 'ahoskera', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'eus' },
  gu: { koName: '구자라트어', nativeName: 'ગુજરાતી', googleSearchSuffix: 'ઉચ્ચારણ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'guj' },
  hy: { koName: '아르메니아어', nativeName: 'Հայերեն', googleSearchSuffix: 'արտասանություն', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'hye' },
  is: { koName: '아이슬란드어', nativeName: 'Íslenska', googleSearchSuffix: 'framburður', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'isl' },
  kn: { koName: '칸나다어', nativeName: 'ಕನ್ನಡ', googleSearchSuffix: 'ಉಚ್ಚಾರಣೆ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'kan' },
  // 한국어: eld/네이버 둘 다 기술적으로 지원하나, 네이버 사전은 "외국어→한국어" 구조라
  // 한국어 자체를 넣을 대상이 마땅치 않아 구글만 연결(2026-07-30, 사용자 결정 — 지금은
  // 화자 확장 가능성을 대비해 tier2로 포함해둠).
  ko: { koName: '한국어', nativeName: '한국어', googleSearchSuffix: '발음', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'kor' },
  // 쿠르드어(ku)는 2026-07-30 tier2 도입 때 등록했다가 전수조사(2026-07-30) 후 제외했다 —
  // Tesseract 팩은 쿠르만지 방언(kmr, 라틴 문자)뿐인데 eld의 'ku' 모델은 소라니 방언(아랍
  // 문자, node_modules/eld/README.md "Kurdish (Arabic)")을 학습한 것이라, 같은 코드가 OCR과
  // 자동판별에서 서로 다른 방언/문자체계를 가리켜 화면 캡처(OCR) 경로에서 구조적으로 자동판별이
  // 안 된다(스크립트 후보 배열에 추가해도 eld가 라틴 문자 텍스트를 'ku'로 반환할 일이 없어
  // 무의미). tier3(미지원)로 되돌림 — 언어팩·API 재조사로 아랍 문자 소라니 OCR 지원이 붙거나
  // eld가 방언을 분리하게 되면 재검토.
  lt: { koName: '리투아니아어', nativeName: 'Lietuvių', googleSearchSuffix: 'tarimas', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'lit' },
  lv: { koName: '라트비아어', nativeName: 'Latviešu', googleSearchSuffix: 'izruna', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'lav' },
  ml: { koName: '말라얄람어', nativeName: 'മലയാളം', googleSearchSuffix: 'ഉച്ചാരണം', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'mal' },
  mr: { koName: '마라티어', nativeName: 'मराठी', googleSearchSuffix: 'उच्चार', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'mar' },
  ms: { koName: '말레이어', nativeName: 'Bahasa Melayu', googleSearchSuffix: 'sebutan', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'msa' },
  or: { koName: '오리야어', nativeName: 'ଓଡ଼ିଆ', googleSearchSuffix: 'ଉଚ୍ଚାରଣ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'ori' },
  pa: { koName: '펀자브어', nativeName: 'ਪੰਜਾਬੀ', googleSearchSuffix: 'ਉਚਾਰਨ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'pan' },
  sk: { koName: '슬로바키아어', nativeName: 'Slovenčina', googleSearchSuffix: 'výslovnosť', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'slk' },
  sl: { koName: '슬로베니아어', nativeName: 'Slovenščina', googleSearchSuffix: 'izgovorjava', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'slv' },
  sr: { koName: '세르비아어', nativeName: 'Српски', googleSearchSuffix: 'изговор', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'srp' },
  ta: { koName: '타밀어', nativeName: 'தமிழ்', googleSearchSuffix: 'உச்சரிப்பு', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'tam' },
  te: { koName: '텔루구어', nativeName: 'తెలుగు', googleSearchSuffix: 'ఉచ్ఛారణ', pronunciationNotation: '국제음성기호(IPA)', ocrLang: 'tel' },
}

export function isFullLanguage(lang: AnyLanguage): lang is Language {
  return lang in LANGUAGES
}

/** tier1이면 LANGUAGES, tier2면 LINK_LANGUAGES에서 값을 가져오는 공용 접근자 — tier 구분
 * 없이 "이 언어의 X가 뭐냐"만 물을 때 쓴다. 다른 파일은 LANGUAGES/LINK_LANGUAGES를 직접
 * 인덱싱하지 말고 항상 이 아래 get* 함수들을 통해서만 값을 읽는다. */
function infoOf(lang: AnyLanguage): LanguageInfo | LinkLanguageInfo {
  return isFullLanguage(lang) ? LANGUAGES[lang] : LINK_LANGUAGES[lang]
}

export function getLanguageName(lang: AnyLanguage): string {
  return infoOf(lang).koName
}

export function getNativeLanguageName(lang: AnyLanguage): string {
  return infoOf(lang).nativeName
}

export function getGoogleSearchSuffix(lang: AnyLanguage): string {
  return infoOf(lang).googleSearchSuffix
}

export function getPronunciationNotation(lang: AnyLanguage): string {
  return infoOf(lang).pronunciationNotation
}

/** Tesseract 언어팩 코드. tier1/tier2 어느 쪽이든(=tier3만 아니면) 항상 있다. */
export function getOcrLangCode(lang: AnyLanguage): string {
  return infoOf(lang).ocrLang
}

/** 네이버 사전 버튼을 보여줘도 되는지(tier1 전부 + tier2-A) — tier2-B는 false. 팝업
 * 툴바가 이 값으로 네이버 버튼 노출 여부를 정한다(URL을 실제로 만들어보지 않고 미리
 * 판정 가능하도록 별도 함수로 뺌). */
export function hasNaverDict(lang: AnyLanguage): boolean {
  return isFullLanguage(lang) || LINK_LANGUAGES[lang].naverDictCode !== undefined
}

/** 오른쪽에서 왼쪽으로 쓰는 언어(tier2 중 아랍어/페르시아어/히브리어/우르두어) — 팝업
 * 본문의 기본 텍스트 방향(dir 속성)을 정할 때 쓴다(2026-07-30). 드래그 선택 자체는
 * `document.caretRangeFromPoint`(브라우저 네이티브, bidi 인식)와 atom index(항상 논리
 * 순서) 기반이라 이 목록과 무관하게 이미 정확하다 — 여긴 순수 레이아웃(정렬 방향)용. */
const RTL_LANGUAGES: ReadonlySet<AnyLanguage> = new Set(['ar', 'fa', 'he', 'ur'])

export function isRtlLanguage(lang: AnyLanguage): boolean {
  return RTL_LANGUAGES.has(lang)
}

/** 네이버 사전 링크 URL. tier1은 서브도메인 방식(`{code}.dict.naver.com`), tier2-A는
 * 경로 방식(`dict.naver.com/{code}kodict/`, 2026-07-30 실측 확인 — 서브도메인 아님
 * 주의)이라 패턴 자체가 다르다. tier2-B(naverDictCode 없음)는 null. */
export function getNaverDictUrl(lang: AnyLanguage, text: string): string | null {
  const query = encodeURIComponent(text)
  if (isFullLanguage(lang)) {
    return `https://${LANGUAGES[lang].naverDictSubdomain}.dict.naver.com/#/search?query=${query}`
  }
  const code = LINK_LANGUAGES[lang].naverDictCode
  return code ? `https://dict.naver.com/${code}kodict/#/search?query=${query}` : null
}
