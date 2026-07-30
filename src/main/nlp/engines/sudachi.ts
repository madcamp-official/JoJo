import type { JaToken } from '@shared/types'
import { createPythonServer } from '../../selection/pythonServer'

// Sudachi 엔진 — python/sudachi_tokenize.py 를 상주 서버로 띄워 stdin/stdout JSON 한 줄
// 프로토콜로 통신한다(담당 A 의 layout_detect.py/ocr_paddle.py 와 동일 패턴,
// main/selection/pythonServer.ts 공용 인프라 재사용). SudachiDict 로딩(~1초 안팎)을
// 최초 1회만 물기 위해 프로세스를 재사용한다.
//
// 결과 병합은 IPADIC 엔진과 다른 규칙이 필요해서(UniDic 은 自立/非自立 구분이 없음)
// @shared/nlp/ja-unidic.ts 를 쓴다 — main/nlp/japanese.ts 디스패처가 엔진에 맞는 병합
// 함수를 고른다.

interface SudachiToken {
  surface: string
  pos: string
  posDetail1: string
  baseForm: string
  start: number
}

interface SudachiResponse {
  tokens: SudachiToken[]
}

const server = createPythonServer('sudachi_tokenize.py')

export async function tokenizeSudachi(text: string, mode: 'B' | 'C'): Promise<JaToken[]> {
  if (!text) return []
  const { tokens } = await server.request<{ text: string; mode: string }, SudachiResponse>({ text, mode })
  return tokens
}

/** 앱 시작 시 미리 불러 SudachiDict 로딩을 앞당겨둔다. */
export function warmSudachi(mode: 'B' | 'C'): void {
  tokenizeSudachi('準備', mode).catch(() => {
    // 예열 실패는 무시 — 실제 사용 시점에 다시 시도된다(Python 환경 미설치 등).
  })
}
