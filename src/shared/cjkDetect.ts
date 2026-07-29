// 공동 소유 — 유니코드 블록 기반 CJK 판별의 단일 소스.
// 화면 자막 텍스트(OCR을 못 쓰는 경로)로 언어를 추정할 때 쓰는 휴리스틱을
// src/main/selection/subtitleSource.ts(direct 추출)와 src/main/extension/bridge.ts
// (확장에서 온 자막 스냅샷)가 공유한다. 이전엔 두 파일이 완전히 동일한 정규식을
// 각자 들고 있었다 — bridge.ts 쪽엔 "subtitleSource.ts를 직접 import하면 순환
// 참조가 생긴다"는 이유가 있었는데, 공유 모듈(@shared)로 뽑으면 그 순환 자체가
// 생기지 않는다.
//
// HAN_CHAR_RE 는 한자(CJK 통합 한자 + 확장 A)만 판별하고, 그 안에서 간체 전용
// 글자 목록으로 zh-Hans/zh-Hant 를 나눈다(정밀 판별 아님, 추후 개선 여지 명시).
export const HAN_CHAR_RE = /[一-鿿㐀-䶿]/
const KANA_RE = /[぀-ヿ]/
const SIMPLIFIED_ONLY_CHAR_RE = /[们么这来国对时会说无个开关问题东买卖车马语门]/

/** 화면 자막 텍스트에서 ja/zh-Hans/zh-Hant 를 추정한다. 셋 다 아니면 null. */
export function detectCjkLanguage(text: string): 'ja' | 'zh-Hans' | 'zh-Hant' | null {
  if (KANA_RE.test(text)) return 'ja'
  if (HAN_CHAR_RE.test(text)) {
    return SIMPLIFIED_ONLY_CHAR_RE.test(text) ? 'zh-Hans' : 'zh-Hant'
  }
  return null
}
