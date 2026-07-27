import type { Language, SelectionSource, Word } from '@shared/types'
import { readWindowText } from './accessibility'
import { getSelectedWindowId } from './capture'

// 담당 A — 소스별 직접 텍스트 추출 (PLAN.md §4.1 / §7)
//  - txt(표준 텍스트 컨트롤) : 접근성(WM_GETTEXT)으로 렌더 텍스트 직접 읽기 — 구현됨
//  - epub/pdf     : 원본 파일 파싱 → 텍스트-좌표
//  - web          : DOM 텍스트 (확장 경유), 태그 제외 후 문단 잇기
//  - 전자책 뷰어  : 접근성 API 렌더 텍스트

export interface Extracted {
  /** 추출된 전체 텍스트 — ExtractedSelection.text/anchor 계산의 기준 문자열 */
  text: string
  language: Language
  words: Word[]
}

export async function extractDirect(source: SelectionSource): Promise<Extracted> {
  if (source.kind === 'txt') {
    const id = getSelectedWindowId()
    const text = id ? await readWindowText(BigInt(id)) : null
    // words 는 빈 배열 — 접근성으로 읽은 텍스트엔 화면 좌표가 없어(OCR 과 달리 bbox 를
    // 만들 수 없음) 클릭 지점 ↔ 단어 매핑이 안 된다. findWordAtPoint 가 null 을 반환해
    // anchor 가 {0,0}으로 떨어지는 정도는 감수 — 팝업 안에서 범위를 다시 지정하면 됨.
    if (text) return { text, language: 'en', words: [] }
  }
  // TODO(담당 A): epub/pdf/web 소스별 파서 분기 + 좌표 매핑.
  return { text: '', language: 'en', words: [] }
}
