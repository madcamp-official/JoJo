import type { JaToken } from '../types'

// Sudachi(UniDic) 전용 병합 로직 — @shared/nlp/ja.ts(mergeJaTokens, IPADIC 用)와 나란히 두되
// 완전히 분리한다(나중에 Sudachi 를 걷어낼 때 이 파일만 지우면 되도록).
//
// 규칙: 動詞/形容詞 어간 뒤에 붙는 조동사(助動詞)와 て형 활용어미(접속조사 て/で, 향かう→
// 向かって 등)만 흡수한다. 그 뒤에 이어지는 補助動詞(ている 의 いる 등)나 접미동사(過ぎる,
// 出す 등)는 흡수하지 않는다 — 전부 그 자체로 독립된 사전 표제어라 따로 선택해 조회할 수
// 있어야 한다는 요청으로 뺐다(ja.ts 도 동일한 이유로 동일하게 뺌).
const TE_DE = new Set(['て', 'で'])

// ちゃう/じゃう(〜てしまう 축약, 助動詞로 태깅됨)는 앞 동사 활용의 일부로 흡수하지 않고
// 그 자체로 새 단어를 시작한다 — 「食べられちゃった」를 그대로 붙이면 "食べられ"(어간+수동)
// 와 "ちゃった"(축약+과거)를 따로 선택·조회할 수 없다는 요청(2026-07-29)으로 분리했다.
// 다른 助動詞 체인(られる/せる/た/ます 등)은 기존대로 계속 흡수한다.
const SHIMAU_CONTRACTION_BASE_FORMS = new Set(['ちゃう', 'じゃう'])

function isShimauContraction(t: JaToken): boolean {
  return t.pos === '助動詞' && !!t.baseForm && SHIMAU_CONTRACTION_BASE_FORMS.has(t.baseForm)
}

// だろう/でしょう(推量, 助動詞「だ」「です」의 意志推量形)도 앞 동사에 흡수하지 않고 새
// 단어로 분리한다 — 그 자체로 독립된 표제어(추측을 나타내는 어미)라 따로 선택해 조회할
// 수 있어야 한다는 요청(2026-07-29)으로 뺐다. baseForm 이 아니라 surface 로 판별하는데,
// baseForm 은 각각 평범한 단정 조동사 だ/です 로 정규화돼(持つだろう→だ) 그 자체로는
// だ/だった/で 등 계속 흡수해야 하는 활용형과 구분이 안 되기 때문이다.
const CONJECTURE_AUX_SURFACES = new Set(['だろう', 'でしょう'])

function isConjectureAux(t: JaToken): boolean {
  return t.pos === '助動詞' && CONJECTURE_AUX_SURFACES.has(t.surface)
}

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
    if (t.pos === '動詞' || t.pos === '形容詞' || isShimauContraction(t)) {
      const group = [t]
      i++
      while (i < tokens.length) {
        const next = tokens[i]!
        if (isShimauContraction(next)) break // ちゃう/じゃう는 흡수하지 않고 새 단어로 넘긴다
        if (isConjectureAux(next)) break // だろう/でしょう도 흡수하지 않고 새 단어로 넘긴다
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
