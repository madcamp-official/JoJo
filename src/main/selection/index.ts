import type { ExtractedSelection, Word } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'
import { getExtraction } from './extractionCache'
import { buildSubtitleSelection, isSubtitleModeActive } from './subtitleSource'

// ============================================================================
// 담당 A — 선택 준비 & 추출 파이프라인 (PLAN.md §4.1 / §8) — 팝업 전까지
// 선택 모드 진입 시 미리 캡처+추출해둔 캐시(extractionCache.ts)에서 클릭 좌표에
// 해당하는 단어를 찾아 → ExtractedSelection 생성 (B 로 전달, 최종 선택 확정은 B가 팝업에서)
// ============================================================================

export async function runSelectionPipeline(point: {
  x: number
  y: number
}): Promise<ExtractedSelection> {
  // 자막 경로(유튜브/넷플릭스)면 확장 자막에서 앞뒤 범위 문맥과 함께 만든다.
  if (isSubtitleModeActive()) {
    const sub = buildSubtitleSelection(point)
    if (sub) return sub
    // 클릭 지점에 자막 단어가 없으면(빈 곳 클릭) 빈 선택으로 폴백 — 팝업은 안 띄우는 게
    // 자연스럽지만 기존 계약이 항상 ExtractedSelection 을 반환하므로 빈 값을 준다.
    return {
      text: '',
      anchor: { start: 0, end: 0 },
      words: [],
      language: 'en',
      source: { kind: 'youtube' },
      extraction: 'direct',
    }
  }

  const extracted = await getExtraction()

  const word = findWordAtPoint(extracted.words, point)
  const anchor = word
    ? findWordSpan(extracted.text, extracted.words, extracted.words.indexOf(word))
    : { start: 0, end: 0 }

  return {
    text: extracted.text,
    anchor,
    words: extracted.words,
    language: extracted.language,
    source: extracted.source,
    extraction: extracted.extraction,
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
