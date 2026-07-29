// 공용 — 자막(highlight.ts)과 웹 문단(articleHighlight.ts) 양쪽이 같은 형태소 분석 결과
// 캐시를 쓴다. 앱이 CJK 텍스트를 분석해 내려준 결과(WordSegment[])를 원문 텍스트
// (자막 줄 lineText 또는 문단 paragraphText) 기준으로 캐시해뒀다가, hover 히트테스트 시
// 같은 세그먼트에 속한 글자 여러 개를 하나의 단어로 묶는 데 쓴다. 아직 분석 결과가 없는
// 텍스트는 두 곳 다 글자 단위로 폴백한다(content.ts가 'wordSegments' 메시지 수신 시
// setWordSegments 를 호출해 채운다).
import type { WordSegment } from '@shared/extension'

const segmentsByText = new Map<string, WordSegment[]>()

export function setWordSegments(text: string, words: WordSegment[]): void {
  segmentsByText.set(text, words)
}

export function getWordSegments(text: string): WordSegment[] | undefined {
  return segmentsByText.get(text)
}
