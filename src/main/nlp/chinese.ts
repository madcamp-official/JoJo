import type { Language, ZhEngine, ZhWord } from '@shared/types'
import { segmentJiebaWords, warmJieba } from './engines/jieba'
import { segmentIntlZhWords, warmIntlZh } from './engines/intl-zh'
import { segmentChineseTokenizerWords, warmChineseTokenizer } from './engines/chineseTokenizer'

// 담당 A/B 공용 — 중국어 분절 디스패처. 두 곳에서 쓴다:
//  - OCR 단어 분리(main/selection/ocr.ts): 의미 단위 단어로 Word[] 를 만든다.
//  - 팝업 원문 문맥 atom 구성(renderer popup/selection.ts, IPC 로 호출): 이미 확정된
//    단어 경계이므로 별도 병합 없이 그대로 atom 으로 쓴다(mergeJaTokens 와 다른 점).
//
// zh-Hans(간체)는 jieba(@node-rs/jieba) 고정 — 실측 비교(사내 비교 보고서)에서 간체는
// jieba 계열이 명확히 앞서(F1 1.00) 스위치가 불필요했다.
// zh-Hant(번체)는 완전한 승자가 없어(엔진마다 다른 문장에서 실패) 개발자 전용 스위치로
// 남겨둔다 — japanese.ts JA_ENGINE 과 동일한 패턴, 사용자 UI 없음.
export const ZH_HANT_ENGINE: ZhEngine = 'chinese-tokenizer'

export async function segmentChineseWords(text: string, language: Language): Promise<ZhWord[]> {
  if (!text) return []
  if (language === 'zh-Hans') return segmentJiebaWords(text)
  switch (ZH_HANT_ENGINE) {
    case 'intl':
      return segmentIntlZhWords(text)
    case 'chinese-tokenizer':
      return segmentChineseTokenizerWords(text)
  }
}

/** 앱 시작 시 미리 불러 두면(fire-and-forget) 첫 사용 시점의 지연을 없앨 수 있다. */
export function warmChineseSegmenter(): void {
  warmJieba()
  switch (ZH_HANT_ENGINE) {
    case 'intl':
      warmIntlZh()
      break
    case 'chinese-tokenizer':
      warmChineseTokenizer()
      break
  }
}
