import type { ExtractedSelection } from '@shared/types'
import { captureFocusedWindow } from './capture'
import { decideExtraction } from './decideOcr'
import { extractDirect } from './extractDirect'
import { runOcr } from './ocr'

// ============================================================================
// 담당 A — 선택 준비 & 추출 파이프라인 (PLAN.md §4.1 / §7) — 팝업 전까지
// 선택 모드 활성화 → OCR 여부 판정 → 텍스트+좌표 추출 → 클릭 단어 매핑
// → ExtractedSelection 생성 (B 로 전달, 최종 선택 확정은 B가 팝업에서)
// ============================================================================

export async function runSelectionPipeline(point: {
  x: number
  y: number
}): Promise<ExtractedSelection> {
  const decision = await decideExtraction()

  const extracted =
    decision.mode === 'ocr'
      ? await runOcr(await captureFocusedWindow(), decision.language)
      : await extractDirect(decision.source)

  // TODO(담당 A): point 좌표 ↔ 단어 매핑으로 클릭 표현의 anchor 오프셋 + 근방 text 구성.
  void point
  return {
    text: '',
    anchor: { start: 0, end: 0 },
    words: extracted.words,
    language: extracted.language,
    source: decision.source,
    extraction: decision.mode,
  }
}
