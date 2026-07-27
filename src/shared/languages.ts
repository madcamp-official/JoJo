import type { Language } from './types'

// 공동 소유 — 언어별 정적 데이터 단일 출처 (PLAN.md §1: 영어/일본어/중국어, 추후 확장 고려)
//
// 언어를 추가하려면:
//   1. types.ts 의 `Language` 유니온에 코드 추가 (예: 'fr')
//   2. 아래 LANGUAGES 에 해당 코드의 항목을 채운다.
//      → 빠뜨리면 `Record<Language, LanguageInfo>` 타입 에러로 즉시 드러난다.
//   3. `Record<Language, ...>` 를 쓰는 다른 곳(신규 파일 포함)도 동일하게 컴파일 에러로 안내된다.
//   4. 이 레지스트리 밖의 언어별 작업도 함께 갱신 필요 (아직 자동화되지 않음, TODO.md 참고):
//      - 담당 A: OCR 언어 감지/언어팩 (selection/langDetect.ts, selection/ocr.ts)
//      - 담당 B: 설정 화면 언어 선택지, 사전 API 소스, 발음 표기 체계(IPA/히라가나/병음 등)

export interface LanguageInfo {
  /** LLM 프롬프트 등에 쓰는 한국어 표기 언어명 */
  name: string
  /** 구글 발음 검색 시 텍스트 뒤에 붙일 접미어 */
  googleSearchSuffix: string
  /** 발음 프롬프트에서 LLM에게 요구할 표기 체계(한국어 설명) */
  pronunciationNotation: string
  /** 네이버 사전 서브도메인(en/ja/zh.dict.naver.com) — 네이버는 간체/번체를 구분하지 않고
   * 하나의 zh 서브도메인만 제공하므로 zh-Hans/zh-Hant 모두 'zh'로 매핑한다. */
  naverDictSubdomain: string
}

export const LANGUAGES: Record<Language, LanguageInfo> = {
  en: {
    name: '영어',
    googleSearchSuffix: 'pronunciation',
    pronunciationNotation: '국제음성기호(IPA)',
    naverDictSubdomain: 'en',
  },
  ja: {
    name: '일본어',
    googleSearchSuffix: '読み方',
    pronunciationNotation: '히라가나',
    naverDictSubdomain: 'ja',
  },
  'zh-Hans': {
    name: '중국어(간체)',
    googleSearchSuffix: '拼音',
    pronunciationNotation: '한어병음(성조 표시 포함)',
    naverDictSubdomain: 'zh',
  },
  'zh-Hant': {
    name: '중국어(번체)',
    googleSearchSuffix: '拼音',
    pronunciationNotation: '한어병음(성조 표시 포함)',
    naverDictSubdomain: 'zh',
  },
}

export const LANGUAGE_ORDER: Language[] = ['en', 'ja', 'zh-Hans', 'zh-Hant']
