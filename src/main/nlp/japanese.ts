import kuromoji, { type IpadicFeatures, type Tokenizer } from 'kuromoji'
import path from 'path'
import type { JaToken } from '@shared/types'

// 담당 A/B 공용 — 일본어 형태소 분석(kuromoji, IPADIC 사전). 두 곳에서 쓴다:
//  - OCR 단어 분리(main/selection/ocr.ts): 의미 단위 단어로 Word[] 를 만든다.
//  - 팝업 원문 문맥의 가나 조각 병합(renderer popup/selection.ts, IPC 로 호출):
//    조사(助詞)는 독립 atom, 조동사(助動詞)는 앞 atom 에 붙여 동사 어간+어미를 하나로 취급.

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null

function dicPath(): string {
  return path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict')
}

/** 사전 로드는 처음 한 번만(수백ms~1초대) — 이후 호출은 캐시된 프라미스를 재사용한다. */
export function getJapaneseTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
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

/** 앱 시작 시 미리 불러 두면(fire-and-forget) 첫 사용 시점의 지연을 없앨 수 있다. */
export function warmJapaneseTokenizer(): void {
  getJapaneseTokenizer().catch(() => {
    // 예열 실패는 무시 — 실제 사용 시점에 다시 시도된다.
  })
}

export async function tokenizeJapanese(text: string): Promise<JaToken[]> {
  if (!text) return []
  const tokenizer = await getJapaneseTokenizer()
  return tokenizer.tokenize(text).map((t) => ({
    surface: t.surface_form,
    pos: t.pos,
    start: t.word_position - 1,
  }))
}

const HAS_JA_CHAR_RE = /[一-鿿㐀-䶿぀-ヿ]/

/** OCR 단어 분리용 — 문장부호·기호(記号) 뿐인 토큰은 제외하고 의미 있는 단어만 반환한다. */
export async function segmentJapaneseWords(
  text: string,
): Promise<{ text: string; start: number; end: number }[]> {
  const tokens = await tokenizeJapanese(text)
  return tokens
    .filter((t) => HAS_JA_CHAR_RE.test(t.surface))
    .map((t) => ({ text: t.surface, start: t.start, end: t.start + t.surface.length }))
}
