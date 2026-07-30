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
  excludeFuriganaHorizontal,
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
// 사용자 보고: NDLOCR-Lite 는 원문의 다시(ダーシ, "――" 두 칸짜리 가로선) 기호를 매번
// 같은 글자로 인식하지 않는다 — 어떤 캡처에서는 U+2015(HORIZONTAL BAR, "―") 한 글자로,
// 어떤 캡처에서는 반각 하이픈 두 개("--")로 나온다(같은 원문을 다시 캡처해도 결과가
// 달라지는 인식 비결정성, ocrPaddle.ts 의 WIDE_DASH_CHARS 주석 참고). 실측 확인(추가):
// PaddleOCR 은 반각 하이픈 "하나"("-")나 엠 대시("—")로 인식하기도 한다 — 세로쓰기
// 일본어 본문에는 원래 ASCII 하이픈이 나올 일이 없으므로, 길이(1개/2개)나 문자 종류와
// 무관하게 다 같은 다시 기호로 보고 통일한다. 팝업에 표시될 때 표기가 들쭉날쭉하지
// 않도록 "―" 한 글자로 정규화한다 — computeSlotWeights 의 WIDE_DASH_CHARS 처리가 이미
// "―"를 2칸 가중치로 잡아주므로, 여기서 미리 통일해두면(문자 여러 개 → 1개로 줄어도)
// 위치 계산도 자동으로 맞는다. rawLines 를 받은 직후, 격자 계산 전에 적용해야 한다 —
// 나중에(글자 수를 이미 센 뒤에) 바꾸면 오히려 어긋난다. NDLOCR 원문뿐 아니라 PaddleOCR
// 재인식 텍스트를 이어붙이는 모든 지점(fillInterLineGaps/resolveSuspiciousLines)에서도
// 반드시 이 함수를 거쳐야 한다 — 안 그러면 그 경로로 들어온 텍스트만 정규화가 안 돼서
// 표기가 다시 섞여 나온다(실측 확인).
function normalizeDashes(text: string): string {
  return text.replace(/-{1,2}|—/g, '―')
}

// 실측 확인(사용자 보고): "HP"(게임 스탯 약자, 라이트노벨 본문에 자주 등장)의 "H"가
// 한자 "日"로 오인식됐다("アスナの日P" → 원문은 "アスナのHP") — 네모+가로선 모양이
// 비슷해서 생기는 흔한 OCR 혼동으로 보인다. 일반 일본어 산문에서 한자 바로 뒤에
// 공백·구두점 없이 대문자 알파벳이 붙는 경우는 사실상 없어서, 그 패턴 자체를 "이
// 한자는 사실 알파벳이었다"는 신호로 본다 — 알려진 혼동 쌍만 좁게 교정한다(발견되는
// 대로 표를 늘려간다).
const KANJI_LATIN_CONFUSION: Record<string, string> = { 日: 'H' }
const KANJI_BEFORE_UPPERCASE_RE = /[一-鿿](?=[A-Z])/gu
function fixKanjiLatinConfusion(text: string): string {
  return text.replace(KANJI_BEFORE_UPPERCASE_RE, (m) => KANJI_LATIN_CONFUSION[m] ?? m)
}

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

// 실측 확인(사용자 요청): 높이 비교(sizeMismatchSuspicious)는 NDLOCR-Lite 자신의 검출
// bbox 가 못 읽은 구간만큼 같이 줄어드는 경우("……" 등)엔 애초에 비교할 "여분의 높이"
// 자체가 없어서 원리적으로 못 잡는다(실측 확인: 40글자짜리 줄에서 741px÷40=18.53,
// 공유 기준 18.43 과 사실상 동일 — 이상 신호가 아예 없음). 그래서 OCR 엔진이 뭐라고
// 보고하든 무시하고, 같은 열 안에서 인접한 두 줄 "사이"의 원본 이미지 픽셀을 직접
// 봐서 잉크(배경이 아닌 색)가 있는지 확인한다 — 어떤 OCR 엔진의 자기 보고에도 기대지
// 않는 유일한 방법이라 가장 근본적이다. 잉크가 확인되면 그 자리만 PaddleOCR 로 다시
// 인식해서 두 줄 사이에 채워 넣는다.
function computeInkFraction(bitmap: Buffer): number {
  if (bitmap.length < 4) return 0
  // BGRA 4바이트당 1픽셀(Electron NativeImage.toBitmap 포맷) — 밝기(luminance)만 본다.
  const pixelCount = bitmap.length / 4
  const brightness = new Float64Array(pixelCount)
  let maxBrightness = 0
  for (let i = 0, p = 0; i < bitmap.length; i += 4, p++) {
    const b = bitmap[i]!
    const g = bitmap[i + 1]!
    const r = bitmap[i + 2]!
    const lum = (r * 299 + g * 587 + b * 114) / 1000
    brightness[p] = lum
    if (lum > maxBrightness) maxBrightness = lum
  }
  // 이 영역 안에서 가장 밝은 픽셀을 배경색 기준으로 삼는다(고정된 "흰 배경" 가정 대신,
  // 다크 모드 등 다른 배색에도 자연히 대응) — 그보다 뚜렷이 어두운(DARK_DELTA 이상)
  // 픽셀의 비율을 "잉크 비율"로 본다.
  const DARK_DELTA = 40
  let darkCount = 0
  for (let p = 0; p < brightness.length; p++) {
    if (maxBrightness - brightness[p]! >= DARK_DELTA) darkCount++
  }
  return pixelCount > 0 ? darkCount / pixelCount : 0
}

const INK_FRACTION_THRESHOLD = 0.015 // 이 비율 이상 어두운 픽셀이 있으면 "잉크 있음"으로 본다.

function hasInkInRegion(image: Buffer, rect: Rect): boolean {
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const bitmap = nativeImage.createFromBuffer(image).crop({ x, y, width, height }).toBitmap()
  return computeInkFraction(bitmap) >= INK_FRACTION_THRESHOLD
}

// 이 비율(기준 칸 크기 대비) 이상 벌어진 인접 줄 사이 간격만 검사한다 — 정상적인
// 줄과 줄 사이 여백(자간)까지 매번 픽셀 검사하면 느려지기만 하고 신호도 없다.
const MIN_SUSPICIOUS_GAP_RATIO = 0.4
// 같은 열로 볼 x좌표 오차 허용치(px) — clusterVerticalLinesIntoColumns 가 이미 열로
// 묶어놨으므로 ordered 배열에서 연속된 원소가 x좌표까지 거의 같으면 같은 열이다.
const SAME_COLUMN_X_TOLERANCE = 4

/**
 * 같은 열 안에서 인접한 두 줄 사이 간격이 비정상적으로 크고(MIN_SUSPICIOUS_GAP_RATIO)
 * 그 자리에 실제 잉크가 있으면(hasInkInRegion), PaddleOCR 로 그 구간만 다시 인식해서
 * 앞 줄의 텍스트 끝에 이어 붙이고 앞 줄의 높이를 뒷 줄 시작까지 늘린다 — 이러면 이후
 * alignColumnStarts/groupCjkCharsGrid 가 늘어난 높이와 늘어난 텍스트를 자연스럽게
 * 같이 처리한다(별도 특별 케이스가 필요 없음).
 */
// 실측 확인(사용자 요청으로 시도 후 되돌림): 같은 열의 "다음 줄"이 없는 경우(열의
// 마지막 줄, 또는 열 하나 = 줄 하나)에도 고정 몇 칸까지 아래를 검사해보는 확장을
// 시도했었는데, 비교할 "다음 줄의 실제 시작 위치"라는 확실한 기준이 없다 보니 열
// 바깥의 무관한 내용(페이지 하단 쪽번호 등)까지 잉크로 잡혀 엉뚱한 숫자가 본문에
// 섞여 들어가는 회귀가 실측 확인됐다 — 그래서 다시 "실제 다음 줄이 있는 경우만"
// 검사하도록 되돌린다. 열 하나 = 줄 하나인 경우의 "완전 침묵" 누락은 이 함수로는
// 못 잡는 채로 남는다(다른 방법 필요).
async function fillInterLineGaps(
  image: Buffer,
  ordered: LineCandidate[],
  typicalCellSize: number,
): Promise<LineCandidate[]> {
  const result = [...ordered]
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i]!
    const next = result[i + 1]!
    if (Math.abs(cur.x - next.x) > SAME_COLUMN_X_TOLERANCE) continue // 다른 열 — 비교 대상 아님
    const gapTop = cur.y + cur.height
    const gapHeight = next.y - gapTop
    if (gapHeight < typicalCellSize * MIN_SUSPICIOUS_GAP_RATIO) continue // 정상적인 줄 사이 여백 수준
    const gapRect: Rect = { x: cur.x, y: gapTop, width: cur.width, height: gapHeight }
    if (!hasInkInRegion(image, gapRect)) continue
    const rawWords = await recognizeWithPaddle(image, 'ja', padLine(gapRect))
    const units = rawWords?.filter((w) => w.bbox) ?? []
    // PaddleOCR 로 재인식한 텍스트는 NDLOCR 원본과 달리 normalizeDashes 를 아직 안 거쳤다
    // (실측 확인: PaddleOCR 은 다시(―) 를 "--" 가 아니라 반각 하이픈 "-" 한 글자로 인식
    // 하기도 해서, 정규화 없이 그대로 이어붙이면 팝업에 표기가 섞여 나온다).
    const recovered = normalizeDashes(units.map((u) => u.text).join(''))
    if (!recovered) continue
    result[i] = { ...cur, height: next.y - cur.y, text: cur.text + recovered }
  }
  return result
}

// 실측 확인(사용자 요청으로 시도 후 되돌림, 2차): PaddleOCR 검출 전용 API 로 NDLOCR
// bbox 바깥에 실제로 내용이 더 있는지 독자적으로 확인해보는 방법도 시도했다 — 그런데
// 페이지 전체 17줄을 실측해보니 PaddleOCR 가 독자적으로 잡은 경계가 NDLOCR 의 bbox
// 보다 "더 넓게" 나온 줄이 단 하나도 없었다(거의 다 음수 — PaddleOCR 가 오히려 더
// 안쪽으로 잡음). 즉 NDLOCR 의 bbox 는 글자를 몇 개 놓치든 상관없이 이미 페이지의
// 실제 시각적 경계를 정확히(또는 넉넉하게) 잡고 있고, 빠진 내용은 그 bbox **안쪽**에
// 있다는 뜻이다 — "경계 비교"라는 접근 자체가 이 종류의 누락(bbox 안에서 조용히
// 빠짐)에는 원리적으로 신호를 못 준다는 게 한 줄이 아니라 페이지 전체 데이터로
// 확인됐다. 그래서 되돌린다 — 이 방향(경계/테두리 비교)은 더 이상 시도할 가치가 없다.
//
// 실험용 비교 스위치(사용자 요청) — NDLOCR_DISABLE_BASELINE_SNAP=1 이면 열의 시작
// y좌표만 NDLOCR-Lite 가 검출한 원래 값 그대로 두고(공유 기준선에 스냅 안 함), 마커
// 판정·자리표자 삽입·문단 개행(\n)은 그대로 다 한다 — "박스 시작점만 통일 안 시켰을 때"
// 를 비교해볼 수 있는 임시 토글이라 정식 기능은 아니다 — 필요 없어지면 지워도 됨.
const DISABLE_BASELINE_SNAP = !!process.env.NDLOCR_DISABLE_BASELINE_SNAP

function alignColumnStarts(lines: LineCandidate[], typicalCellSize: number | null): AlignedLine[] {
  if (!typicalCellSize) {
    return lines.map((line) => ({ ...line, suspicious: hasGapMarker(line.text) }))
  }
  const baseline = computeBaseline(lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
  if (baseline === null) {
    return lines.map((line) => ({ ...line, suspicious: hasGapMarker(line.text) }))
  }

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
    // 1칸(문단 들여쓰기)과 2칸(미검출 구간) 사이 경계는 일반 반올림(1.5배 지점)보다
    // 1칸 쪽으로 더 관대하게(1.75배 지점) 잡는다 — 문단 들여쓰기가 실제 미검출 leading
    // 구간보다 훨씬 흔한데, typicalCellSize 측정 오차로 1칸짜리 들여쓰기가 어쩌다
    // 1.5~1.75배 근처로 재지면 반올림이 2칸(미검출)으로 잘못 넘어가 버렸다(실측 확인:
    // 자리표자가 하나 끼어들면서 실제 텍스트가 2칸 아래에서 시작하는 것처럼 보임).
    const rawOffset = line.y - baseline
    const rawRatio = rawOffset / typicalCellSize
    const LEADING_ONE_TWO_BOUNDARY = 1.75
    const nearestMultiple =
      rawRatio >= 1 && rawRatio < LEADING_ONE_TWO_BOUNDARY ? 1 : Math.round(rawRatio)
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
        if (!DISABLE_BASELINE_SNAP) newY = baseline + nearestMultiple * typicalCellSize
      } else {
        const count = nearestMultiple - DETECTION_PADDING_BIAS
        if (!DISABLE_BASELINE_SNAP) newY = baseline + DETECTION_PADDING_BIAS * typicalCellSize
        text = UNKNOWN_GAP_PLACEHOLDER.repeat(count) + text
      }
    }

    // 줄 끝 미검출 구간 — "여기까지 인식됐다면 몇 번째 칸에서 끝나야 하는지"
    // (expectedBottom)와 실제 검출된 아래쪽 경계(originalBottom)를 비교한다. 스페이스
    // 마커(hasGapMarker)가 없는 줄에 대한 보조 신호일 뿐이다 — 마커가 있으면 이미
    // 위치를 아니까 이 계산과 무관하게 무조건 의심 처리한다.
    //
    // 사용자 제안으로 "공유 칸 크기 × 글자수 vs 검출 높이"(정수 칸 배수, 2칸 이상만
    // 잡음) 대신 "이 줄 자신의 칸 크기(검출 높이 ÷ 글자수) vs 공유 칸 크기"의 비율로
    // 바꾼다 — 기존 방식은 2칸(typicalCellSize 의 정수 배) 이상 차이가 나야만 걸렸는데,
    // "……" 처럼 1칸 안팎의 작은 누락은 그 문턱을 못 넘어 못 잡혔다. 이 줄 자신의
    // 칸 크기가 공유 기준보다 뚜렷이 크면(=이 줄의 글자 수가 검출 높이에 비해 적으면)
    // 정수 배수가 아니어도 의심 처리한다 — 단, 비율 기준이라 긴 줄일수록 1칸 정도
    // 누락돼도 상대적으로 작은 비율이 된다(사용자 지적: 20칸짜리 줄에서 1칸 빠지면
    // 5%뿐이라 15% 기준을 못 넘음). 그렇다고 문턱을 너무 낮추면(실측 확인: 1%까지
    // 낮춰봤더니) 실제 누락이 없어도 순전히 측정 노이즈만으로 거의 모든 줄이 의심
    // 처리돼 PaddleOCR 이 사실상 전체 줄에 도는 수준까지 느려졌다(실측 26초+) — 게다가
    // "……" 처럼 애초에 이 줄 자신의 검출 bbox 조차 그 구간을 포함 안 하는 케이스는
    // 문턱을 얼마나 낮추든 못 잡는다(비교할 여분의 높이 자체가 없음, fillInterLineGaps
    // 로 별도 대응 시도 중). 그래서 처음 값(15%)으로 되돌린다 — spliceMissingContent/
    // spliceOneMarker 가 실제로 새 내용을 못 찾으면 원문을 그대로 두는 안전장치가
    // 있어서 오탐 자체의 피해는 제한적이지만, 문턱이 너무 낮으면 그 안전장치를 매번
    // 거치는 PaddleOCR 호출 자체가 병목이 된다.
    const PER_LINE_RATIO_THRESHOLD = 1.15
    const lineSlotCount = slotCount(text)
    const perLineCellSize = lineSlotCount > 0 ? (originalBottom - newY) / lineSlotCount : null
    const sizeMismatchSuspicious =
      perLineCellSize !== null && perLineCellSize / typicalCellSize >= PER_LINE_RATIO_THRESHOLD

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
 * ndlocrText 와 paddleText 의 공통 접두사·접미사를 찾고, 그 사이(서로 갈라지는
 * "middle" 구간)만 떼어 돌려준다 — spliceMissingContent 가 쓰는 diff 로직.
 * paddleText 가 비어있으면 null.
 */
function diffMiddle(
  ndlocrText: string,
  paddleText: string,
): { prefix: string; suffix: string; ndlocrMiddle: string; paddleMiddle: string } | null {
  if (!paddleText) return null
  const maxPrefix = Math.min(ndlocrText.length, paddleText.length)
  let prefixLen = 0
  while (prefixLen < maxPrefix && ndlocrText[prefixLen] === paddleText[prefixLen]) prefixLen++
  const ndlocrRest = ndlocrText.slice(prefixLen)
  const paddleRest = paddleText.slice(prefixLen)
  const maxSuffix = Math.min(ndlocrRest.length, paddleRest.length)
  let suffixLen = 0
  while (
    suffixLen < maxSuffix &&
    ndlocrRest[ndlocrRest.length - 1 - suffixLen] === paddleRest[paddleRest.length - 1 - suffixLen]
  ) {
    suffixLen++
  }
  return {
    prefix: ndlocrText.slice(0, prefixLen),
    suffix: suffixLen > 0 ? ndlocrText.slice(ndlocrText.length - suffixLen) : '',
    ndlocrMiddle: ndlocrRest.slice(0, ndlocrRest.length - suffixLen),
    paddleMiddle: paddleRest.slice(0, paddleRest.length - suffixLen),
  }
}

/**
 * ndlocrText 에 마커가 아예 없는데도(hasGapMarker 없이 sizeMismatchSuspicious 만으로
 * 의심된 줄) suspicious 로 표시된 경우 — 어디가 빠졌는지 위치 정보가 전혀 없으니,
 * paddleText 와 앞/뒤 공통 구간 밖(middle)만 paddleText 로 교체한다. paddleText 쪽이
 * 더 길지 않으면(=새로 찾은 내용이 없으면) null 을 반환해 원문을 그대로 둔다 — 괜히
 * 바꿔서 나빠지는 것보다 안전.
 */
function spliceMissingContent(ndlocrText: string, paddleText: string): string | null {
  const diff = diffMiddle(ndlocrText, paddleText)
  if (!diff) return null
  if (diff.paddleMiddle.length <= diff.ndlocrMiddle.length) return null
  return diff.prefix + diff.paddleMiddle + diff.suffix
}

/**
 * suspicious 로 표시된 줄만 PaddleOCR 로 다시 인식해서, 마커(스페이스, 앞쪽 미검출
 * 구간)들을 spliceOneMarker 로 하나씩 실제 내용으로 치환한다(왼쪽부터 순서대로 —
 * 인덱스가 앞쪽 치환으로 밀리지 않게). 마커가 하나도 없는데(sizeMismatchSuspicious
 * 만으로 의심된 "완전 침묵" 케이스) suspicious 면 spliceMissingContent 로 앞/뒤 일치
 * 구간 밖의 내용을 찾아 채운다. 어느 경우든 NDLOCR 원문의 나머지 부분(문장부호 등
 * 이미 정확했던 내용)은 전혀 건드리지 않는다.
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
      // normalizeDashes 주석 참고 — PaddleOCR 텍스트는 아직 정규화 전이라 여기서 거친다.
      const paddleText = normalizeDashes(units.map((u) => u.text).join(''))

      let text = line.text
      const hadMarker = hasGapMarker(text)
      // 왼쪽부터 순서대로 처리 — 매번 현재 text 기준으로 마커 위치를 다시 찾아야
      // 앞선 치환으로 문자 오프셋이 밀린 걸 반영할 수 있다.
      let markerIndex = text.indexOf(' ')
      while (markerIndex !== -1) {
        const spliced = paddleText ? spliceOneMarker(text, paddleText, markerIndex) : null
        text = spliced ?? text.slice(0, markerIndex) + text.slice(markerIndex + 1)
        markerIndex = text.indexOf(' ')
      }
      if (!hadMarker && paddleText) {
        text = spliceMissingContent(text, paddleText) ?? text
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
      text: fixKanjiLatinConfusion(normalizeDashes(l.text)),
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
  // 마지막 폴백도 원시 글자 수가 아니라 slotCount(칸 가중치 반영, "―"/"—" 는 2칸 등)를
  // 써야 다른 계산들과 일관된다 — 사용자 확인 요청으로 점검하다 발견. 줄 끝이
  // 문장부호면(TRAILING_PUNCTUATION_RE, cellSizesFromLongLines 와 동일 이유) 그
  // 글자의 칸 가중치를 완전히 빼지 않고 작은 값(TRAILING_PUNCTUATION_WEIGHT)으로
  // 낮춰서 보정한다 — 문장부호도 잉크가 아예 없는 게 아니라 어느 정도는 실제로 칸을
  // 차지하므로(사용자 지적, ocrPaddle.ts 의 groupCjkCharsGrid 와 동일 근거) 완전
  // 제외보다 실측에 더 가깝다(표본 자체는 버리지 않음 — 이 폴백은 표본이 원래 적을
  // 수 있는 최후 수단이라 최대한 살려서 쓴다).
  const TRAILING_PUNCTUATION_WEIGHT = 0.4
  const rawCellSizes = ordered
    .map((l) => {
      const weights = computeSlotWeights([...l.text])
      const lastWeight = weights.length > 0 ? weights[weights.length - 1]! : 0
      const total = weights.reduce((a, b) => a + b, 0)
      const n =
        lastWeight > TRAILING_PUNCTUATION_WEIGHT && TRAILING_PUNCTUATION_RE.test(l.text)
          ? total - lastWeight + TRAILING_PUNCTUATION_WEIGHT
          : total
      return n > 0 ? l.height / n : null
    })
    .filter((v): v is number => v !== null)
  const cellSizeFromIndent = estimateCellSizeFromIndent(ordered)
  const cellSizeFromLongLines = cellSizesFromLongLines.length > 0 ? median(cellSizesFromLongLines) : null
  const typicalCellSize =
    cellSizeFromIndent !== null && cellSizeFromLongLines !== null
      ? (cellSizeFromIndent + 2 * cellSizeFromLongLines) / 3
      : (cellSizeFromIndent ?? cellSizeFromLongLines ?? cellSizeFromWidth ?? (rawCellSizes.length > 0 ? median(rawCellSizes) : null))

  // 같은 열 안에서 인접한 두 줄 사이에 원본 픽셀로 확인된 잉크(fillInterLineGaps
  // 주석 참고)가 있으면 그 자리를 PaddleOCR 로 채워 앞 줄에 이어 붙인다 — 높이 비교로는
  // 신호가 안 남는 "완전 침묵" 누락(사용자 실측 확인: "……" 등)을 잡기 위한 마지막
  // 안전망이다. typicalCellSize 가 없으면 "비정상적으로 큰 간격"을 판단할 기준이
  // 없어서 건너뛴다.
  const gapFilled = typicalCellSize !== null ? await fillInterLineGaps(image, ordered, typicalCellSize) : ordered

  const aligned = alignColumnStarts(gapFilled, typicalCellSize)
  // 의심되는 줄만 PaddleOCR 로 대조 인식해서 마커를 실제 내용으로 치환한다
  // (resolveSuspiciousLines 주석 참고).
  const withPlaceholder = await resolveSuspiciousLines(image, aligned)
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const baseline = computeBaseline(ordered.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT))
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `ndlocrlines-${Date.now()}.json`),
      JSON.stringify(
        { typicalCellSize, baseline, ordered, gapFilled, aligned, withPlaceholder },
        null,
        2,
      ),
    )
  }

  // 단어 박스 자체는 "이 열의 실제 검출 높이 ÷ 이 열의 글자 수(칸 가중치 반영)"로
  // 열마다 따로 계산한다(사용자 요청) — groupCjkCharsGrid 에 typicalCellSize 로 null
  // 을 넘기면 이미 그 폴백(lineRect.height / totalWeight)을 쓴다. 공유 typicalCellSize
  // (들여쓰기/긴 줄 기반)는 alignColumnStarts 의 열 시작 위치 스냅·미검출 구간 판정
  // 에만 쓴다 — 그건 "여러 열이 공유하는 하나의 물리적 활자 그리드"라는 전제가 있어야
  // 성립하는 계산(다른 열들과 비교)이라 공유값이 꼭 필요하지만, 단어 박스 분할은 그
  // 열 하나 안에서만 상대 위치가 맞으면 되므로 그 열 자신의 실측값이 더 정확하다.
  // 단점(사용자 지적): 줄 끝이 문장부호(、。 등)면 잉크가 작아 검출 높이가 그만큼 다
  // 안 나와서 이 열의 계산값이 실제보다 살짝 작게 나올 수 있다 — 다만 그 열 자신의
  // 글자 수로 나눈 값이라 그 열 안에서는 자체 정합적이라(칸 크기가 줄어드는 만큼 전체
  // 글자가 고르게 살짝 압축될 뿐 겹치거나 밀리지 않음) 다른 열과 비교하는 계산(공유
  // typicalCellSize)만큼 위험하지 않다.
  // 단어가 아니라 줄 단위로 hover/선택하기로 한 결정(2026-07-28) — 같은 줄(열)에서
  // 나온 단어들을 나중에(wordMapping.ts: findLineWordsAtPoint) 한데 묶을 수 있도록,
  // 줄마다 새로 만든 식별자를 그 줄의 모든 단어에 붙인다.
  const grouped = await Promise.all(
    withPlaceholder.map(async (line) => {
      const lineId = Math.random().toString(36).slice(2)
      const words = await groupCjkCharsGrid(line, line.text, 'ja', true, null)
      return words.map((w) => ({ ...w, lineId }))
    }),
  )
  return grouped.flat()
}

// 담당 A — 가로쓰기 인식 실험(2026-07-29, 사용자 제안): "Yomitoku 검출 + NDLOCR-lite
// 인식" 조합. Yomitoku(ocrYomitoku.ts: detectLinesWithYomitoku)가 이미 찾아낸 줄
// bbox 를 그대로 받아서, 그 크롭들을 NDLOCR-lite 의 recognizer(검출기는 안 씀,
// python/ocr_ndlocr.py: recognize_crop 참고)로 읽는다. 원래 세로쓰기 고문서용으로
// 학습된 모델이라 현대 인쇄 가로쓰기 텍스트(특히 후리가나)에서 정확도가 어떨지는
// 미검증 — 이 실험의 목적 자체가 그걸 확인하는 것.
//
// 위쪽 여백을 최소화하는 이유: 가로쓰기 후리가나는 본문 줄 바로 위에 거의 맞닿아
// 검출되는데(간격 0~음수인 경우도 실측 확인), PaddleOCR 경로(ocrPaddle.ts: padLine,
// LINE_PADDING_Y=6)처럼 위아래를 동일하게 넉넉히 주면 그 후리가나 잉크가 다시
// 크롭에 섞여 들어갈 수 있다(가로쓰기 노이즈 재발의 유력 원인으로 추정 중) — 여기서는
// 처음부터 위쪽은 최소, 아래쪽만(글자 획/문장부호 잘림 방지 목적) 여유를 둔다.
//
// 담당 A — DPI 배율 대응(2026-07-29, 사용자 보고: "노트북 화면과 모니터 화면에서 결과가
// 다름 — 고배율 화면에서 줄이 통째로 누락되거나 순서가 꼬임"). 캡처는 물리 픽셀 기준이라
// 디스플레이 배율이 높을수록(예: 150%) 같은 글자도 물리 픽셀상 더 크게 찍히는데, 여백을
// 고정 픽셀(1px/4px)로 두면 배율이 높을수록 실제 글자 크기 대비 여백이 상대적으로 좁아져
// 획/문장부호 하단이 잘리기 쉬워진다(잘리면 NDLOCR-lite가 빈 문자열을 반환해 그 줄이
// 통째로 사라진 것처럼 보임 — 실사용 중 확인된 유력 원인). 절대 픽셀 대신 그 줄 자신의
// 높이에 비례한 값을 쓰면 배율이 달라져도 "글자 크기 대비 여백 비율"이 항상 같게
// 유지된다. 비율은 기존에 검증됐던 절대값(1px/4px, 실측 당시 줄 높이 대략 22~25px대
// 기준)과 비슷한 크기가 나오도록 역산한 값이다.
const LINE_MARGIN_TOP_RATIO = 0.04
const LINE_MARGIN_BOTTOM_RATIO = 0.16

async function writeLineCrop(image: Buffer, line: Rect): Promise<string> {
  const marginTop = Math.max(1, Math.round(line.height * LINE_MARGIN_TOP_RATIO))
  const marginBottom = Math.max(2, Math.round(line.height * LINE_MARGIN_BOTTOM_RATIO))
  const padded: Rect = {
    x: line.x,
    y: line.y - marginTop,
    width: line.width,
    height: line.height + marginTop + marginBottom,
  }
  const { tmpPath } = await writeCrop(image, padded, 0)
  return tmpPath
}

/**
 * Yomitoku 로 검출한 가로쓰기 줄들을 NDLOCR-lite 인식기로 읽는다 — 검출은 이미
 * 끝난 상태로 받으므로(detector 미사용) 여기서는 후리가나 필터링(검출 결과 재사용
 * 시에도 안전하도록 방어적으로 한 번 더 적용) → 줄마다 크롭+인식 → 격자 기반 단어
 * 분할(groupCjkCharsGrid, PaddleOCR/Yomitoku 경로와 동일한 방식)만 한다. 줄 하나라도
 * 실패하면 전체를 null 로 반환해 호출부(ocr.ts)가 PaddleOCR 인식으로 폴백하게 한다.
 */
export async function recognizeLinesWithNdlocr(image: Buffer, lines: Rect[]): Promise<Word[] | null> {
  const bodyLines = excludeFuriganaHorizontal(lines)
  if (process.env.DEBUG_OCR_DUMP && bodyLines.length !== lines.length) {
    console.log(
      `[ocrNdlocr] excludeFuriganaHorizontal: ${lines.length}줄 → ${bodyLines.length}줄 (${lines.length - bodyLines.length}줄 후리가나로 제외됨)`,
    )
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const kept = new Set(bodyLines)
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `furigana-filter-${Date.now()}.json`),
      JSON.stringify(
        lines.map((l) => ({ bbox: l, kept: kept.has(l) })),
        null,
        2,
      ),
    )
  }
  if (bodyLines.length === 0) return []
  // 담당 A — 순수 y정렬 제거(2026-07-30, 사용자 제보 — "가로쓰기 2단인데 순서가 여전히
  // 안 고쳐짐"). 유일한 호출부(ocr.ts)가 이미 `clusterHorizontalLinesIntoColumns`로
  // 열까지 반영해 정확한 순서로 정렬해 넘기는데, 여기서 다시 y로만 재정렬해버려서 그
  // 결과를 그대로 덮어쓰고 있었다 — 다단 영역에서는 y만으로 정렬하면 열 구분이 사라져
  // 정확히 그 증상(y 낮은 순서대로 열 무관)이 재발한다. 입력 순서를 그대로 신뢰한다.
  const ordered = bodyLines
  try {
    const texts = await Promise.all(
      ordered.map(async (line) => {
        const tmpPath = await writeLineCrop(image, line)
        try {
          const { text } = await server.request<{ image_path: string; mode: 'recognize_crop' }, { text: string }>({
            image_path: tmpPath,
            mode: 'recognize_crop',
          })
          return text
        } finally {
          void unlink(tmpPath).catch(() => {})
        }
      }),
    )
    // 담당 A — 줄별 인식 결과 진단용(2026-07-30, 사용자 제보 — "순서는 맞는데 중간 줄
    // 2개가 아예 인식이 안 됨"). 어느 줄이 빈 텍스트로 돌아왔는지(=NDLOCR 인식 실패로
    // groupCjkCharsGrid 가 바로 빈 배열을 반환해 그 줄이 통째로 사라짐) 직접 확인한다.
    if (process.env.DEBUG_OCR_DUMP) {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      writeFileSync(
        join(process.env.DEBUG_OCR_DUMP, `ndlocr-horiz-lines-${Date.now()}.json`),
        JSON.stringify(
          ordered.map((line, i) => ({ bbox: line, text: texts[i], empty: !texts[i]?.trim() })),
          null,
          2,
        ),
      )
    }
    // 담당 A — 가로쓰기 단어 단위 hover 를 시도했었는데(2026-07-29), 잉크 위치 기반 박스
    // 계산이 아직 튜닝 중이라 우선 세로쓰기와 동일하게 줄 단위로 되돌린다(사용자 요청,
    // 2026-07-29) — 단어별 위치 계산(groupCjkCharsGrid, 잉크 스냅 포함) 자체는 그대로
    // 두고 결과만 줄 하나로 묶는다. 나중에 잉크 튜닝이 끝나면 이 lineId 부여만 다시
    // 빼면 단어 단위로 복귀 가능(ocrPaddle.ts: recognizeOrderedLines 의 같은 처리 참고).
    const grouped = await Promise.all(
      ordered.map(async (line, i) => {
        const words = await groupCjkCharsGrid(line, texts[i]!, 'ja', false, null, image)
        const lineId = Math.random().toString(36).slice(2)
        return words.map((w) => ({ ...w, lineId }))
      }),
    )
    return grouped.flat()
  } catch (err) {
    console.error('[ocrNdlocr] 가로쓰기 인식 실패 — PaddleOCR 로 폴백:', err)
    return null
  }
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
