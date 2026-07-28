import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect, Word } from '@shared/types'
import { createPythonServer, TINY_PNG } from './pythonServer'
import {
  clusterVerticalLinesIntoColumns,
  computeBaseline,
  computeSlotWeights,
  estimateCellSizeFromIndent,
  excludeFurigana,
  groupCjkCharsGrid,
  insertGapPlaceholdersForLine,
  median,
  MIN_BODY_LINE_HEIGHT,
  padLine,
  recognizeWithPaddle,
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

// leading 쪽에서 실측 확인된 편향(대시 2개인 줄들의 측정값이 항상 실제보다 1칸 크게
// 나옴 — Yomitoku 가 줄 경계를 실제 내용보다 매번 비슷한 만큼 여유 있게 잡는 경향)을
// trailing(줄 끝) 쪽에도 그대로 적용한다 — 같은 검출 메커니즘이 아래쪽 경계에도 대칭
//적으로 작용할 것으로 보고 적용한 것으로, trailing 전용 실측 검증은 아직 못 했다
// (필요해지면 DEBUG_OCR_DUMP 로 확인 후 조정).
const DETECTION_PADDING_BIAS = 1

interface AlignedLine extends LineCandidate {
  // 줄 끝(또는 중간, 구분 불가) 어딘가에 미검출 구간이 있는 것으로 의심되는 줄 —
  // Yomitoku 의 bbox+텍스트만으로는 그 구간이 정확히 어디인지 알 수 없어(글자 단위
  // 좌표가 없음), recognizeVerticalColumnWithYomitoku 가 이 줄만 PaddleOCR 로 다시
  // 인식해(글자 단위 좌표를 얻어) 정확한 위치를 찾는다. 여기서는 위치를 못 찾으니
  // 자리표자를 아직 안 넣고, PaddleOCR 폴백도 실패할 경우에 대비해 대략적인 개수만
  // blindTrailingCount 에 남겨둔다(최후 수단으로 줄 끝에 뭉텅이로 붙임).
  suspiciousTrailingGap: boolean
  blindTrailingCount: number
}

function alignColumnStarts(lines: LineCandidate[], typicalCellSize: number | null): AlignedLine[] {
  if (!typicalCellSize) return lines.map((line) => ({ ...line, suspiciousTrailingGap: false, blindTrailingCount: 0 }))
  // estimateCellSizeFromIndent(ocrPaddle.ts)와 동일하게 짧은 잡음 줄(후리가나 잔재 등,
  // "だが。" 같은 진짜로 짧은 본문 줄도 포함해 걸러짐)을 뺀 뒤 기준선을 잡는다 — 그 필터
  // 없이 전체 줄로 기준선을 구하면(직접 확인) 짧은 줄들이 최빈값을 살짝 흔들어서 판정이
  // 흔들린다.
  const baseline = computeBaseline(lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
  if (baseline === null) return lines.map((line) => ({ ...line, suspiciousTrailingGap: false, blindTrailingCount: 0 }))
  const slotCount = (text: string): number => computeSlotWeights([...text]).reduce((a, b) => a + b, 0)

  return lines.map((line): AlignedLine => {
    const originalBottom = line.y + line.height
    let newY = line.y
    let text = line.text

    // 줄 시작(맨 앞) 미검출 구간 — 다른 열들이 공유하는 기준선과 비교해 이 줄의 시작
    // 위치가 정수 칸 배수만큼 아래에 있는지 본다. 이건 위치가 확실하니(줄의 맨 앞)
    // 바로 자리표자를 넣는다 — PaddleOCR 폴백 대상이 아니다.
    const rawOffset = line.y - baseline
    const nearestMultiple = Math.round(rawOffset / typicalCellSize)
    const residual = rawOffset - nearestMultiple * typicalCellSize
    if (Math.abs(residual) <= typicalCellSize * SNAP_RESIDUAL_RATIO) {
      if (nearestMultiple < UNKNOWN_GAP_MIN_MULTIPLE) {
        // 0칸(기준선 그대로) 또는 1칸(문단 들여쓰기) — 자리표자 없이 시작 위치만 보정.
        newY = baseline + nearestMultiple * typicalCellSize
      } else {
        // 미검출 구간(대시 등) — 자리표자 개수를 고정값으로 두지 않는다. 몇 칸짜리
        // 기호인지는 실제로 페이지마다 다를 수 있다(실사용 중 확인: "――"(대시 2개)
        // 뿐 아니라 3칸을 차지하는 다른 기호도 봤다는 보고) — 대신 측정값에서 검출
        // 여백만큼의 고정 편향을 뺀 값을 쓴다.
        const count = nearestMultiple - DETECTION_PADDING_BIAS
        newY = baseline + DETECTION_PADDING_BIAS * typicalCellSize
        text = UNKNOWN_GAP_PLACEHOLDER.repeat(count) + text
      }
    }

    // 줄 끝(또는 중간) 미검출 구간 — 위에서 구한 시작 위치(newY)와 지금까지의 텍스트
    // (자리표자 포함)만으로 "여기까지 인식됐다면 몇 번째 칸에서 끝나야 하는지"
    // (expectedBottom)를 계산할 수 있고, Yomitoku 가 실제로 검출한 줄의 아래쪽 경계
    // (originalBottom)와 비교하면 그 차이만큼 어딘가에 미검출 구간이 있었다는 뜻이다.
    // 다만 이 총량만으로는 그게 줄 "끝"인지 "중간"인지 구분이 안 되므로(둘 다 같은
    // 총량 차이를 만듦), 여기선 바로 텍스트에 붙이지 않고 의심 표시만 해둔다 —
    // 정확한 위치는 recognizeVerticalColumnWithYomitoku 가 PaddleOCR 재인식으로 찾는다.
    const expectedBottom = newY + slotCount(text) * typicalCellSize
    const trailingGap = originalBottom - expectedBottom
    const trailingMultiple = Math.round(trailingGap / typicalCellSize)
    const trailingResidual = trailingGap - trailingMultiple * typicalCellSize
    const suspicious =
      trailingMultiple >= UNKNOWN_GAP_MIN_MULTIPLE && Math.abs(trailingResidual) <= typicalCellSize * SNAP_RESIDUAL_RATIO
    const blindTrailingCount = suspicious ? Math.max(0, trailingMultiple - DETECTION_PADDING_BIAS) : 0

    return {
      ...line,
      y: newY,
      height: originalBottom - newY,
      text,
      suspiciousTrailingGap: suspicious,
      blindTrailingCount,
    }
  })
}

/**
 * suspiciousTrailingGap 로 표시된 줄만 PaddleOCR 로 다시 인식해(글자 단위 좌표를 얻어)
 * insertGapPlaceholdersForLine 으로 정확한 위치에 자리표자를 넣는다 — Yomitoku 는 줄
 * 전체를 한 bbox 로만 주기 때문에 이 정밀도가 아예 없다. PaddleOCR 도 이 시점엔 검출/
 * 인식 정확도가 완벽하지 않을 수 있지만(실사용 중 여러 번 확인된 한계), 적어도 글자
 * 단위 위치 정보는 있어서 "어디에 구멍이 있는지"는 Yomitoku 보다 훨씬 정확히 찾는다 —
 * 대신 이 한 줄에 한해서는 텍스트 자체(내용)도 PaddleOCR 결과로 통째로 교체한다(Yomitoku
 * 인식이 대체로 더 정확하지만, 이 줄은 애초에 위치가 안 맞는 걸 감수하느니 정확한 위치를
 * 얻는 쪽을 택함). PaddleOCR 마저 실패하면(Python 환경 없음 등) 위치를 모르니 최후
 * 수단으로 줄 끝에 뭉텅이로 자리표자를 붙인다(alignColumnStarts 가 미리 구해둔 개수).
 */
async function resolveSuspiciousLines(
  image: Buffer,
  lines: AlignedLine[],
  typicalCellSize: number,
): Promise<LineCandidate[]> {
  return Promise.all(
    lines.map(async (line): Promise<LineCandidate> => {
      if (!line.suspiciousTrailingGap) return line
      const rawWords = await recognizeWithPaddle(image, 'ja', padLine(line))
      const units = rawWords?.filter((w) => w.bbox) ?? []
      if (units.length === 0) {
        return { ...line, text: line.text + UNKNOWN_GAP_PLACEHOLDER.repeat(line.blindTrailingCount) }
      }
      const paddleText = units.map((u) => u.text).join('')
      return { ...line, text: insertGapPlaceholdersForLine(line, units, paddleText, typicalCellSize) }
    }),
  )
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

  // typicalCellSize: 충분히 긴 줄들의 (검출 높이 ÷ 칸 수) 중앙값을 쓴다. 글자 수가
  // 많을수록 줄 위/아래 경계의 검출 오차(고정된 몇 px)가 더 많은 글자에 나눠져서 글자당
  // 오차가 작아진다 — 실측 확인: 짧은 줄까지 다 포함해서 평균 내면(예전 방식) 오차가
  // 커서 값이 실제보다 작게 나왔고, 대신 열 폭(가로=세로인 정사각형 칸 가정)을 썼을
  // 땐 실제보다 살짝(약 3%) 크게 나왔다 — 반면 글자 수 40개가 넘는 줄들만 골라 높이÷
  // 칸수를 재보니 서로 오차 범위 안에서 일치했다(약 17.2~17.6, 표준적인 "긴 줄" 측정치).
  // "칸 수"는 단순 글자 수가 아니라 computeSlotWeights 로 縦中横(정확히 2자리 숫자
  // 연속은 한 칸으로 압축) 가중치를 반영한 값이다 — 처음엔 그냥 글자 수로 나눴다가
  // 실사용 중 확인 결과("16" 같은 압축 숫자가 낀 줄에서) 값이 실제보다 작게 나왔다
  // (분모가 실제 칸 수보다 크게 잡혀서). 짧은 줄(LONG_LINE_MIN_CHARS 미만)은 여전히
  // 노이즈가 커서 이 계산에서 제외하고, 위치 스냅(alignColumnStarts)에만 전체 줄에
  // 이 공통값을 적용한다.
  const slotCount = (text: string): number => computeSlotWeights([...text]).reduce((a, b) => a + b, 0)
  // 문장부호(、。 등)는 칸 수(slotCount)엔 한 칸으로 그대로 잡히지만, 잉크 자체가
  // 작아서 Yomitoku 가 잡는 검출 높이는 그 칸만큼 다 안 나온다 — 줄 맨 끝이 문장부호면
  // (줄 안 중간에 있는 건 앞뒤 글자에 가려 경계에 큰 영향 없음, 문제는 줄의 "끝"이라
  // 그 좁은 잉크가 곧 줄 전체의 아래쪽 경계가 되는 경우) 그만큼 높이÷칸수 값이 실제보다
  // 작게 나온다(실사용 중 확인). 정확히 얼마나 작게 잡히는지 보정하기보단, 그런 줄은
  // 아예 이 측정 표본에서 제외한다.
  const TRAILING_PUNCTUATION_RE = /[、。・！？…]$/
  const LONG_LINE_MIN_CHARS = 20
  const cellSizesFromLongLines = ordered
    .map((l) => {
      const n = [...l.text].length
      if (n < LONG_LINE_MIN_CHARS || TRAILING_PUNCTUATION_RE.test(l.text)) return null
      return l.height / slotCount(l.text)
    })
    .filter((v): v is number => v !== null)
  const cellSizeFromWidth = ordered.length > 0 ? median(ordered.map((l) => l.width)) : null
  const rawCellSizes = ordered
    .map((l) => {
      const n = [...l.text].length
      return n > 0 ? l.height / slotCount(l.text) : null
    })
    .filter((v): v is number => v !== null)
  // 들여쓰기 기반(estimateCellSizeFromIndent)과 긴 줄 기반(cellSizesFromLongLines)은
  // 서로 완전히 다른 정보원(하나는 열의 시작 y좌표, 하나는 줄의 검출 높이)에서 나온
  // 독립적인 추정치다 — 실측 비교 결과(직접 확인) 각각 18과 17.61로 가까웠지만, 단순
  // 평균(1:1)은 실제값보다 아주 살짝 크게 나왔다(직접 확인) — 긴 줄 기반 쪽이 더 정확한
  // 값에 가깝다고 보고 2:1 가중치(긴 줄 기반을 더 신뢰)로 내분한다. 하나만 구해지면
  // 그 값을 그대로 쓰고, 둘 다 없으면 열 폭 → 전체 줄 평균 순으로 폴백한다.
  const cellSizeFromIndent = estimateCellSizeFromIndent(ordered)
  const cellSizeFromLongLines = cellSizesFromLongLines.length > 0 ? median(cellSizesFromLongLines) : null
  const typicalCellSize =
    cellSizeFromIndent !== null && cellSizeFromLongLines !== null
      ? (cellSizeFromIndent + 2 * cellSizeFromLongLines) / 3
      : (cellSizeFromIndent ?? cellSizeFromLongLines ?? cellSizeFromWidth ?? (rawCellSizes.length > 0 ? median(rawCellSizes) : null))

  const aligned = alignColumnStarts(ordered, typicalCellSize)
  // 줄 끝/중간 어딘가에 미검출 구간이 의심되는 줄만 PaddleOCR 로 다시 인식해 정확한
  // 위치를 찾는다(resolveSuspiciousLines 주석 참고) — typicalCellSize 가 없으면
  // alignColumnStarts 가 애초에 아무 줄도 의심 표시를 안 하므로 건너뛴다.
  const withPlaceholder = typicalCellSize !== null ? await resolveSuspiciousLines(image, aligned, typicalCellSize) : aligned
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const baseline = computeBaseline(ordered.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `yomilines-${Date.now()}.json`),
      JSON.stringify({ typicalCellSize, baseline, ordered, aligned, withPlaceholder }, null, 2),
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
