import type { Language } from '@shared/types'

// 담당 A — 언어 자동 감지 (PLAN.md §4.1 / §5)
// 자동 감지 + OCR 필요 시, 언어 특화 OCR 전에 경량 분류/범용 OCR 로 언어 특정.

export async function detectLanguage(_sample?: string): Promise<Language> {
  // TODO(담당 A): 유니코드 블록 비율 기반 경량 분류 → en/ja/zh.
  return 'en'
}
