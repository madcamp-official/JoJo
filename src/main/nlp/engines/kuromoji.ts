import kuromoji, { type IpadicFeatures, type Tokenizer } from 'kuromoji'
import path from 'path'
import type { JaToken } from '@shared/types'

// kuromoji(IPADIC) 엔진 — main/nlp/japanese.ts 의 디스패처가 호출한다.

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null

function dicPath(): string {
  return path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict')
}

/** 사전 로드는 처음 한 번만(수백ms~1초대) — 이후 호출은 캐시된 프라미스를 재사용한다. */
function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dicPath() }).build((err, tokenizer) => {
        if (err) reject(err)
        else resolve(tokenizer)
      })
    })
  }
  return tokenizerPromise
}

export async function tokenizeKuromoji(text: string): Promise<JaToken[]> {
  if (!text) return []
  const tokenizer = await getTokenizer()
  return tokenizer.tokenize(text).map((t) => ({
    surface: t.surface_form,
    pos: t.pos,
    posDetail1: t.pos_detail_1,
    baseForm: t.basic_form,
    start: t.word_position - 1,
  }))
}

/** 앱 시작 시 미리 불러 두면(fire-and-forget) 첫 사용 시점의 지연을 없앨 수 있다. */
export function warmKuromoji(): void {
  getTokenizer().catch(() => {
    // 예열 실패는 무시 — 실제 사용 시점에 다시 시도된다.
  })
}
