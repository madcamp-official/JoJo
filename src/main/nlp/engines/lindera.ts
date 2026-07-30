import type { JaToken } from '@shared/types'

// Lindera(kuromoji-rs 포크, WASM) 엔진 — kuromoji 와 같은 IPADIC 을 쓰지만 유지보수가
// 활발하다(릴리스 주기 몇 개월 vs kuromoji 는 2022-06 이후 중단, 실측 확인). 결과는
// kuromoji 와 동일해서(26개 텍스트 비교로 확인) mergeJaTokens(@shared/nlp/ja, IPADIC 用)
// 를 그대로 재사용한다 — Sudachi 처럼 별도 병합 로직이 필요 없다.
//
// lindera-nodejs(네이티브 N-API 바인딩) npm 패키지는 현재 배포가 깨져 있다(실측 확인 —
// 여러 최근 버전 모두 tarball 에 index.js 자체가 빠져있음, 업스트림 버그). 그래서
// WASM 빌드(lindera-wasm-nodejs-ipadic, 사전 내장)를 쓴다 — 네이티브보다 다소 느리지만
// 이 앱 용도(문장 몇 줄 토큰화)엔 체감 차이가 없고, 네이티브 패키지가 고쳐지면 이
// 파일만 교체하면 된다.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require('lindera-wasm-nodejs-ipadic')

interface LinderaToken {
  surface: string
  baseForm?: string
  partOfSpeech: string
  partOfSpeechSubcategory1?: string
  byteStart: number
  byteEnd: number
}

let tokenizerPromise: Promise<{ tokenize(text: string): LinderaToken[] }> | null = null

function buildTokenizer(): { tokenize(text: string): LinderaToken[] } {
  const builder = new wasm.TokenizerBuilder()
  builder.setDictionary('embedded://ipadic')
  return builder.build()
}

function getTokenizer(): Promise<{ tokenize(text: string): LinderaToken[] }> {
  if (!tokenizerPromise) tokenizerPromise = Promise.resolve(buildTokenizer())
  return tokenizerPromise
}

/**
 * Lindera(WASM/Rust)는 토큰 위치를 UTF-8 바이트 오프셋으로 준다 — 이 앱 전체가 쓰는
 * "문자열 상 0-based 문자 오프셋"(JaToken.start, kuromoji 관례)과 다르므로 변환이
 * 필요하다. 바이트 오프셋 → 문자 인덱스 매핑을 한 번 만들어 각 토큰에 적용한다.
 */
function buildByteToCharMap(text: string): Map<number, number> {
  const map = new Map<number, number>()
  let byteOffset = 0
  for (let i = 0; i < text.length; i++) {
    map.set(byteOffset, i)
    byteOffset += Buffer.byteLength(text[i]!, 'utf8')
  }
  map.set(byteOffset, text.length)
  return map
}

export async function tokenizeLindera(text: string): Promise<JaToken[]> {
  if (!text) return []
  const tokenizer = await getTokenizer()
  const byteToChar = buildByteToCharMap(text)
  return tokenizer.tokenize(text).map((t) => ({
    surface: t.surface,
    pos: t.partOfSpeech,
    posDetail1: t.partOfSpeechSubcategory1 ?? '*',
    baseForm: t.baseForm,
    start: byteToChar.get(t.byteStart) ?? 0,
  }))
}

/** 앱 시작 시 미리 불러 예열 — WASM 모듈/사전 로딩을 첫 실제 호출 전에 끝내둔다. */
export function warmLindera(): void {
  getTokenizer().catch(() => {
    // 예열 실패는 무시 — 실제 사용 시점에 다시 시도된다.
  })
}
