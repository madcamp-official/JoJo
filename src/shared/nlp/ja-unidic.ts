import type { JaToken } from '../types'

// Sudachi(UniDic) 전용 병합 로직 — @shared/nlp/ja.ts(mergeJaTokens, IPADIC 用)와 나란히 두되
// 완전히 분리한다. 이유: UniDic 은 IPADIC 의 動詞,自立/動詞,非自立 같은 "지금 이 자리에서
// 독립동사로 쓰였는지" 구분이 없다 — 渡る(본동사로 쓰임)도 いる(食べている 의 보조동사로 쓰임)도
// 똑같이 動詞,非自立可能 로 태깅된다(실측 확인). 그래서 IPADIC 처럼 태그만으로 보조동사를
// 가려낼 수 없고, 표제어(baseForm) 닫힌 목록으로 근사해야 한다 — 그 목록이 이 파일의 핵심이고,
// Sudachi 를 나중에 걷어낼 때 이 파일만 지우면 되도록 mergeJaTokens(ja.ts) 와 절대 공유하지
// 않는다.
const HOJO_DOUSHI_LEMMAS = new Set([
  '居る', 'おる', 'ある', '行く', '来る', '見る', 'しまう', 'おく', 'くれる', 'もらう', 'あげる',
  'ください', 'みせる', 'いただく', 'やる',
])

// IPADIC 의 動詞,接尾(て 없이 동사 連用形에 바로 붙는 접미동사: 歩き出す, 食べ過ぎる,
// 読み始める 등)에 대응 — UniDic 도 마찬가지로 표제어 닫힌 목록으로 근사한다.
const SUFFIX_VERB_LEMMAS = new Set([
  '出す', '始める', '終わる', '続ける', '過ぎる', '得る', 'かねる', 'かける', 'たがる',
  '合う', '直す', '忘れる', '損なう', '切る', '抜く', '尽くす',
])

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

/**
 * 動詞,自立/形容詞,自立 개념이 없는 UniDic 대신, 動詞/形容詞 어간 뒤에 붙는 조동사·て형·
 * 표제어 목록에 있는 보조동사/접미동사 체인을 흡수한다. ja.ts mergeJaTokens 의 규칙 2 와
 * 동일한 이유로 접속조사 て/で 는 뒤에 오는 게 무엇이든 무조건 흡수한다(向かう→向かって 등
 * 활용어미 자체이므로).
 */
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
        if (next.pos === '動詞' && next.baseForm && HOJO_DOUSHI_LEMMAS.has(next.baseForm)) {
          group.push(next)
          i++
          continue
        }
        if (next.pos === '動詞' && next.baseForm && SUFFIX_VERB_LEMMAS.has(next.baseForm)) {
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
