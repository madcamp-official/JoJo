// 공동 소유 — 커서 좌표 ↔ 단어 매핑 (PLAN.md §4.1 "선택 · 좌표 매핑")
// 입력 words 는 어떤 추출 경로(직접 추출/OCR)로 왔든 동일한 Word[] 형태이므로,
// 이 매핑 로직은 추출 방식과 무관하게 재사용된다.
import type { Point, Rect, Word } from './types'

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

/**
 * 주어진 좌표 아래 단어가 속한 줄(같은 lineId) 전체를 반환한다 — 단어 단위가 아니라
 * 줄 단위로 hover/선택하기로 한 결정(2026-07-28)에 따라 findWordAtPoint 위에 얹은
 * 래퍼. lineId 가 없으면(추출 경로가 줄 정보를 안 주는 경우, 예: direct 추출) 그
 * 단어 하나만 담긴 배열로 폴백한다 — "줄 전체"라는 개념 자체가 없는 경로이므로.
 */
export function findLineWordsAtPoint(words: Word[], point: Point): Word[] {
  const hit = findWordAtPoint(words, point)
  if (!hit) return []
  if (!hit.lineId) return [hit]
  return words.filter((w) => w.lineId === hit.lineId)
}

/** Word[] 전체를 감싸는 bbox(합집합) — bbox 없는 단어는 무시. 하나도 없으면 null. */
export function unionBbox(words: Word[]): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of words) {
    if (!w.bbox) continue
    minX = Math.min(minX, w.bbox.x)
    minY = Math.min(minY, w.bbox.y)
    maxX = Math.max(maxX, w.bbox.x + w.bbox.width)
    maxY = Math.max(maxY, w.bbox.y + w.bbox.height)
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
