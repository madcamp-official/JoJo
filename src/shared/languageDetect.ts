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
import { LANGUAGES, LINK_LANGUAGES } from './languages'
import type { AnyLanguage, Language } from './types'

// tier1(LANGUAGES)∪tier2(LINK_LANGUAGES) 코드 집합 — eld 원시 코드가 이 중 하나면
// "지원 언어(감지+최소 구글 링크)", 아니면 tier3(미지원)다. zh-Hans/zh-Hant는 이 Set에
// 안 넣는다 — detectRawLanguage가 raw eld 'zh'를 먼저 detectHanziVariant로 가른 뒤
// 넘겨주므로, 여기서는 그 결과값을 그대로 신뢰하면 된다.
const SUPPORTED_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(LANGUAGES).filter((l) => l !== 'zh-Hans' && l !== 'zh-Hant'),
  ...Object.keys(LINK_LANGUAGES),
])

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

/** tier1(완전지원)+tier2(링크만) 통틀어 "앱이 뭐라도 대응 가능한 언어"로 좁혀 반환한다.
 *  tier3(둘 다 아님)면 null — **이전엔 여기서 무조건 'en'으로 폴백했는데(2026-07-29
 *  넷플릭스 간체/번체 오판 버그와 같은 유형의 함정: 프랑스어 자막이 뜨면 "en으로 오판"이
 *  아니라 "en 사전/발음 파이프라인이 프랑스어에 잘못 적용"되는 문제가 생김), tier2
 *  도입(2026-07-30)을 계기로 폴백을 없애고 null(=tier3, 화면에 "미지원" 처리)로
 *  명시했다.** null이 아니면 항상 LANGUAGES 또는 LINK_LANGUAGES 중 하나에 그 키가 있다
 *  (SUPPORTED_CODES 기준으로 걸러졌으므로). */
export function detectSupportedLanguage(text: string): AnyLanguage | null {
  const raw = detectRawLanguage(text)
  if (raw === null) return null
  if (raw === 'zh-Hans' || raw === 'zh-Hant') return raw
  return SUPPORTED_CODES.has(raw) ? (raw as AnyLanguage) : null
}

/** CJK(ja/zh) 여부만 필요한 곳(예: hover 세그멘테이션 라우팅)에서 쓴다. */
export function detectCjkVariant(text: string): 'ja' | 'zh-Hans' | 'zh-Hant' | null {
  const raw = detectRawLanguage(text)
  return raw === 'ja' || raw === 'zh-Hans' || raw === 'zh-Hant' ? raw : null
}

const KANA_RE = /[぀-ヿ]/

/** detectCjkVariant의 관대한 버전 — eld는 아주 짧거나 순수 CJK뿐인 표본(자막 한 줄,
 *  기사 문단 일부)에서 종종 판별에 실패한다(순수 중국어 문단인데도 raw language가 안
 *  잡히는 사례 실측 확인, 2026-07-30). eld가 놓치면 문자 종류 자체로 한 번 더 본다 —
 *  가나가 있으면 ja, 한자만 있으면 detectHanziVariant. hover 세그멘테이션 요청 라우팅
 *  (자막 highlight.ts 경로/웹 articleHighlight.ts 경로가 공유하는 bridge.ts
 *  requestWordSegments)에서만 쓴다 — 여기서 언어가 안 잡히면 그 줄/문단은 영원히 글자
 *  단위 hover 로 남기 때문에, 일반 언어 판별보다 더 관대하게 잡아야 한다. */
export function resolveCjkLanguage(text: string): 'ja' | 'zh-Hans' | 'zh-Hant' | null {
  const detected = detectCjkVariant(text)
  if (detected) return detected
  if (KANA_RE.test(text)) return 'ja'
  if (HAN_CHAR_RE.test(text)) return detectHanziVariant(text)
  return null
}

/** tier1 4개로만 좁힌 판별 — LLM 사전처럼 tier1 전용 기능 게이팅에 쓴다(tier2/3는 전부
 *  null). `detectSupportedLanguage`가 tier2까지 반환하는 것과 용도가 다르니 혼동 주의. */
export function detectFullLanguage(text: string): Language | null {
  const lang = detectSupportedLanguage(text)
  return lang !== null && lang in LANGUAGES ? (lang as Language) : null
}
