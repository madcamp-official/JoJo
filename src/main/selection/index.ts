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
  const anchor = word ? findLineSpan(extracted.words, extracted.words.indexOf(word)) : { start: 0, end: 0 }

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
 * words[targetIdx] 가 extracted.text 안에서 실제로 위치한 [start, end) 오프셋을
 * 찾는다. extracted.text 는 항상 `words.map(w => w.text).join('')`(ocr.ts)로 만들어져
 * words 배열과 정확히 같은 순서 · 같은 문자들이므로, targetIdx 이전 단어들의 글자 수를
 * 그대로 누적하면 오프셋이 나온다 — 텍스트 검색이 전혀 필요 없다.
 *
 * 예전엔 text.indexOf 로 targetIdx 이전에 같은 텍스트가 몇 번 나왔는지 세어 그 순번째
 * occurrence 를 찾는 방식이었는데, "な" 처럼 흔한 한두 글자가 "そんな" 같은 더 긴 단어의
 * 부분 문자열로도 등장하면 개수가 안 맞았다(단어 배열 기준 개수 ≠ 텍스트 문자열 기준
 * 부분 문자열 등장 횟수) — 실측 확인: 클릭한 위치와 다른, 훨씬 앞쪽의 엉뚱한 단어에
 * 매핑됨. 누적 길이 방식은 애초에 같은 순서로 이어붙인 결과라 이런 모호함 자체가 없다.
 */
function findWordSpan(words: Word[], targetIdx: number): { start: number; end: number } {
  if (targetIdx < 0 || targetIdx >= words.length) return { start: 0, end: 0 }
  let start = 0
  for (let i = 0; i < targetIdx; i++) start += words[i]!.text.length
  return { start, end: start + words[targetIdx]!.text.length }
}

/**
 * words[targetIdx] 가 속한 줄(같은 lineId, ocrNdlocr.ts/ocrPaddle.ts/ocr.ts 가 각 줄
 * 단위로 붙여둔 식별자) 전체가 extracted.text 안에서 차지하는 [start, end) 오프셋을
 * 찾는다 — 단어 하나가 아니라 줄 전체를 팝업 초기 선택으로 삼기로 한 결정(2026-07-28).
 * 같은 줄의 단어들은 항상 words 배열에서 연속 구간을 이룬다(줄 단위로 만들어져
 * 이어붙여지므로) — findWordSpan 과 같은 누적 길이 방식을 그 구간 전체에 적용한다.
 * lineId 가 없으면(direct 추출 등 줄 정보를 안 주는 경로) 단어 하나만의 범위로 폴백한다.
 */
function findLineSpan(words: Word[], targetIdx: number): { start: number; end: number } {
  if (targetIdx < 0 || targetIdx >= words.length) return { start: 0, end: 0 }
  const lineId = words[targetIdx]!.lineId
  if (!lineId) return findWordSpan(words, targetIdx)
  let first = targetIdx
  while (first > 0 && words[first - 1]!.lineId === lineId) first--
  let last = targetIdx
  while (last < words.length - 1 && words[last + 1]!.lineId === lineId) last++
  const { start } = findWordSpan(words, first)
  const { end } = findWordSpan(words, last)
  return { start, end }
}
