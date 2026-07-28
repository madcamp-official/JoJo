import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect, Word } from '@shared/types'
import { createPythonServer, NDLOCR_PYTHON_BIN, TINY_PNG } from './pythonServer'
import {
  clusterVerticalLinesIntoColumns,
  computeBaseline,
  computeSlotWeights,
  estimateCellSizeFromIndent,
  excludeFurigana,
  groupCjkCharsGrid,
  median,
  MIN_BODY_LINE_HEIGHT,
  padLine,
  recognizeWithPaddle,
  UNKNOWN_GAP_PLACEHOLDER,
} from './ocrPaddle'

// 담당 A — 실험용 브랜치(experiment/ndlocr-lite). ocrYomitoku.ts 의 NDLOCR-Lite
// (정확히는 "NDLkotenOCR-Lite", 일본 국립국회도서관의 옛 일본어 고문서용 검출+인식
// 모델 — https://github.com/ndl-lab/ndlocr-lite) 버전 — Yomitoku 대신 이걸 백엔드로
// 써보는 실험. 원래 목적(고문서)이 우리 유스케이스(현대 인쇄 세로쓰기)와 안 맞긴
// 하지만, 실측 확인 결과(sarashina 테스트 이미지, 라이트노벨 페이지) 본문 인식
// 신뢰도 0.88~0.93, 문장부호(、。)/대시 보존, 처리 시간 약 4초(콜드 스타트 제외 시
// 웜 호출은 1~2초대 — Yomitoku 약 19초 대비 훨씬 빠름)로 꽤 쓸만한 결과가 나왔다.
// 반면 縦中横(세로쓰기 안에 가로로 눕힌 숫자, 예: "17") 구간이 --enable-tcy 를
// 켜도 한 줄 전체가 통째로 누락되는 경우를 한 번 확인했다(오인식이 아니라 그 구간
// 자체가 텍스트에서 빠짐, 원인 파악 전 — 자세한 내용은 ocr_ndlocr.py 상단 주석).
//
// PaddleOCR 경로(ocrPaddle.ts)와 달리 워커 풀을 안 쓴다 — NDLOCR-Lite 도 Yomitoku
// 처럼 검출+인식이 한 번의 호출로 크롭 영역 전체를 처리하므로(줄마다 따로 부를
// 필요 없음) "줄/열 개수만큼 병렬 호출"할 대상 자체가 없다. 서버 하나로 충분.
const server = createPythonServer('ocr_ndlocr.py', [], NDLOCR_PYTHON_BIN)

interface RawLine {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  direction: 'vertical' | 'horizontal'
  rec_score: number
}

// 실측 확인(사용자 보고 기반): 열(세로쓰기 한 줄) 맨 끝 문장부호 누락이 자동 감지된
// 영역(regionSelection.ts: autoDetectRegion, DocLayout-YOLO 본문 블록 경계)에서 발생 —
// 그 경계가 본문 텍스트에 타이트하게 맞춰져서, 맨 아래 줄의 마지막 글자(대개 、/。)가
// 크롭 경계에 걸려 잘린 것으로 보인다. NDLOCR-Lite 자체의 인식 실패가 아니라 애초에
// 크롭에 온전히 안 들어간 문제라, 재인식으로는 못 고치고 크롭 범위 자체를 넉넉하게
// 줘야 한다. 사방에 여유를 주되(어느 쪽 경계든 같은 문제가 날 수 있음) 위 문제(맨 "아래"
// 줄 끝)가 실측된 사례라 세로 방향(특히 아래)에 더 신경 씀 — writeCrop 은 이미지 경계
// 밖으로 나가면 Electron 이 알아서 클램프하므로 안전하다.
//
// 실측 확인(사용자 보고, 2차): 오른쪽 경계에서도 같은 문제가 났다 — 맨 오른쪽 열(세로
// 쓰기는 오른쪽부터 읽으므로 읽기 순서상 첫 열)이 통째로 크롭에 반쪽만 걸쳐 들어가서
// 완전히 깨진 텍스트로 인식됐고(폭도 비정상적으로 좁게 잡힘 → 노이즈 필터에 걸러짐),
// 그 바깥쪽에 있었을 열은 아예 크롭 밖이라 인식 자체가 안 됐다. 24px로는 부족해서
// 48px로 넉넉히 키운다.
const CROP_MARGIN_PX = 48

interface CropResult {
  tmpPath: string
  // 실제로 크롭된 원점(음수/이미지 밖으로 못 나가게 클램프된 뒤의 값) — margin 을 준
  // 크롭은 요청한 cropBbox.x/y 와 다를 수 있어서, 인식 결과 좌표(크롭 기준 상대좌표)를
  // 절대좌표로 되돌릴 때 이 값을 써야 한다(단순히 cropBbox.x/y 를 쓰면 margin 만큼
  // 어긋난다).
  originX: number
  originY: number
}

async function writeCrop(image: Buffer, cropBbox: Rect, margin = 0): Promise<CropResult> {
  const originX = Math.max(0, Math.round(cropBbox.x - margin))
  const originY = Math.max(0, Math.round(cropBbox.y - margin))
  const cropped = nativeImage
    .createFromBuffer(image)
    .crop({
      x: originX,
      y: originY,
      width: Math.max(1, Math.round(cropBbox.width + margin * 2)),
      height: Math.max(1, Math.round(cropBbox.height + margin * 2)),
    })
    .toPNG()
  const tmpPath = join(tmpdir(), `nuance-ndlocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await writeFile(tmpPath, cropped)
  return { tmpPath, originX, originY }
}

interface LineCandidate extends Rect {
  text: string
}

// ocrYomitoku.ts 의 alignColumnStarts 와 동일한 원리(검출 모델의 줄 bbox 상단 y가
// 몇 px씩 들쭉날쭉해서 기준선+칸 크기로 스냅) — NDLOCR-Lite 도 Yomitoku 와 마찬가지로
// 글자 단위 bbox 없이 줄 전체 bbox 하나만 주기 때문에 로직을 그대로 재사용할 수 있다.
const SNAP_RESIDUAL_RATIO = 0.35
const UNKNOWN_GAP_MIN_MULTIPLE = 2

// leading 쪽에서 실측 확인된 편향(대시류 미검출 구간의 측정값이 항상 실제보다 1칸 크게
// 나옴 — 검출 모델이 줄 경계를 실제 내용보다 매번 비슷한 만큼 여유 있게 잡는 경향)을
// trailing(줄 끝) 쪽에도 그대로 적용한다(ocrYomitoku.ts 와 동일 가정).
const DETECTION_PADDING_BIAS = 1

// 실측 확인(사용자 보고 기반 검증): NDLOCR-Lite 는 못 읽은 구간을 그냥 빼먹지 않고
// **반각 스페이스(U+0020) 한 글자로 표시**한다 — "レベル 細剣使い"의 공백이 정확히
// 縦中横 숫자가 빠진 자리, "愛剣 を正中線"의 공백이 《…》 구간이 빠진 자리와 일치했다.
// 세로쓰기 일본어 본문에는 원래 스페이스가 없으므로(줄바꿈 대신도 안 씀), 이 문자
// 자체가 "여기 뭔가 있었는데 못 읽었다"는 신뢰할 수 있는 위치 마커다 — 아래쪽/앞쪽
// 줄 전체 길이 비교로 "아마 끝 쪽일 것"이라 추정하던 기존 방식보다 훨씬 정확하다
// (그 추정 방식은 애초에 못 읽은 구간만큼 NDLOCR 자신의 검출 bbox 도 같이 짧아지는
// 경우(예: "レベル [숫자]"의 숫자 부분)엔 아예 신호가 안 생겨서 못 잡았다 — 이 경우는
// 스페이스 마커가 있어야만 잡을 수 있다).
const GAP_MARKER_RE = / /
function hasGapMarker(text: string): boolean {
  return GAP_MARKER_RE.test(text)
}

interface AlignedLine extends LineCandidate {
  // 스페이스 마커가 있거나(위 주석) 줄 길이 계산상 미검출 구간이 의심되는 줄 —
  // resolveSuspiciousLines 가 이 줄만 PaddleOCR 로 다시 인식해서 마커를 채운다.
  suspicious: boolean
}

const slotCount = (text: string): number => computeSlotWeights([...text]).reduce((a, b) => a + b, 0)

function alignColumnStarts(lines: LineCandidate[], typicalCellSize: number | null): AlignedLine[] {
  if (!typicalCellSize) return lines.map((line) => ({ ...line, suspicious: hasGapMarker(line.text) }))
  const baseline = computeBaseline(lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
  if (baseline === null) return lines.map((line) => ({ ...line, suspicious: hasGapMarker(line.text) }))

  return lines.map((line, i): AlignedLine => {
    const originalBottom = line.y + line.height
    let newY = line.y
    let text = line.text
    // 문단 시작(새 문단) 마커 — slotCount 계산(칸 수 기반 미검출 구간 추정)에는 절대
    // 안 섞는다(개행 문자가 실제 잉크 높이 1칸으로 잘못 잡히면 trailing 미검출 판정이
    // 전부 어긋난다) — 그래서 별도 변수로 들고 있다가 함수 맨 끝, 모든 계산이 끝난
    // 뒤에만 text 앞에 붙인다.
    let paragraphStart = false

    // 줄 시작(맨 앞) 미검출 구간 — 위치가 확실하니(줄의 맨 앞) 바로 자리표자를 넣는다.
    const rawOffset = line.y - baseline
    const nearestMultiple = Math.round(rawOffset / typicalCellSize)
    const residual = rawOffset - nearestMultiple * typicalCellSize
    if (Math.abs(residual) <= typicalCellSize * SNAP_RESIDUAL_RATIO) {
      if (nearestMultiple < UNKNOWN_GAP_MIN_MULTIPLE) {
        // nearestMultiple === 1 — 세로쓰기 관례상 문단 들여쓰기(0칸=기준선 그대로,
        // 이어지는 줄) — 이 줄이 새 문단의 시작이라는 뜻이다. 지금까지는 이 판정을
        // Y좌표 보정에만 쓰고 텍스트에는 반영 안 했는데(사용자 요청으로 추가) — 최종
        // text 앞에 개행(\n)을 끼워 넣으면 word 하나(bbox 없는 gap 문자)로 그대로
        // 살아남고, 렌더러(selection.ts: indentParagraphs)가 이미 \n 기준으로 문단을
        // 나눠 전각 스페이스 들여쓰기를 자동으로 붙여주므로 별도 처리가 필요 없다.
        // 첫 줄(i===0)은 제외 — 문맥 전체의 맨 앞이라 "새 문단"이라는 개념 자체가
        // 없고(indentParagraphs 가 firstIsParagraphStart 로 별도 처리), 여기서까지
        // \n 을 붙이면 텍스트 맨 앞에 빈 문단이 하나 더 생긴다.
        if (nearestMultiple === 1 && i > 0) paragraphStart = true
        newY = baseline + nearestMultiple * typicalCellSize
      } else {
        const count = nearestMultiple - DETECTION_PADDING_BIAS
        newY = baseline + DETECTION_PADDING_BIAS * typicalCellSize
        text = UNKNOWN_GAP_PLACEHOLDER.repeat(count) + text
      }
    }

    // 줄 끝 미검출 구간 — "여기까지 인식됐다면 몇 번째 칸에서 끝나야 하는지"
    // (expectedBottom)와 실제 검출된 아래쪽 경계(originalBottom)를 비교한다. 스페이스
    // 마커(hasGapMarker)가 없는 줄에 대한 보조 신호일 뿐이다 — 마커가 있으면 이미
    // 위치를 아니까 이 계산과 무관하게 무조건 의심 처리한다.
    const expectedBottom = newY + slotCount(text) * typicalCellSize
    const trailingGap = originalBottom - expectedBottom
    const trailingMultiple = Math.round(trailingGap / typicalCellSize)
    const trailingResidual = trailingGap - trailingMultiple * typicalCellSize
    const sizeMismatchSuspicious =
      trailingMultiple >= UNKNOWN_GAP_MIN_MULTIPLE && Math.abs(trailingResidual) <= typicalCellSize * SNAP_RESIDUAL_RATIO

    if (paragraphStart) text = '\n' + text
    return {
      ...line,
      y: newY,
      height: originalBottom - newY,
      text,
      suspicious: hasGapMarker(text) || sizeMismatchSuspicious,
    }
  })
}

// 실측 확인(사용자 보고): 의심되는 줄 전체를 PaddleOCR 텍스트로 통째로 바꾸는 이전
// 방식은 심각한 부작용이 있었다 — PaddleOCR 은 원래 문장부호(、。)를 잘 놓치는
// 약점이 있는데(Yomitoku 로 전환했던 원래 이유이기도 함), 줄 하나에 자리표자 하나
// 넣으려고 줄 전체를 PaddleOCR 텍스트로 바꾸면 NDLOCR 이 이미 정확히 읽어둔 문장
// 부호까지 같이 사라졌다. 그래서 "통째 교체" 대신 **NDLOCR 원문은 그대로 두고, 마커
// 위치 앞뒤 몇 글자를 앵커 삼아 PaddleOCR 텍스트에서 그 사이 구간만 잘라내 마커
// 자리에 끼워 넣는다** — 나머지 텍스트(문장부호 포함)는 전혀 안 건드린다.
const ANCHOR_LEN = 4
// 실측 확인: NDLOCR-Lite 도 PaddleOCR 도 같은 화면을 다시 캡처해도 매번 100% 같은
// 결과가 나오는 게 아니다(멀티스레드 CPU 추론의 미세한 비결정성으로 보임) — 4글자
// 앵커가 이번엔 우연히 안 맞아서(PaddleOCR 쪽 인식이 그 지점만 살짝 달랐음) 전체가
// 실패하는 경우가 실측 확인됐다. 앵커를 점점 줄여가며 재시도해서 완벽히 안 맞아도
// 최대한 회수한다 — 짧을수록 오탐(엉뚱한 위치 매칭) 위험이 커지지만, MIN_ANCHOR_LEN
// 이하로는 안 내려가서 최소한의 신뢰도는 유지한다.
const MIN_ANCHOR_LEN = 2

/**
 * ndlocrText 안의 마커(스페이스) 하나를, 그 앞뒤 몇 글자를 앵커로 삼아 paddleText 에서
 * 찾은 대응 구간으로 치환한다. 앵커 길이를 ANCHOR_LEN 부터 MIN_ANCHOR_LEN 까지 줄여가며
 * 시도하고, 그래도 못 찾으면(문장 경계라 앵커가 너무 짧음 등) null 을 반환해 호출부가
 * 안전하게 폴백하게 한다.
 */
function spliceOneMarker(ndlocrText: string, paddleText: string, markerIndex: number): string | null {
  const chars = [...ndlocrText]
  const before = chars.slice(0, markerIndex).join('')
  const after = chars.slice(markerIndex + 1).join('')

  for (let len = ANCHOR_LEN; len >= MIN_ANCHOR_LEN; len--) {
    const beforeAnchor = before.slice(-len)
    const afterAnchor = after.slice(0, len)
    if (!beforeAnchor && !afterAnchor) continue

    let startIdx = 0
    if (beforeAnchor) {
      const idx = paddleText.indexOf(beforeAnchor)
      if (idx === -1) continue
      startIdx = idx + beforeAnchor.length
    }
    let endIdx = paddleText.length
    if (afterAnchor) {
      const idx = paddleText.indexOf(afterAnchor, startIdx)
      if (idx === -1) continue
      endIdx = idx
    }
    if (endIdx < startIdx) continue
    const recovered = paddleText.slice(startIdx, endIdx)
    if (!recovered) continue
    return before + recovered + after
  }
  return null
}

/**
 * suspicious 로 표시된 줄만 PaddleOCR 로 다시 인식해서, 마커(스페이스, 앞쪽 미검출
 * 구간)들을 spliceOneMarker 로 하나씩 실제 내용으로 치환한다(왼쪽부터 순서대로 —
 * 인덱스가 앞쪽 치환으로 밀리지 않게). 어느 경우든 NDLOCR 원문의 나머지 부분(문장부호
 * 등 이미 정확했던 내용)은 전혀 건드리지 않는다.
 *
 * 앵커를 못 찾아 치환 실패한 마커는 자리표자를 넣지 않고 그냥 조용히 지운다(실측 확인
 * 후 변경 — 이전엔 UNKNOWN_GAP_PLACEHOLDER 로 남겼는데, NDLOCR-Lite 의 스페이스 마커
 * 자체가 항상 정확한 신호는 아니었다: 실제로는 아무것도 안 빠졌는데 마커를 잘못 넣는
 * 오탐 사례가 실측 확인됨 — PaddleOCR 로 다시 봐도 그 자리에서 아무 근거를 못 찾았다면
 * "PaddleOCR 도 못 찾은 진짜 미검출"보다 "애초에 오탐이었다"일 가능성이 더 높다고
 * 보고, 자리표자로 눈에 띄게 남기는 대신 조용히 지운다). 트레이드오프: 아주 드물게
 * PaddleOCR 마저 놓친 진짜 미검출 구간은 이제 아무 표시 없이 사라진다.
 */
async function resolveSuspiciousLines(
  image: Buffer,
  lines: AlignedLine[],
): Promise<LineCandidate[]> {
  return Promise.all(
    lines.map(async (line): Promise<LineCandidate> => {
      if (!line.suspicious) return line
      const rawWords = await recognizeWithPaddle(image, 'ja', padLine(line))
      const units = rawWords?.filter((w) => w.bbox) ?? []
      const paddleText = units.map((u) => u.text).join('')

      let text = line.text
      // 왼쪽부터 순서대로 처리 — 매번 현재 text 기준으로 마커 위치를 다시 찾아야
      // 앞선 치환으로 문자 오프셋이 밀린 걸 반영할 수 있다.
      let markerIndex = text.indexOf(' ')
      while (markerIndex !== -1) {
        const spliced = paddleText ? spliceOneMarker(text, paddleText, markerIndex) : null
        text = spliced ?? text.slice(0, markerIndex) + text.slice(markerIndex + 1)
        markerIndex = text.indexOf(' ')
      }
      return { ...line, text }
    }),
  )
}

/**
 * 세로쓰기 열 하나(또는 열 구분이 안 된 영역 전체)를 NDLOCR-Lite 로 인식한다 —
 * recognizeVerticalColumnWithYomitoku 의 NDLOCR-Lite 버전. 검출+인식이 한 번에
 * 나오므로 detectLinesWithPaddle 같은 별도 검출 단계가 없다.
 */
export async function recognizeVerticalColumnWithNdlocr(image: Buffer, columnBbox: Rect): Promise<Word[] | null> {
  const { tmpPath, originX, originY } = await writeCrop(image, columnBbox, CROP_MARGIN_PX)
  let rawLines: RawLine[]
  try {
    const res = await server.request<{ image_path: string }, { lines: RawLine[] }>({ image_path: tmpPath })
    rawLines = res.lines
  } catch (err) {
    console.error('[ocrNdlocr] 인식 실패 — PaddleOCR 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `ndlocrraw-${Date.now()}.json`),
      JSON.stringify({ columnBbox, rawLines }, null, 2),
    )
  }

  // 신뢰도/방향 필터 임계값은 ocrYomitoku.ts 와 동일하게 시작(둘 다 rec_score 스케일이
  // 비슷한 confidence 값이라 동일 기준을 우선 재사용 — NDLOCR-Lite 고유의 잡음 분포는
  // 아직 실측 데이터가 부족해 재조정 전).
  const MIN_REC_SCORE = 0.1
  const candidates: LineCandidate[] = rawLines
    .filter((l) => l.direction === 'vertical' && l.rec_score >= MIN_REC_SCORE)
    .map((l) => ({
      x: originX + l.x0,
      y: originY + l.y0,
      width: l.x1 - l.x0,
      height: l.y1 - l.y0,
      text: l.text,
    }))
  if (candidates.length === 0) return []

  const YOMITOKU_FURIGANA_WIDTH_RATIO = 1.3
  const furiganaExcluded = excludeFurigana(candidates, YOMITOKU_FURIGANA_WIDTH_RATIO)

  const NARROW_COLUMN_WIDTH_RATIO = 0.6
  const widths = furiganaExcluded.map((c) => c.width).sort((a, b) => a - b)
  const medianWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)]! : 0
  const bodyCandidates = furiganaExcluded.filter((c) => c.width >= medianWidth * NARROW_COLUMN_WIDTH_RATIO)
  const ordered = clusterVerticalLinesIntoColumns(bodyCandidates)

  // typicalCellSize: ocrYomitoku.ts 실험 때 이미 검증했던 조합 방식을 이식한다(스태시에
  // 남아있던 걸 확인 후 재사용). 서로 다른 두 정보원을 가중 평균한다:
  //  1) 들여쓰기 기반(estimateCellSizeFromIndent) — 여러 열이 공유하는 기준선과
  //     문단 들여쓰기 오프셋의 차이. 열의 "시작 y좌표"만 보는 순수 검출 정보라
  //     인식 품질과 무관하게 깨끗하다.
  //  2) 긴 줄 기반 — 글자 수(縦中横 압축 반영한 slotCount)가 충분히 많은 줄들만 골라
  //     (검출 높이 ÷ 칸 수)의 중앙값을 쓴다. 글자 수가 많을수록 줄 위/아래 경계의
  //     검출 오차(고정된 몇 px)가 더 많은 글자에 나눠져서 글자당 오차가 작아진다 —
  //     짧은 줄까지 다 포함해서 평균 내면 오차가 커서 값이 실제보다 작게 나왔다(실측
  //     확인, ocrYomitoku.ts). 줄 끝이 문장부호(、。 등)면 잉크가 작아 검출 높이가
  //     그만큼 다 안 나와서 값이 작게 나오므로(실측 확인) 그런 줄은 표본에서 뺀다.
  // 1)과 2) 둘 다 구해지면 2:1 가중치(긴 줄 기반을 더 신뢰)로 내분한다(실측 비교 결과
  // 단순 평균은 실제값보다 살짝 크게 나왔음, ocrYomitoku.ts). 하나만 구해지면 그 값을
  // 그대로 쓰고, 둘 다 없으면 열 폭 → 전체 줄 평균 순으로 폴백한다.
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
      return n > 0 ? l.height / n : null
    })
    .filter((v): v is number => v !== null)
  const cellSizeFromIndent = estimateCellSizeFromIndent(ordered)
  const cellSizeFromLongLines = cellSizesFromLongLines.length > 0 ? median(cellSizesFromLongLines) : null
  const typicalCellSize =
    cellSizeFromIndent !== null && cellSizeFromLongLines !== null
      ? (cellSizeFromIndent + 2 * cellSizeFromLongLines) / 3
      : (cellSizeFromIndent ?? cellSizeFromLongLines ?? cellSizeFromWidth ?? (rawCellSizes.length > 0 ? median(rawCellSizes) : null))

  const aligned = alignColumnStarts(ordered, typicalCellSize)
  // 의심되는 줄만 PaddleOCR 로 대조 인식해서 마커를 실제 내용으로 치환한다
  // (resolveSuspiciousLines 주석 참고).
  const withPlaceholder = await resolveSuspiciousLines(image, aligned)
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const baseline = computeBaseline(ordered.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `ndlocrlines-${Date.now()}.json`),
      JSON.stringify({ typicalCellSize, baseline, ordered, aligned, withPlaceholder }, null, 2),
    )
  }

  const grouped = await Promise.all(
    withPlaceholder.map((line) => groupCjkCharsGrid(line, line.text, 'ja', true, typicalCellSize)),
  )
  return grouped.flat()
}

/** 앱 시작 시(warmup.ts) 미리 불러 모델을 로드해둔다 — 첫 인스턴스화(모델 파일 로딩)가
 * 몇 초 걸려서(실측: 콜드 스타트 약 10초), 실제 사용 시점의 지연을 없앤다. */
export async function warmUp(): Promise<void> {
  try {
    const { tmpPath } = await writeCrop(TINY_PNG, { x: 0, y: 0, width: 1, height: 1 })
    try {
      await server.request({ image_path: tmpPath })
    } finally {
      void unlink(tmpPath).catch(() => {})
    }
  } catch (err) {
    console.error('[ocrNdlocr] 예열 실패(무시):', err)
  }
}
