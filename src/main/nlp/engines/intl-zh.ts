import type { ZhWord } from '@shared/types'

// Intl.Segmenter(ICU 내장) — zh-Hant(번체) 후보 엔진 중 하나. main/nlp/chinese.ts 의
// ZH_HANT_ENGINE 스위치가 'intl' 일 때 쓴다. 별도 의존성·사전 파일 없이 Node/Electron
// (Chromium) 에 이미 내장된 ICU 사전+동적계획법을 그대로 쓴다 — 초기화 비용도 사실상 0.
//
// 실측 비교(사내 비교 보고서) 요약: 번체 F1 .943 (chinese-tokenizer 와 오차범위 내 동률).
// 研究生命 류 가든패스 중의성(chinese-tokenizer/lindera 공통 약점)은 없지만, 흔한 3~4글자
// 복합명사·고유명사·성어를 과다분절하는 경향이 있고(气象局→气象/局, 长江大桥→长江/大/桥
// 등, 번체에선 대부분 해소되지만 会展中心/圆月 류는 번체에도 남음) 인명 인식이 약하다
// (費孝通→費/孝/通向 처럼 실존 인물명을 완전히 무너뜨린 사례 실측). 커스텀 사전 확장 API가
// 전혀 없어(브라우저 표준, segment() 하나뿐) 발견된 결함을 패치할 방법이 구조적으로 없다.

const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' })

const HAS_HAN_CHAR_RE = /[一-鿿㐀-䶿]/

export function segmentIntlZhWords(text: string): ZhWord[] {
  if (!text) return []
  const words: ZhWord[] = []
  for (const { segment, index } of segmenter.segment(text)) {
    if (HAS_HAN_CHAR_RE.test(segment)) {
      words.push({ text: segment, start: index, end: index + segment.length })
    }
  }
  return words
}

/** ICU 는 엔진에 이미 내장돼 있어 예열이 필요 없다 — 다른 엔진과의 인터페이스 일관성을 위한 no-op. */
export function warmIntlZh(): void {
  // 초기화 비용이 사실상 0(실측 ~14ms, 그마저도 최초 1회) — 예열 대상 없음.
}
