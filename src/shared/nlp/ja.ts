import type { JaToken } from '../types'

// 공동 소유 — kuromoji 형태소 토큰을 "문절(文節)"에 가까운 의미 단위로 묶는 규칙.
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
//     뒤에 오는 게 무엇이든 무조건 앞에 흡수하고, **바로 그 뒤에 이어지는** 動詞,非自立
//     (보조동사, 예: ている 의 いる)만 계속 흡수한다(食べている 도 하나로 묶임) — て/で
//     없이 어간에 바로 붙는 動詞,非自立(過ぎる, 出す 등 접미동사도 IPADIC 이 이 태그를
//     씀, 실측 확인)까지 흡수하면 안 되므로 "て/で 를 방금 흡수했을 때만" 으로 제한한다.
// 명사 자동 병합(연속 名詞 복합명사, 接頭詞+名詞)과 접미동사(動詞,接尾/て 없는 動詞,非自立:
// 歩き出す, 食べ過ぎる 등) 병합은 의도적으로 넣지 않는다 — 둘 다 그 자체로 독립된 사전
// 표제어라, 붙여버리면 개별 단어를 따로 선택해 사전 조회하기 어려워지는 문제가 있어 뺐다
// (ja-unidic.ts 도 동일).
const TE_DE = new Set(['て', 'で'])

function combine(group: JaToken[]): JaToken {
  const first = group[0]!
  return {
    surface: group.map((t) => t.surface).join(''),
    pos: first.pos,
    posDetail1: first.posDetail1,
    start: first.start,
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
      let afterTeDe = false
      while (i < tokens.length) {
        const next = tokens[i]!
        if (next.pos === '助動詞') {
          group.push(next)
          i++
          afterTeDe = false
          continue
        }
        if (next.pos === '助詞' && next.posDetail1 === '接続助詞' && TE_DE.has(next.surface)) {
          group.push(next)
          i++
          afterTeDe = true
          continue
        }
        if (afterTeDe && next.pos === '動詞' && next.posDetail1 === '非自立') {
          group.push(next)
          i++
          afterTeDe = false
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
