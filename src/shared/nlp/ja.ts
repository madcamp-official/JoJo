import type { JaToken } from '../types'

// 공동 소유 — IPADIC 형태소 토큰(현재 Lindera 엔진, main/nlp/engines/lindera.ts)을
// "문절(文節)"에 가까운 의미 단위로 묶는 규칙.
// OCR 단어 분리(main/nlp/japanese.ts segmentJapaneseWords)와 팝업 원문 문맥 atom 병합
// (renderer popup/selection.ts) 양쪽이 이 함수 하나를 공유한다 — 병합 규칙을 바꾸면
// 두 곳 모두에 자동 반영된다. 팝업 쪽 선택 "단위"(한자를 붙일지/쪼갤지)는 이 결과를
// 어떻게 atom 으로 변환하는지의 문제이므로 selection.ts 의 전략(JA_ATOM_STRATEGY)에서
// 따로 다룬다 — 이 함수 자체는 항상 같은 병합 결과를 낸다.
//
// 규칙:
//  1. 動詞,自立 / 形容詞,自立 로 시작하는 어간 뒤에 붙는 조동사(助動詞)는 무조건 앞에
//     흡수한다.
//  2. 접속조사 て/で 는 동사・형용사의 て형 활용어미 자체이므로(向かう→向かって 등)
//     뒤에 오는 게 무엇이든 무조건 앞에 흡수한다.
// 그 뒤에 이어지는 補助動詞(ている 의 いる 등, 動詞,非自立)는 흡수하지 않는다 — 그 자체로
// 독립된 사전 표제어라 따로 선택해 조회할 수 있어야 한다는 요청으로 뺐다. 그래서
// 食べている 는 食べて / いる 로 나뉜다(食べて 까지는 활용어미라 하나, て 뒤 いる 는 별개).
// 명사 자동 병합(연속 名詞 복합명사, 接頭詞+名詞)과 접미동사(動詞,接尾/て 없는 動詞,非自立:
// 歩き出す, 食べ過ぎる 등) 병합도 같은 이유로 넣지 않는다(ja-unidic.ts 도 동일).
const TE_DE = new Set(['て', 'で'])

function combine(group: JaToken[]): JaToken {
  const first = group[0]!
  return {
    surface: group.map((t) => t.surface).join(''),
    pos: first.pos,
    posDetail1: first.posDetail1,
    start: first.start,
    // 어간(첫 토큰)의 baseForm 을 그대로 들고 간다 — 병합된 atom 이 곧 사전 조회 단위이므로
    // (popup/selection.ts wordsFromAtoms), 여기서 버리면 dictionary.ts 가 기본형을 구하려고
    // 같은 텍스트를 또 형태소 분석해야 했다(TODO.md 239번).
    baseForm: first.baseForm,
  }
}

export function mergeJaTokens(tokens: JaToken[]): JaToken[] {
  const merged: JaToken[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!

    // 動詞,自立 / 形容詞,自立 어간 + 활용어미·조동사·보조동사 체인
    if ((t.pos === '動詞' || t.pos === '形容詞') && t.posDetail1 === '自立') {
      const group = [t]
      i++
      while (i < tokens.length) {
        const next = tokens[i]!
        if (next.pos === '助動詞') {
          group.push(next)
          i++
          continue
        }
        if (next.pos === '助詞' && next.posDetail1 === '接続助詞' && TE_DE.has(next.surface)) {
          group.push(next)
          i++
          continue
        }
        break
      }
      merged.push(combine(group))
      continue
    }

    merged.push(t)
    i++
  }
  return merged
}
