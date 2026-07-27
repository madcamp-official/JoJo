import type { JaEngine, JaToken } from '@shared/types'
import { mergeJaTokens } from '@shared/nlp/ja'
import { mergeJaTokensUnidic } from '@shared/nlp/ja-unidic'
import { tokenizeKuromoji, warmKuromoji } from './engines/kuromoji'
import { tokenizeLindera, warmLindera } from './engines/lindera'
import { tokenizeSudachi, warmSudachi } from './engines/sudachi'

// 일본어 형태소 분석 엔진 스위치 — 개발자 전용, 사용자 UI 없음. 여기 값만 바꾸면 OCR
// 단어 분리·팝업 atom 병합 양쪽에 그대로 반영된다(둘 다 이 파일의 tokenizeJapanese/
// segmentJapaneseWords 만 거쳐 감). 엔진별 실측 비교 근거는 사내 비교 보고서 참고.
//  - 'kuromoji': IPADIC, 이미 통합됨, 유지보수 중단(2022-06~)
//  - 'lindera' : IPADIC, kuromoji 와 결과 동일, 유지보수 활발
//  - 'sudachi-b'/'sudachi-c': UniDic, Python 필요, 숫자·최신 속어 등 일부 어휘 강함
export const JA_ENGINE: JaEngine = 'sudachi-b'

/** JA_ENGINE 이 가리키는 엔진으로 원시(미병합) 토큰을 얻는다. */
async function tokenizeRaw(text: string): Promise<JaToken[]> {
  switch (JA_ENGINE) {
    case 'kuromoji':
      return tokenizeKuromoji(text)
    case 'lindera':
      return tokenizeLindera(text)
    case 'sudachi-b':
      return tokenizeSudachi(text, 'B')
    case 'sudachi-c':
      return tokenizeSudachi(text, 'C')
  }
}

/** 원시 토큰을 JA_ENGINE 의 품사 체계에 맞는 규칙으로 병합한다(IPADIC vs UniDic). */
function mergeRaw(tokens: JaToken[]): JaToken[] {
  return JA_ENGINE.startsWith('sudachi') ? mergeJaTokensUnidic(tokens) : mergeJaTokens(tokens)
}

/** 앱 시작 시 미리 불러 두면(fire-and-forget) 첫 사용 시점의 지연을 없앨 수 있다. */
export function warmJapaneseTokenizer(): void {
  switch (JA_ENGINE) {
    case 'kuromoji':
      warmKuromoji()
      break
    case 'lindera':
      warmLindera()
      break
    case 'sudachi-b':
      warmSudachi('B')
      break
    case 'sudachi-c':
      warmSudachi('C')
      break
  }
}

/**
 * 팝업 원문 문맥의 가나 조각 병합용(renderer popup/selection.ts, IPC TOKENIZE_JA 로
 * 호출) — 병합 전 원시 토큰을 반환한다. 어떤 엔진의 결과인지도 같이 알려줘야
 * 렌더러가 맞는 병합 함수를 골라 쓸 수 있다(ipc.ts 가 { engine, tokens } 로 감싸 응답).
 */
export async function tokenizeJapanese(text: string): Promise<JaToken[]> {
  if (!text) return []
  return tokenizeRaw(text)
}

const HAS_JA_CHAR_RE = /[一-鿿㐀-䶿぀-ヿ]/

/**
 * OCR 단어 분리용 — 형태소 그대로가 아니라 JA_ENGINE 에 맞는 병합 규칙(mergeJaTokens 또는
 * mergeJaTokensUnidic)으로 문절 단위까지 묶은 뒤 문장부호·기호(記号) 뿐인 토큰은 제외하고
 * 의미 있는 단어만 반환한다.
 */
export async function segmentJapaneseWords(
  text: string,
): Promise<{ text: string; start: number; end: number }[]> {
  const tokens = await tokenizeRaw(text)
  return mergeRaw(tokens)
    .filter((t) => HAS_JA_CHAR_RE.test(t.surface))
    .map((t) => ({ text: t.surface, start: t.start, end: t.start + t.surface.length }))
}
