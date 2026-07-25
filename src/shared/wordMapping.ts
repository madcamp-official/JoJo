// 공동 소유 — 커서 좌표 ↔ 단어 매핑 (PLAN.md §4.1 "선택 · 좌표 매핑")
// 입력 words 는 어떤 추출 경로(직접 추출/OCR)로 왔든 동일한 Word[] 형태이므로,
// 이 매핑 로직은 추출 방식과 무관하게 재사용된다.
import type { Point, Word } from './types'

function containsPoint(bbox: NonNullable<Word['bbox']>, point: Point): boolean {
  return (
    point.x >= bbox.x &&
    point.x < bbox.x + bbox.width &&
    point.y >= bbox.y &&
    point.y < bbox.y + bbox.height
  )
}

/**
 * 주어진 좌표(점) 아래에 있는 단어를 찾는다. bbox 가 겹치는 경우 더 작은(좁은) 박스를
 * 우선한다 — 큰 컨테이너 박스보다 실제 단어 박스를 먼저 골라야 하는 경우가 많아서다.
 */
export function findWordAtPoint(words: Word[], point: Point): Word | null {
  let best: Word | null = null
  let bestArea = Infinity

  for (const word of words) {
    if (!word.bbox || !containsPoint(word.bbox, point)) continue
    const area = word.bbox.width * word.bbox.height
    if (area < bestArea) {
      best = word
      bestArea = area
    }
  }
  return best
}
