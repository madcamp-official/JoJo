import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'
import type { ZhWord } from '@shared/types'
import { HAN_CHAR_RE } from '@shared/cjkDetect'

// jieba(@node-rs/jieba, Rust/NAPI-RS) — zh-Hans(간체) 전용 엔진. main/nlp/chinese.ts 의
// 디스패처가 호출한다. 실측 비교(사내 비교 보고서)에서 간체 F1 1.00(참조 문장 전부 일치),
// 초기화 <1ms, 월 116만 다운로드로 다른 jieba 계열(nodejieba/jieba-wasm/@isdk/nlp-jieba)
// 대비 정확도·유지보수 모두 앞서 유일한 후보로 확정했다. 번체는 이 엔진으로 안 쓴다(F1 .84
// 수준으로 거의 글자 단위 붕괴 — zh-Hant 는 chinese.ts 의 ZH_HANT_ENGINE 스위치를 탄다).

let jiebaInstance: Jieba | null = null

function getJieba(): Jieba {
  if (!jiebaInstance) jiebaInstance = Jieba.withDict(dict)
  return jiebaInstance
}

export function segmentJiebaWords(text: string): ZhWord[] {
  if (!text) return []
  const jieba = getJieba()
  const words: ZhWord[] = []
  let offset = 0
  for (const w of jieba.cut(text)) {
    const start = offset
    offset += w.length
    if (HAN_CHAR_RE.test(w)) words.push({ text: w, start, end: offset })
  }
  return words
}

/** 초기화가 <1ms 라 실질적 이점은 적지만, 다른 엔진과의 warm 인터페이스 일관성을 위해 둔다. */
export function warmJieba(): void {
  getJieba()
}
