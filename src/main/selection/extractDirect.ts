import type { Language, SelectionSource, Word } from '@shared/types'

// 담당 A — 소스별 직접 텍스트 추출 (PLAN.md §4.1 / §6)
//  - txt/epub/pdf : 원본 파일 파싱 → 텍스트-좌표
//  - web          : DOM 텍스트 (확장 경유), 태그 제외 후 문단 잇기
//  - 전자책 뷰어  : 접근성 API 렌더 텍스트

export interface Extracted {
  /** 추출된 전체 텍스트 — ExtractedSelection.text/anchor 계산의 기준 문자열 */
  text: string
  language: Language
  words: Word[]
}

export async function extractDirect(_source: SelectionSource): Promise<Extracted> {
  // TODO(담당 A): source.kind 별 파서 분기 + 좌표 매핑.
  return { text: '', language: 'en', words: [] }
}
