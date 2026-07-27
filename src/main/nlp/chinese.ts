import { Segment, useDefault } from 'segmentit'
import type { ZhWord } from '@shared/types'

// 담당 A/B 공용 — 중국어 형태소 분석(segmentit, jieba 스타일). 두 곳에서 쓴다:
//  - OCR 단어 분리(main/selection/ocr.ts): 의미 단위 단어로 Word[] 를 만든다.
//  - 팝업 원문 문맥 atom 구성(renderer popup/selection.ts, IPC 로 호출): 이미 확정된
//    단어 경계이므로 별도 병합 없이 그대로 atom 으로 쓴다(mergeJaTokens 와 다른 점).
// 사전이 모듈 로드 시 동기적으로 준비되므로 kuromoji(japanese.ts)와 달리 비동기 초기화가 없다.

let segmenter: Segment | null = null

function getSegmenter(): Segment {
  if (!segmenter) segmenter = useDefault(new Segment())
  return segmenter
}

const HAS_HAN_CHAR_RE = /[一-鿿㐀-䶿]/

/**
 * 문장부호만 있는 조각은 제외하고 의미 있는 단어만 반환한다. OCR 단어 분리(selection/ocr.ts)와
 * 팝업 원문 문맥 atom 구성(renderer popup/selection.ts, IPC 로 호출) 양쪽에서 쓴다.
 */
export function segmentChineseWords(text: string): ZhWord[] {
  if (!text) return []
  const tokens = getSegmenter().doSegment(text)
  const words: ZhWord[] = []
  let offset = 0
  for (const t of tokens) {
    const start = offset
    offset += t.w.length
    if (HAS_HAN_CHAR_RE.test(t.w)) words.push({ text: t.w, start, end: offset })
  }
  return words
}
