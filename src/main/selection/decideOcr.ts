import type { Language, SelectionSource } from '@shared/types'
import { detectLanguage } from './langDetect'

// 담당 A — OCR 사용 여부 판정 (PLAN.md §4.1 / §6)
// 원칙: 직접 추출 먼저 시도, 텍스트가 부족할 때만 OCR fallback.
// 판정 시점: 선택 모드 진입 시 1회 + URL 변화 시 재판정 (URL 을 캐시 키로).

export interface ExtractionDecision {
  mode: 'direct' | 'ocr'
  source: SelectionSource
  language: Language
}

const cache = new Map<string, ExtractionDecision>() // key: url ?? appName

export async function decideExtraction(): Promise<ExtractionDecision> {
  // TODO(담당 A):
  //  1) 활성 대상 식별 (브라우저=확장 / 그 외=접근성 API)로 source·url 파악
  //  2) youtube·netflix·txt → direct / 스캔본 → ocr
  //  3) 전자책 뷰어 → 접근성 API 추출 시도 → 실패 시 ocr
  //  4) pdf·web → 추출 텍스트 양으로 direct vs ocr 분기
  //  5) 자동 감지면 언어 특정
  const source: SelectionSource = { kind: 'web' }
  const language = await detectLanguage()
  const decision: ExtractionDecision = { mode: 'direct', source, language }
  if (source.url) cache.set(source.url, decision)
  return decision
}

export function invalidate(urlKey: string): void {
  cache.delete(urlKey)
}
