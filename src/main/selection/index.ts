import type { ExtractedSelection, Word } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'
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

  const word = findWordAtPoint(extracted.words, point)
  const anchor = word
    ? findWordSpan(extracted.text, extracted.words, extracted.words.indexOf(word))
    : { start: 0, end: 0 }

  return {
    text: extracted.text,
    anchor,
    words: extracted.words,
    language: extracted.language,
    source: decision.source,
    extraction: decision.mode,
  }
}

/**
 * words[targetIdx] 가 text 안에서 실제로 위치한 [start, end) 오프셋을 찾는다.
 * 같은 표현이 여러 번 등장할 수 있어(예: "the"), words 배열 상 targetIdx 이전에
 * 나온 동일 텍스트 개수만큼 건너뛰어 올바른 occurrence 를 짚는다.
 */
function findWordSpan(
  text: string,
  words: Word[],
  targetIdx: number,
): { start: number; end: number } {
  if (targetIdx < 0) return { start: 0, end: 0 }
  const target = words[targetIdx]!
  let occurrenceBefore = 0
  for (let i = 0; i < targetIdx; i++) {
    if (words[i]!.text === target.text) occurrenceBefore++
  }
  let searchFrom = 0
  for (let i = 0; i <= occurrenceBefore; i++) {
    const idx = text.indexOf(target.text, searchFrom)
    if (idx < 0) return { start: 0, end: 0 }
    if (i === occurrenceBefore) return { start: idx, end: idx + target.text.length }
    searchFrom = idx + target.text.length
  }
  return { start: 0, end: 0 }
}
