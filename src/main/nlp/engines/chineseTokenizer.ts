import { loadFile } from 'chinese-tokenizer'
import { join } from 'path'
import type { ZhWord } from '@shared/types'
import { HAN_CHAR_RE } from '@shared/languageDetect'

// chinese-tokenizer(그리디 최장일치, CC-CEDICT) — zh-Hant(번체) 후보 엔진 중 하나.
// main/nlp/chinese.ts 의 ZH_HANT_ENGINE 스위치가 'chinese-tokenizer' 일 때 쓴다.
// 사전은 resources/cedict.u8(CC-CEDICT, CC BY-SA 4.0, https://cc-cedict.org) — 이 앱의
// 사전 조회 기능(DictionarySourceId 'cc-cedict')이 어차피 CC-CEDICT 를 쓰므로 같은 사전을
// 분절에도 재사용해 별도 용량 증가가 없다.
//
// 실측 비교(사내 비교 보고서) 요약: 번체 F1 .948(전체 12만 단어 사전 기준, intl 과 오차범위
// 내 동률). 研究生命 류 가든패스 중의성은 사전을 전체로 키워도 안 고쳐짐(그리디 구조 자체의
// 한계 — 알고리즘 문제지 사전 크기 문제가 아님, 실측 확인). 北京大學生→北京大學/生前 같은
// 다른 가든패스 오분절도 다수 확인됨. 반대로 인명(費孝通)·이메일 주소는 intl 보다 안정적으로
// 보존한다. 커스텀 단어 추가 API가 없어(loadFile/load 뿐) 결함을 패치하려면 사전 파일 자체를
// 편집해야 한다.

// electron-vite 가 main 프로세스를 out/main/index.js 하나로 번들링하므로(정적 import 는
// 전부 인라인됨), 런타임 __dirname 은 이 파일의 원래 소스 경로(src/main/nlp/engines/)가
// 아니라 out/main 기준이다 — windows.ts 의 build/icon.png 참조와 동일하게 2단계만 올라간다.
const CEDICT_PATH = join(__dirname, '../../resources/cedict.u8')

type Tokenize = (text: string) => { text: string }[]

let tokenizePromise: Promise<Tokenize> | null = null

/** 12만 단어 사전 파싱(~350ms, 실측)은 최초 1회만 — 이후 호출은 캐시된 프라미스를 재사용한다. */
function getTokenize(): Promise<Tokenize> {
  if (!tokenizePromise) {
    tokenizePromise = new Promise((resolve, reject) => {
      try {
        resolve(loadFile(CEDICT_PATH) as unknown as Tokenize)
      } catch (err) {
        reject(err)
      }
    })
  }
  return tokenizePromise
}

export async function segmentChineseTokenizerWords(text: string): Promise<ZhWord[]> {
  if (!text) return []
  const tokenize = await getTokenize()
  const words: ZhWord[] = []
  let offset = 0
  for (const t of tokenize(text)) {
    const start = offset
    offset += t.text.length
    if (HAN_CHAR_RE.test(t.text)) words.push({ text: t.text, start, end: offset })
  }
  return words
}

/** 앱 시작 시 미리 사전을 파싱해 두면(fire-and-forget) 첫 사용 시점의 ~350ms 지연을 없앨 수 있다. */
export function warmChineseTokenizer(): void {
  getTokenize().catch(() => {
    // 예열 실패는 무시 — 실제 사용 시점에 다시 시도된다.
  })
}
