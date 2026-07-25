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
}

export const LANGUAGES: Record<Language, LanguageInfo> = {
  en: { name: '영어', googleSearchSuffix: 'Pronunciation' },
  ja: { name: '일본어', googleSearchSuffix: '読み方' },
  zh: { name: '중국어', googleSearchSuffix: '拼音' },
}

export const LANGUAGE_ORDER: Language[] = ['en', 'ja', 'zh']
