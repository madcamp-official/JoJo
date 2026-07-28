import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect, Word } from '@shared/types'
import { createPythonServer, TINY_PNG } from './pythonServer'
import {
  clusterVerticalLinesIntoColumns,
  computeBaseline,
  estimateCellSizeFromIndent,
  excludeFurigana,
  groupCjkCharsGrid,
  median,
  MIN_BODY_LINE_HEIGHT,
  UNKNOWN_GAP_PLACEHOLDER,
} from './ocrPaddle'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). Yomitoku(python/ocr_yomitoku.py)
// 로 세로쓰기 일본어를 인식한다 — 도입 이유는 ocr_yomitoku.py 상단 주석 참고
// (PaddleOCR 대비 문장부호 누락/숫자 오독/긴 줄 뭉개짐이 실측으로 사라짐 확인).
//
// PaddleOCR 경로(ocrPaddle.ts)와 달리 워커 풀을 안 쓴다 — Yomitoku 는 검출+인식이
// 한 번의 호출로 크롭 영역 전체를 처리하므로(줄마다 따로 부를 필요 없음) PaddleOCR
// 처럼 "줄/열 개수만큼 병렬 호출"할 대상 자체가 없다. 서버 하나로 충분.
const server = createPythonServer('ocr_yomitoku.py')

interface RawLine {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  direction: 'vertical' | 'horizontal'
  rec_score: number
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

interface LineCandidate extends Rect {
  text: string
}

// Yomitoku 의 줄 bbox 상단 y좌표는 실측 확인 결과 몇 px 씩 들쭉날쭉하다(검출 모델의
// 경계 추정 오차) — groupCjkCharsGrid 는 이 y를 첫 글자 칸의 기준점으로 그대로 쓰므로,
// 이 오차가 그 줄 전체(글자 칸이 전부 같은 크기라 위→아래로 그대로 누적)에 계통적으로
// 반영된다(실사용 중 "몇몇 줄이 위/아래로 살짝 밀려서 시작"으로 확인). 다른 열들이
// 공유하는 기준선(computeBaseline)과 칸 크기(typicalCellSize)를 참고해서, 이 줄의
// 시작 y가 "기준선으로부터 정수 칸 배수" 근처에 있으면(정상적인 세로쓰기라면 항상
// 그래야 함 — 들여쓰기 없음=0칸, 문단 들여쓰기=1칸, 대시 등 미검출 구간=2칸 이상) 그
// 정확한 격자 위치로 스냅한다. 실측 오차 폭(몇 px)이 칸 크기 대비 크지 않아서, 가장
// 가까운 격자선까지의 잔차가 칸 크기의 일정 비율(SNAP_RESIDUAL_RATIO) 이내일 때만
// 스냅한다 — 이 범위를 벗어나면(격자와 안 맞음) 확신할 수 없으니 원본 그대로 둔다.
//
// 2칸 이상 떨어진 경우(줄 끝(trailing)/중간은 다루지 못함 — Yomitoku 가 글자 단위
// bbox 를 안 줘서 PaddleOCR 경로처럼 "인식된 글자들 사이의 간격"으로 못 찾음, 필요해
// 지면 DEBUG_OCR_DUMP 로 실측 확인 후 추가)는 대시 등 미검출 기호로 보고, 반올림한
// 칸수만큼 그대로 자리표자를 채운다(정확히 몇 종류/몇 개의 기호였는지는 추정하지
// 않는다 — UNKNOWN_GAP_PLACEHOLDER 주석 참고). count 계산 쪽 주석 참고.
const SNAP_RESIDUAL_RATIO = 0.35
const UNKNOWN_GAP_MIN_MULTIPLE = 2

function alignColumnStarts(lines: LineCandidate[], typicalCellSize: number | null): LineCandidate[] {
  if (!typicalCellSize) return lines
  // estimateCellSizeFromIndent(ocrPaddle.ts)와 동일하게 짧은 잡음 줄(후리가나 잔재 등,
  // "だが。" 같은 진짜로 짧은 본문 줄도 포함해 걸러짐)을 뺀 뒤 기준선을 잡는다 — 그 필터
  // 없이 전체 줄로 기준선을 구하면(직접 확인) 짧은 줄들이 최빈값을 살짝 흔들어서 판정이
  // 흔들린다.
  const baseline = computeBaseline(lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
  if (baseline === null) return lines
  return lines.map((line) => {
    const rawOffset = line.y - baseline
    const nearestMultiple = Math.round(rawOffset / typicalCellSize)
    const residual = rawOffset - nearestMultiple * typicalCellSize
    if (Math.abs(residual) > typicalCellSize * SNAP_RESIDUAL_RATIO) return line
    if (nearestMultiple < UNKNOWN_GAP_MIN_MULTIPLE) {
      // 0칸(기준선 그대로) 또는 1칸(문단 들여쓰기) — 자리표자 없이 시작 위치만 보정.
      const correctedY = baseline + nearestMultiple * typicalCellSize
      return { ...line, y: correctedY }
    }
    // 미검출 구간(대시 등) — 자리표자 개수를 고정값으로 두지 않는다. 몇 칸짜리 기호인지는
    // 실제로 페이지마다 다를 수 있다(실사용 중 확인: "――"(대시 2개)뿐 아니라 3칸을
    // 차지하는 다른 기호도 봤다는 보고) — 대신 Yomitoku 의 측정값(nearestMultiple)에서
    // 검출 여백만큼의 고정 편향을 뺀 값을 쓴다. 이 편향은 몇 칸짜리 기호든 항상 거의
    // 같게(실측: 대시 2개인 줄들의 측정값이 항상 실제보다 1칸 크게 나옴) 나타나는데,
    // Yomitoku 가 줄 bbox 상단을 실제 내용 시작보다 매번 비슷한 만큼 여유 있게 잡는
    // 경향 때문으로 보인다(내용이 몇 칸짜리든 이 여백 자체는 검출 방식의 특성이라
    // 일정할 것으로 예상됨) — 그래서 "측정값 - 1"이 몇 칸짜리 기호든 실제 칸수에
    // 더 가깝다.
    const DETECTION_PADDING_BIAS = 1
    const count = nearestMultiple - DETECTION_PADDING_BIAS
    const newY = baseline + DETECTION_PADDING_BIAS * typicalCellSize
    return {
      ...line,
      y: newY,
      height: line.y + line.height - newY,
      text: UNKNOWN_GAP_PLACEHOLDER.repeat(count) + line.text,
    }
  })
}

/**
 * 세로쓰기 열 하나(또는 열 구분이 안 된 영역 전체)를 Yomitoku 로 인식한다 —
 * recognizeVerticalColumnWithPaddle 의 Yomitoku 버전. 검출+인식이 한 번에 나오므로
 * detectLinesWithPaddle 같은 별도 검출 단계가 없다.
 *
 * 반환된 줄들은 PaddleOCR 경로와 동일하게 후리가나 제외(excludeFurigana) → 세로쓰기
 * 읽기 순서 재정렬(clusterVerticalLinesIntoColumns) → 시작 위치 격자 스냅 및 미검출
 * 구간 보정(alignColumnStarts) → 격자 기반 단어 분할(groupCjkCharsGrid)을 거친다 —
 * 이 함수들은 대부분 ocrPaddle.ts 에서 그대로 가져다 쓴다(줄 rect + 그 줄의 텍스트만
 * 있으면 인식 백엔드가 뭐든 동일하게 동작하도록 설계돼 있음).
 */
export async function recognizeVerticalColumnWithYomitoku(image: Buffer, columnBbox: Rect): Promise<Word[] | null> {
  const tmpPath = await writeCrop(image, columnBbox)
  let rawLines: RawLine[]
  try {
    const res = await server.request<{ image_path: string }, { lines: RawLine[] }>({ image_path: tmpPath })
    rawLines = res.lines
  } catch (err) {
    console.error('[ocrYomitoku] 인식 실패 — PaddleOCR 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `yomiraw-${Date.now()}.json`),
      JSON.stringify({ columnBbox, rawLines }, null, 2),
    )
  }

  // 세로쓰기가 아닌 결과(가로쓰기로 잘못 잡힌 UI 잡음 등)와, 인식 신뢰도가 극단적으로
  // 낮은 결과(실측 확인: 페이지 내용과 무관한 잡음 — 배경 텍스처 등에서 뜬금없이 숫자
  // 뭉치가 검출된 사례 — 의 rec_score 가 0.01 미만이었던 반면, 실제 본문은 인식이 서툰
  // 경우에도 0.17 이상이었다)는 제외한다. 크롭 기준 상대좌표를 절대좌표로 되돌린다.
  const MIN_REC_SCORE = 0.1
  const candidates: LineCandidate[] = rawLines
    .filter((l) => l.direction === 'vertical' && l.rec_score >= MIN_REC_SCORE)
    .map((l) => ({
      x: columnBbox.x + l.x0,
      y: columnBbox.y + l.y0,
      width: l.x1 - l.x0,
      height: l.y1 - l.y0,
      text: l.text,
    }))
  if (candidates.length === 0) return []

  // 후리가나 등 잡음 줄 제외 — PaddleOCR 경로(excludeFurigana)와 같은 원리지만, 폭
  // 비율 기준은 더 낮춰서 넘긴다(excludeFurigana 주석 참고 — Yomitoku 의 후리가나
  // 박스는 PaddleOCR 만큼 타이트하지 않아 기본값 1.8로는 실측 확인된 실제 후리가나
  // 잔재(예: 본문 21px 대비 12~15px, 비율 1.4~1.75)를 못 걸렀다).
  const YOMITOKU_FURIGANA_WIDTH_RATIO = 1.3
  const furiganaExcluded = excludeFurigana(candidates, YOMITOKU_FURIGANA_WIDTH_RATIO)

  // excludeFurigana 는 "가까이 붙은 더 넓은 부모 열"이 있어야만 걸러낸다 — 실측 확인
  // 결과, 본문과 무관한 좁은 잡음 열(예: 페이지 어딘가의 반각 숫자 "1")이 근처에 부모가
  // 없어서 그 필터를 그냥 통과하는 경우가 있었다(직접 확인: 폭 7px, rec_score=0.446 —
  // MIN_REC_SCORE 로도 안 걸러질 만큼 점수가 멀쩡했음). 세로쓰기 일본어 본문 열은
  // 전각 문자라 전부 폭이 비슷해야 한다는 걸 이용해, 살아남은 열들의 중앙값 폭보다
  // 뚜렷이 좁은(반각 숫자/기호 등) 열은 부모가 있든 없든 추가로 걸러낸다.
  const NARROW_COLUMN_WIDTH_RATIO = 0.6
  const widths = furiganaExcluded.map((c) => c.width).sort((a, b) => a - b)
  const medianWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)]! : 0
  const bodyCandidates = furiganaExcluded.filter((c) => c.width >= medianWidth * NARROW_COLUMN_WIDTH_RATIO)
  // 오른쪽 열부터, 열 안에서는 위→아래로 순서 재정렬.
  const ordered = clusterVerticalLinesIntoColumns(bodyCandidates)

  // typicalCellSize: ocrPaddle.ts 의 estimateCellSizeFromIndent 를 그대로 재사용한다
  // (들여쓰기 관례 기반 — alignColumnStarts 의 baseline 판정과 같은 기준을 공유해야
  // 격자 스냅이 어긋나지 않는다, 직접 확인). 들여쓰기된 줄이 하나도 없어 못 구하면
  // (글자 수 기반) median 폴백 — 줄 전체 텍스트가 이미 정확하므로 "글자 수" 자체를 못
  // 믿을 이유가 PaddleOCR 때보다 적다.
  const rawCellSizes = ordered
    .map((l) => {
      const n = [...l.text].length
      return n > 0 ? l.height / n : null
    })
    .filter((v): v is number => v !== null)
  const typicalCellSize = estimateCellSizeFromIndent(ordered) ?? (rawCellSizes.length > 0 ? median(rawCellSizes) : null)

  const withPlaceholder = alignColumnStarts(ordered, typicalCellSize)
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const baseline = computeBaseline(ordered.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `yomilines-${Date.now()}.json`),
      JSON.stringify({ typicalCellSize, baseline, ordered, withPlaceholder }, null, 2),
    )
  }

  const grouped = await Promise.all(
    withPlaceholder.map((line) => groupCjkCharsGrid(line, line.text, 'ja', true, typicalCellSize)),
  )
  return grouped.flat()
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
