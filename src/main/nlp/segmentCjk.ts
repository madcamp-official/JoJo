import type { WordSegment } from '@shared/extension'
import { segmentChineseWords } from './chinese'
import { segmentJapaneseWords } from './japanese'

/**
 * CJK 한 덩어리를 형태소 경계로 잘라 [start,end) 목록으로 돌려준다 — 확장(자막·웹 문단,
 * extension/bridge.ts)과 자체 뷰어(ipc.ts VIEWER_SEGMENT)가 공유한다. 두 경로가 서로 다른
 * 기준으로 쪼개면 같은 문장인데도 hover 로 묶이는 단위가 갈리므로 반드시 한 소스여야 한다.
 *
 * ja 는 원시 형태소(tokenizeJapanese)가 아니라 segmentJapaneseWords 를 쓴다 — 팝업의 atom
 * 경계(popup/selection.ts)와 같은 문절 단위까지 병합된 결과라, hover 에서 묶이는 단위와
 * 클릭 후 팝업에서 묶이는 단위가 일치한다(불일치 시 2026-07-29 제보 같은 문제가 생긴다).
 */
export async function segmentCjkText(
  text: string,
  lang: 'ja' | 'zh-Hans' | 'zh-Hant',
): Promise<WordSegment[]> {
  return lang === 'ja'
    ? (await segmentJapaneseWords(text)).map((t) => ({ start: t.start, end: t.end }))
    : (await segmentChineseWords(text, lang)).map((w) => ({ start: w.start, end: w.end }))
}
