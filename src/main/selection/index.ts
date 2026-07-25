import type { SelectionContext } from '@shared/types'
import { captureFocusedWindow } from './capture'
import { decideExtraction } from './decideOcr'
import { extractDirect } from './extractDirect'
import { runOcr } from './ocr'

// ============================================================================
// 담당 A — 선택 & 추출 파이프라인 (PLAN.md §4.1 / §7)
// 선택 모드 활성화 → OCR 여부 판정 → 텍스트+좌표 추출 → 커서 단어 매핑
// → SelectionContext 생성 (B 로 전달)
// ============================================================================

export async function runSelectionPipeline(point: {
  x: number
  y: number
}): Promise<SelectionContext> {
  const decision = await decideExtraction()

  const extracted =
    decision.mode === 'ocr'
      ? await runOcr(await captureFocusedWindow(), decision.language)
      : await extractDirect(decision.source)

  // TODO(담당 A): point 좌표 ↔ 단어 매핑, 앞뒤 문맥(precedingText/followingText) 구성.
  return {
    selectedText: '',
    language: extracted.language,
    precedingText: '',
    followingText: '',
    words: extracted.words,
    source: decision.source,
    extraction: decision.mode,
  }
}
