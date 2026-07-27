import { Segment, useDefault } from 'segmentit'

// 담당 A — OCR 단어 분리(main/selection/ocr.ts)용 중국어 형태소 분석(segmentit, jieba 스타일).
// 사전이 모듈 로드 시 동기적으로 준비되므로 kuromoji(japanese.ts)와 달리 비동기 초기화가 없다.

let segmenter: Segment | null = null

function getSegmenter(): Segment {
  if (!segmenter) segmenter = useDefault(new Segment())
  return segmenter
}

const HAS_HAN_CHAR_RE = /[一-鿿㐀-䶿]/

/** OCR 단어 분리용 — 문장부호만 있는 조각은 제외하고 의미 있는 단어만 반환한다. */
export function segmentChineseWords(text: string): { text: string; start: number; end: number }[] {
  if (!text) return []
  const tokens = getSegmenter().doSegment(text)
  const words: { text: string; start: number; end: number }[] = []
  let offset = 0
  for (const t of tokens) {
    const start = offset
    offset += t.w.length
    if (HAS_HAN_CHAR_RE.test(t.w)) words.push({ text: t.w, start, end: offset })
  }
  return words
}
