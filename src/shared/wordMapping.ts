// 공동 소유 — 커서 좌표 ↔ 단어 매핑 (PLAN.md §5.1 "선택 · 좌표 매핑")
// 입력 words 는 어떤 추출 경로(직접 추출/OCR)로 왔든 동일한 Word[] 형태이므로,
// 이 매핑 로직은 추출 방식과 무관하게 재사용된다.
import type { SubWord } from './extension'
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

/** x/y/width/height 를 가진 사각형 여럿의 합집합(bounding box) — 하나도 없으면 null.
 *  Word.bbox, 확장의 RectPx, DOMRect(getClientRects()) 모두 이 셰이프를 만족해 그대로 쓸 수 있다. */
export function unionRects(rects: { x: number; y: number; width: number; height: number }[]): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Word[] 전체를 감싸는 bbox(합집합) — bbox 없는 단어는 무시. 하나도 없으면 null. */
export function unionBbox(words: Word[]): Rect | null {
  return unionRects(words.filter((w) => w.bbox).map((w) => w.bbox!))
}

/**
 * 사각형들을 화면상 줄(y 겹침 기준)로 묶어, 줄마다 하나씩 합집합 사각형을 만든다 — CJK
 * 형태소 분석 결과(예: "当地政府")가 화면 줄바꿈 지점에 걸치면, 앞쪽 절반은 그 줄 오른쪽
 * 끝 근처에, 뒤쪽 절반은 다음 줄 왼쪽 끝 근처에 위치한다. 이 rect들을 통째로 `unionRects`
 * 하나로 묶으면 min/max x가 두 줄의 양쪽 여백까지 벌어져, 실제 글자 폭과 무관하게 두 줄
 * 전체 너비를 덮는 박스가 나온다(실사용 확인, 2026-07-30 — "선택 영역이 두 줄에 걸치면
 * 두 줄이 통째로 하이라이트됨"). 줄별로 먼저 묶고 그 안에서만 합집합을 내면 이런 걸치기가
 * 애초에 생기지 않는다 — 호출부(articleHighlight.ts/highlight.ts)는 박스 하나 대신 줄
 * 개수만큼의 박스를 그려야 한다.
 */
export function groupRectsByLine(rects: { x: number; y: number; width: number; height: number }[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y)
  const lines: { x: number; y: number; width: number; height: number }[][] = []
  for (const r of sorted) {
    const last = lines[lines.length - 1]
    const lastRect = last?.[last.length - 1]
    const overlaps = lastRect ? r.y < lastRect.y + lastRect.height && r.y + r.height > lastRect.y : false
    if (last && overlaps) last.push(r)
    else lines.push([r])
  }
  return lines.map((group) => unionRects(group)!)
}

/** 확장(extension)의 자막(highlight.ts)/웹 문단(articleHighlight.ts) hover 히트테스트가
 *  공유하는 그룹핑 로직 — CJK 형태소 분석 결과(segments)가 있으면 seed 단어가 속한
 *  세그먼트 전체의 rect 를 줄 단위로 묶어 반환하고, 없으면(비CJK/분석 전) seed 하나만
 *  반환한다. 두 파일이 입력 형태(SubLine[] vs SubWord[]+idx)만 다르게 이 로직을 각자
 *  복제해 갖고 있어 한쪽만 고쳐지고 다른 쪽이 뒤처지는 드리프트가 실제로 있었다
 *  (2026-07-30) — 여기로 통합한다. */
export function groupSegmentAt(
  text: string,
  words: SubWord[],
  seed: SubWord,
  segments: { start: number; end: number }[] | undefined,
): { rects: Rect[]; text: string; start: number; end: number } {
  const seg = segments?.find((s) => seed.start >= s.start && seed.start < s.end)
  if (!seg) return { rects: [seed.rect], text: seed.text, start: seed.start, end: seed.end }
  const groupRects: Rect[] = []
  for (const other of words) {
    if (other.start >= seg.start && other.start < seg.end) groupRects.push(other.rect)
  }
  return { rects: groupRectsByLine(groupRects), text: text.slice(seg.start, seg.end), start: seg.start, end: seg.end }
}
