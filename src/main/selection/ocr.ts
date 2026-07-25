import type { Language, Word } from '@shared/types'
import type { Extracted } from './extractDirect'

// 담당 A — OCR 엔진 래퍼 (PLAN.md §4.1 / §6 / §8)
// 언어 특화 OCR 수행 후, 좌표 기반 규칙으로 제목·페이지번호 등 노이즈 제거.
// 엔진: Tesseract.js(로컬) 또는 클라우드 OCR — D4에 벤치 후 결정.

export async function runOcr(_image: Buffer, language: Language): Promise<Extracted> {
  // TODO(담당 A):
  //  1) 언어 특화 OCR 실행 → 단어별 bbox 확보
  //  2) 좌표 기반 노이즈 필터 (removeNoise)
  //  3) 페이지 경계 걸친 문장 이어붙이기
  const words: Word[] = []
  return { language, words }
}

// 좌표 기반 노이즈 제거 (제목/페이지 번호 등) — PLAN.md §6
export function removeNoise(words: Word[]): Word[] {
  // TODO(담당 A): 위치·반복성·정렬 기반 필터링.
  return words
}
