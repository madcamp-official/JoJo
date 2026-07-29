import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect } from '@shared/types'
import { createPythonServer, TINY_PNG } from './pythonServer'

// 담당 A — 가로쓰기 일본어 후리가나 노이즈 대응(2026-07-29, python/ocr_yomitoku.py
// 상단 주석 참고). **검출 전용, 가로쓰기 전용** — 실제 텍스트 인식은 ocrPaddle.ts
// (recognizeLinesWithPaddle, 워커 풀로 병렬화돼 있어 빠름)에 맡기고, 여기서는
// PaddleOCR 의 detectLinesWithPaddle 이 후리가나를 본문과 한 박스로 합쳐버리는
// 문제를 피하기 위한 줄 위치만 제공한다. 세로쓰기는 다루지 않는다(NDLOCR-Lite 조합
// 그대로 유지, ocrNdlocr.ts).
//
// PaddleOCR 경로와 달리 워커 풀을 안 쓴다 — 검출 전용이라 이미 충분히 빠르고(실측
// 4~5초대), 크롭 하나당 한 번만 호출하면 되므로 병렬화할 대상 자체가 없다.
const server = createPythonServer('ocr_yomitoku.py')

interface RawLine {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

async function writeCrop(image: Buffer, cropBbox: Rect): Promise<string> {
  const cropped = nativeImage
    .createFromBuffer(image)
    .crop({
      x: Math.max(0, Math.round(cropBbox.x)),
      y: Math.max(0, Math.round(cropBbox.y)),
      width: Math.max(1, Math.round(cropBbox.width)),
      height: Math.max(1, Math.round(cropBbox.height)),
    })
    .toPNG()
  const tmpPath = join(tmpdir(), `nuance-yomitoku-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await writeFile(tmpPath, cropped)
  return tmpPath
}

// PaddleOCR 의 detect_lines(ocrPaddle.ts)는 점수 필터를 안 두므로(dt_polys 를 그대로
// 다 씀) 일관되게 여기서도 안 둔다 — 애매한 점수의 박스를 미리 걸러내는 것보다, 실제
// 인식(PaddleOCR recognizeLinesWithPaddle)까지 돌려보고 그 결과 텍스트가 비거나
// 신뢰도가 낮으면 그때 걸러지는 쪽이 더 정확하다는 게 기존 코드의 판단이라 그대로 따른다.

/**
 * DocLayout 이 나눈 블록(열) 하나(또는 열 구분이 안 된 영역 전체)에서 Yomitoku 로
 * 줄 위치만 찾는다(인식 없음) — detectLinesWithPaddle 의 Yomitoku 버전. 실패하면
 * (Python 환경 없음 등) null 을 반환해 호출부(ocr.ts)가 PaddleOCR 자체 검출로
 * 폴백하게 한다.
 */
export async function detectLinesWithYomitoku(image: Buffer, bbox: Rect): Promise<Rect[] | null> {
  const tmpPath = await writeCrop(image, bbox)
  try {
    const res = await server.request<{ image_path: string }, { lines: RawLine[] }>({ image_path: tmpPath })
    // 크롭 기준 상대좌표를 절대좌표로 되돌린다 — detectLinesWithPaddle 과 동일한 규약.
    return res.lines.map((l) => ({
      x: bbox.x + l.x0,
      y: bbox.y + l.y0,
      width: l.x1 - l.x0,
      height: l.y1 - l.y0,
    }))
  } catch (err) {
    console.error('[ocrYomitoku] 검출 실패 — PaddleOCR 자체 검출로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

/** 앱 시작 시(warmup.ts) 미리 불러 모델을 로드해둔다 — 첫 인스턴스화(HuggingFace Hub
 * 다운로드/가중치 로딩)가 몇 초 걸려서, 실제 사용 시점의 콜드 스타트를 없앤다. */
export async function warmUp(): Promise<void> {
  try {
    const tmpPath = await writeCrop(TINY_PNG, { x: 0, y: 0, width: 1, height: 1 })
    try {
      await server.request({ image_path: tmpPath })
    } finally {
      void unlink(tmpPath).catch(() => {})
    }
  } catch (err) {
    console.error('[ocrYomitoku] 예열 실패(무시):', err)
  }
}
