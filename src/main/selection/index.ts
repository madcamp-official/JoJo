import type { SelectionContext } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'
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

  const word = findWordAtPoint(extracted.words, point)

  // TODO(팀원): 앞뒤 문맥(precedingText/followingText) 구성 — 클릭 vs 드래그 구분과
  // 함께 팝업 범위 지정 담당자가 처리 (선택·좌표 매핑 항목 참고).
  return {
    selectedText: word?.text ?? '',
    language: extracted.language,
    precedingText: '',
    followingText: '',
    words: extracted.words,
    source: decision.source,
    extraction: decision.mode,
  }
}
