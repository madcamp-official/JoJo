import { createWorker, type Worker } from 'tesseract.js'
import type { Language, Word } from '@shared/types'
import type { Extracted } from './extractDirect'

// 담당 A — OCR 엔진 래퍼 (PLAN.md §4.1 / §6 / §8)
// 범용 엔진: Tesseract.js 채택 확정(오프라인, 언어팩 교체로 다국어 대응). 언어별 특화
// 엔진(예: 중국어 PaddleOCR)은 나중에 벤치마킹 후 라우팅 추가 — 지금은 Tesseract 단일 경로.

const TESS_LANG: Record<Language, string> = { en: 'eng', ja: 'jpn', zh: 'chi_sim' }

// 언어별 워커를 재사용한다 — 언어팩 로드 비용이 커서(수 MB 다운로드/초기화) 매 호출마다
// 새로 만들지 않는다. 언어가 바뀌면 이전 워커를 정리하고 새로 만든다.
let worker: Worker | null = null
let workerLang: Language | null = null

async function getWorker(language: Language): Promise<Worker> {
  if (worker && workerLang === language) return worker
  if (worker) await worker.terminate()
  worker = await createWorker(TESS_LANG[language])
  workerLang = language
  return worker
}

export async function runOcr(image: Buffer, language: Language): Promise<Extracted> {
  const w = await getWorker(language)
  // blocks 출력은 기본 꺼져 있음 — 단어별 bbox 를 얻으려면 명시적으로 켜야 한다.
  const { data } = await w.recognize(image, {}, { blocks: true })

  const words: Word[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            bbox: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            },
          })
        }
      }
    }
  }

  return { language, words: removeNoise(words) }
}

// 좌표 기반 노이즈 제거 (제목/페이지 번호 등) — PLAN.md §6
export function removeNoise(words: Word[]): Word[] {
  // TODO(담당 A): 위치·반복성·정렬 기반 필터링. 지금은 원본 결과 그대로 통과.
  return words
}
