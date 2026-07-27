import type { JaToken } from '../types'

// Sudachi(UniDic) 전용 병합 로직 — @shared/nlp/ja.ts(mergeJaTokens, IPADIC 用)와 나란히 두되
// 완전히 분리한다(나중에 Sudachi 를 걷어낼 때 이 파일만 지우면 되도록).
//
// 규칙: 動詞/形容詞 어간 뒤에 붙는 조동사(助動詞)와 て형 활용어미(접속조사 て/で, 향かう→
// 向かって 등)만 흡수한다. 그 뒤에 이어지는 補助動詞(ている 의 いる 등)나 접미동사(過ぎる,
// 出す 등)는 흡수하지 않는다 — 전부 그 자체로 독립된 사전 표제어라 따로 선택해 조회할 수
// 있어야 한다는 요청으로 뺐다(ja.ts 도 동일한 이유로 동일하게 뺌).
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

export function mergeJaTokensUnidic(tokens: JaToken[]): JaToken[] {
  const merged: JaToken[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t.pos === '動詞' || t.pos === '形容詞') {
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
