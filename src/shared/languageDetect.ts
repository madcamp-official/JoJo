// 공동 소유 — 텍스트 기반 언어 자동 판별의 단일 소스.
// 예전엔 이 판별이 세 곳에 따로 있었다: src/shared/cjkDetect.ts(간체전용 17자 정규식),
// extension/src/content.ts 의 detectDomLanguagePrefix(zh 세분화 없는 독자 정규식),
// src/main/selection/langDetect.ts 의 detectChineseScript(간체/번체 각 90자 표본). 같은
// 텍스트를 넣어도 세 곳이 다른 답을 낼 수 있었고, 특히 cjkDetect.ts 의 17자 표본은 그
// 17자가 없으면 무조건 zh-Hant 로 폴백해 간체 자막을 번체로 오판하는 문제가 있었다
// (2026-07-29 실사용 제보로 발견 — "요분리 아안루취도하거" 류의 짧은 간체 대사가 번체로
// 표시됨).
//
// 지금은 두 단계로 나눈다:
//  1) eld(N-gram 기반, https://github.com/vxern/eld)로 대분류 언어를 판별한다. 실측
//     비교(franc/eld/tinyld, 2026-07-29) 결과 franc 는 자막 한 줄 같은 짧은 텍스트에서
//     정확도가 크게 떨어졌고(38.1%, 최소 신뢰 길이 미달 시 'und' 응답), eld/tinyld 는
//     길이 무관 100%였다. eld 가 그중 속도가 더 빨라(large DB 기준 short 0.033ms) 이걸
//     골랐다 — DB 크기별(large/medium/small/extrasmall) 정확도 손실도 실측상 없었다.
//  2) eld 는 중국어를 zh 하나로만 반환하므로(간체/번체는 "다른 언어"가 아니라 "같은
//     언어의 다른 표기 체계"라 일반 언어판별기의 판별 대상이 아님), 한자가 있으면
//     detectHanziVariant 로 한 번 더 가른다. 표본은 OpenCC 의 전체 간체/번체 전용 한자
//     매핑(각 ~3800/~3200자, hanziVariants.ts)을 다수결로 쓴다.
import { eld } from 'eld/extrasmall'
import { SIMPLIFIED_ONLY_CHARS, TRADITIONAL_ONLY_CHARS } from './hanziVariants'
import type { Language } from './types'

export const HAN_CHAR_RE = /[一-鿿㐀-䶿]/

function countMatches(text: string, sample: string): number {
  let count = 0
  for (const ch of text) if (sample.includes(ch)) count++
  return count
}

/** 한자 텍스트를 간체/번체로 가른다. 동률이면 zh-Hans (기존 langDetect.ts 관례를 유지). */
export function detectHanziVariant(text: string): 'zh-Hans' | 'zh-Hant' {
  const simp = countMatches(text, SIMPLIFIED_ONLY_CHARS)
  const trad = countMatches(text, TRADITIONAL_ONLY_CHARS)
  return trad > simp ? 'zh-Hant' : 'zh-Hans'
}

/** eld 로 판별한 실제 언어를 ISO 639-1 근사 코드로 반환한다(한자는 zh-Hans/zh-Hant 까지
 *  가른 값). 판별 불가/빈 텍스트는 null — 나중에 지원 언어를 늘릴 때 이 함수는 그대로
 *  두고 detectLanguage() 의 매핑만 넓히면 된다. */
export function detectRawLanguage(text: string): string | null {
  if (!text.trim()) return null
  const { language } = eld.detect(text)
  if (!language) return null
  if (language === 'zh') return HAN_CHAR_RE.test(text) ? detectHanziVariant(text) : 'zh'
  return language
}

/** 앱이 실제 지원하는 4개 언어(en/ja/zh-Hans/zh-Hant)로 좁혀 반환한다. 그 외 언어가
 *  감지되면 en 폴백 — "라틴 문자=영어"라는 소거법이 아니라 실제 판별 결과를 좁히는
 *  것이므로, 나중에 지원 언어가 늘어나면 이 분기만 추가하면 된다. */
export function detectLanguage(text: string): Language {
  const raw = detectRawLanguage(text)
  if (raw === 'ja' || raw === 'zh-Hans' || raw === 'zh-Hant') return raw
  return 'en'
}

/** CJK(ja/zh) 여부만 필요한 곳(예: hover 세그멘테이션 라우팅)에서 쓴다. */
export function detectCjkVariant(text: string): 'ja' | 'zh-Hans' | 'zh-Hant' | null {
  const lang = detectLanguage(text)
  return lang === 'en' ? null : lang
}
