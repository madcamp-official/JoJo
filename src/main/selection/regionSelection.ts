import { nativeImage } from 'electron'
import type { Rect } from '@shared/types'
import { getPhysicalToDipScale } from '../windows'
import { captureFocusedWindow, getSelectedWindowId } from './capture'
import { detectLayoutBlocks, type LayoutBlock, padRect } from './layoutDetect'
import { detectLinesWithPaddle } from './ocrPaddle'

// 본문 블록들을 감싼 사각형에 더하는 여유(px) — 딱 맞게 감싸면 맨 끝 줄/글자가 이
// 사각형 경계에 걸려서 이후 Tesseract 인식(rectangle 크롭) 때 잘릴 수 있다
// (layoutDetect.ts: padRect 주석 참고, 실사용 중 "마지막 단어 클릭 안 됨" 으로 확인됨).
// 가로/세로를 다르게 주는 이유도 padRect 주석 참고(가로는 커야 줄 끝 단어가 안 깨지고,
// 세로를 그만큼 키우면 메뉴바/툴바가 딸려 들어옴).
const AUTO_REGION_PADDING_X = 50
const AUTO_REGION_PADDING_Y = 12

// 담당 A — 선택 모드에서 사용자가 지정한 OCR 대상 영역
// 창 크기가 바뀌면(windows.ts: onWindowResized) 무효화된다 — 리사이즈되면 이전에
// 지정한 영역의 물리 좌표가 더 이상 유효하지 않기 때문(shortcut.ts 가 감지·처리).
// 좌표는 캡처 좌표계(물리 픽셀, GetWindowRect 원점) 기준 — win32Capture.ts 참고.

let region: Rect | null = null

/**
 * 담당 A — 자동 영역 감지(autoDetectRegion) 때 이미 계산해둔 DocLayout/PaddleOCR 결과를
 * 캐시해서 OCR 단계(ocr.ts: runOcr)가 재사용하게 한다. `region`과 생명주기를 같이한다
 * (재계산/무효화 시점이 같아서 — 리사이즈로 region 이 무효화되면 이 캐시도 더 이상
 * 유효하지 않고, region 이 재사용되는 동안은 이 캐시도 그대로 유효함).
 *
 * 이걸 두는 이유: DocLayout 검출(및 그게 실패했을 때의 PaddleOCR 텍스트 줄 검출)은
 * "본문 영역을 찾을 때"(모드 진입 시)와 "실제로 인식할 때"(클릭 시) 둘 다 필요한데,
 * 캐시가 없으면 사실상 같은 캡처 내용에 대해 이 무거운 Python 호출을 두 번씩(경우에
 * 따라 세 번) 반복하게 된다(실측: 세로쓰기 페이지에서 페이지 전체를 훑는 PaddleOCR
 * 호출이 회당 30~40초 — 실사용 중 "선택 모드 진입부터 텍스트 추출까지 125초"로 확인,
 * 그중 상당 부분이 이 중복 호출들이었음).
 */
export interface CachedDetection {
  blocks: LayoutBlock[]
  vertical: boolean
  /** DocLayout 이 블록을 하나도 못 찾아서(blocks=0) PaddleOCR 로 대신 찾은 줄 — 그 경우가
   * 아니면 null(재사용할 게 없다는 뜻, ocr.ts 가 필요하면 새로 찾는다). */
  fallbackLines: Rect[] | null
}

let cachedDetection: CachedDetection | null = null

export function getRegion(): Rect | null {
  return region
}

export function getCachedDetection(): CachedDetection | null {
  return cachedDetection
}

/**
 * 영역(region)은 그대로 두고 캐시만 비운다 — changeWatcher.ts 가 영역 "안" 내용이
 * 바뀐 걸 감지했을 때 쓴다(스크롤 등, 영역 자체의 위치/크기는 안 바뀜). 이때 영역까지
 * 다시 잡을 필요는 없지만, 캐시된 블록/줄 위치는 예전 화면 기준이라 그대로 재사용하면
 * 바뀐 화면에서 엉뚱한 좌표를 인식하게 된다 — 반드시 비워서 ocr.ts 가 새로 검출하게
 * 해야 한다.
 */
export function invalidateCachedDetection(): void {
  cachedDetection = null
}

export function setRegion(rect: Rect): void {
  region = rect
}

export function clearRegion(): void {
  region = null
  cachedDetection = null
}

/**
 * 오버레이(DIP, 오버레이 로컬 좌표)에서 드래그로 그린 영역을 캡처 좌표계(물리 픽셀)로
 * 변환해 저장한다 — extractionCache.ts 의 bbox 정렬(alignWordsToOverlay)과 정반대 방향의
 * 변환.
 */
export async function submitRegionFromOverlay(dipRect: Rect): Promise<void> {
  // 수동 드래그로 지정한 영역이라 DocLayout 을 아예 안 거쳤다 — 혹시 이전 자동 감지
  // 시도에서 남아있는 캐시가 있으면(예: 실패해서 드래그로 폴백한 경우) 지금 지정하는
  // 이 영역과 무관하니 반드시 비운다(안 그러면 ocr.ts 가 엉뚱한 캐시를 재사용함).
  cachedDetection = null
  if (process.platform === 'win32') {
    const id = getSelectedWindowId()
    if (!id) return

    const hwnd = BigInt(id)
    const { getCaptureOriginOffset, getWindowScreenRect } = await import('./win32Capture')
    const rect = getWindowScreenRect(hwnd)
    if (!rect) return

    const offset = getCaptureOriginOffset(hwnd)
    const scale = getPhysicalToDipScale(rect)
    setRegion({
      x: dipRect.x * scale + offset.x,
      y: dipRect.y * scale + offset.y,
      width: dipRect.width * scale,
      height: dipRect.height * scale,
    })
    return
  }

  if (process.platform === 'darwin') {
    const id = getSelectedWindowId()
    const wid = Number(/^window:(\d+)/.exec(id ?? '')?.[1])
    if (!Number.isFinite(wid)) {
      setRegion(dipRect)
      return
    }
    const { getMacWindowBounds } = await import('./macWindow')
    const bounds = getMacWindowBounds(wid)
    if (!bounds) {
      setRegion(dipRect)
      return
    }
    const { screen } = await import('electron')
    // alignWordsToOverlay(extractionCache.ts)와 반대 방향: DIP → 물리 픽셀이므로 scale을
    // 곱한다. macOS는 캡처(screencapture)와 오버레이 원점이 창 좌상단으로 동일해 offset은
    // 필요 없다(win32와 달리 GetWindowRect/DWM 프레임 어긋남이 없음).
    const scale =
      screen.getDisplayMatching({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      }).scaleFactor || 1
    setRegion({
      x: dipRect.x * scale,
      y: dipRect.y * scale,
      width: dipRect.width * scale,
      height: dipRect.height * scale,
    })
    return
  }

  setRegion(dipRect)
}

// 본문으로 볼 레이아웃 라벨 — PP-DocLayout_plus-L(PaddleX, python/layout_detect.py 의
// 기본 백엔드)의 라벨 체계 기준. 세로쓰기 일본어 문서에서 DocLayout-YOLO/DocStructBench가
// 블록을 아예 못 찾는 문제(실사용 확인: blocks=0)가 있어 이 모델로 교체했다(실측: 신뢰도
// 0.78로 세로쓰기 텍스트 영역을 정확히 찾아냄, 추론도 더 빠름 — python/layout_detect.py
// 상단 주석 참고). doc_title/paragraph_title/text 가 본문에 해당한다.
//
// python/layout_detect.py 의 MODEL_BACKEND 를 "yolo"로 되돌리면 라벨 체계가 완전히
// 달라지므로(title/plain text 2종) 이 두 상수도 그에 맞게 같이 바꿔야 한다 — DocStructBench
// 로 되돌릴 땐 BODY_LABELS = new Set(['title', 'plain text']), NON_TEXT_LABELS = new Set(
// ['figure','figure_caption','table','table_caption','table_footnote','isolate_formula',
// 'formula_caption']) 였다.
const BODY_LABELS = new Set(['doc_title', 'paragraph_title', 'text'])

// 확실히 텍스트가 아닌 라벨 — 본문 라벨이 하나도 없을 때의 폴백(아래 참고)에서도 이것들만은
// 계속 제외한다. PP-DocLayout_plus-L 의 20개 라벨 중 그림/표/수식/도장처럼 명백히 시각
// 요소인 것만 고른다 — header/footer/footnote/aside_text/number/reference 등은 본문은
// 아니지만 텍스트이긴 해서(완전히 틀린 라벨 판정이었을 가능성) 이 폴백에서까진 제외하지
// 않는다(기존 YOLO 폴백 설계와 같은 방침).
const NON_TEXT_LABELS = new Set([
  'image',
  'figure_title',
  'formula',
  'formula_number',
  'table',
  'chart',
  'seal',
  'algorithm',
])

/**
 * 담당 A — 실험용 브랜치(experiment/doclayout-yolo). 드래그 없이 DocLayout-YOLO 로 창
 * 전체를 훑어 본문(제목+일반 텍스트) 블록을 찾고, 그 블록들을 모두 감싸는 사각형을
 * 영역으로 쓴다. 결과 좌표는 캡처 이미지(물리 픽셀) 기준이라 — `region`(캡처 좌표계)과
 * 이미 같은 공간이라 별도 변환이 필요 없다(submitRegionFromOverlay 와 달리 오버레이 DIP
 * 좌표를 거치지 않음). 실패하거나(Python 환경 없음 등) 본문 블록이 하나도 없으면 null 을
 * 반환해서, 호출부(shortcut.ts)가 기존 수동 드래그 선택으로 폴백하게 한다.
 */
export async function autoDetectRegion(): Promise<Rect | null> {
  if (!getSelectedWindowId()) return null
  let image: Buffer
  try {
    image = await captureFocusedWindow()
  } catch (err) {
    console.error('[regionSelection] 본문 자동 감지용 캡처 실패:', err)
    return null
  }

  const detected = await detectLayoutBlocks(image)
  if (!detected) {
    cachedDetection = null
    return null
  }
  // 일단 캐시부터 채워둔다(폴백 2단계까지 가면 fallbackLines 로 갱신) — 이 함수가 어느
  // 경로로 끝나든(성공/실패) ocr.ts 가 재사용할 블록/세로쓰기 판정은 이미 다 나와있다.
  cachedDetection = { blocks: detected.blocks, vertical: detected.vertical, fallbackLines: null }
  let body = detected.blocks.filter((b) => BODY_LABELS.has(b.label))
  // 검증용 로그 — 본문 자동 감지가 실패했을 때 "블록을 아예 못 찾음"인지 "블록은
  // 찾았는데 본문 라벨이 아니라서 걸러짐"인지 원인을 바로 구분할 수 있게 라벨/신뢰도를
  // 전부 남긴다(실사용 중 "세로쓰기 PDF에서 자동 감지 실패"로 확인 — 이 로그로 원인 추적).
  console.log(
    '[regionSelection] 검출된 블록:',
    detected.blocks.map((b) => `${b.label}(${b.confidence.toFixed(2)})`).join(', ') || '(없음)',
    `→ 본문으로 인정된 것: ${body.length}개`,
  )
  if (body.length === 0) {
    // title/plain text 로 잡힌 게 하나도 없으면 — 실사용 중 세로쓰기 일본어 PDF에서
    // 확인된 것처럼, DocStructBench 가 학습 안 해본 레이아웃(세로쓰기 등)을 "abandon"
    // 으로 잘못 분류하는 경우가 있다. 완전히 포기하고 수동 드래그로 넘기기 전에,
    // 그림/표/수식처럼 "확실히 텍스트가 아닌" 것만 뺀 나머지를 본문 후보로 한 번 더
    // 시도한다 — 정상 문서에서 메뉴바(abandon)만 있고 본문이 캡처 밖이라 진짜로 본문이
    // 없는 경우엔 그 abandon 블록이 메뉴바 위치라서 영역이 이상해질 수 있지만, 그런
    // 드문 오탐보다 "세로쓰기 콘텐츠에서 항상 드래그로 폴백"되는 쪽이 더 아쉬워서
    // 이 폴백을 우선한다.
    const fallback = detected.blocks.filter((b) => !NON_TEXT_LABELS.has(b.label))
    console.log(`[regionSelection] 폴백 1단계 — 비텍스트 라벨 제외한 나머지: ${fallback.length}개`)
    body = fallback
  }

  const { width: imageWidth, height: imageHeight } = nativeImage.createFromBuffer(image).getSize()
  const fullImage: Rect = { x: 0, y: 0, width: imageWidth, height: imageHeight }

  if (body.length === 0) {
    // 2단계 폴백: DocLayout 이 아예 블록을 하나도 못 찾은 경우(실사용 중 세로쓰기
    // 일본어 PDF에서 blocks=0 으로 확인) — DocLayout 은 "이게 제목/본문/표 중 뭔지"
    // 판단하는 레이아웃 분류 모델이라 학습 안 해본 배치엔 아예 실패할 수 있다. 대신
    // PaddleOCR 의 텍스트 검출(det) 모델은 문서 구조를 몰라도 되고 "여기 글자 모양의
    // 잉크가 있다"만 보는 훨씬 범용적인 모델이라(스크립트에 덜 민감) 이걸로 창 전체를
    // 훑어 텍스트 줄 위치를 직접 찾는다(ocr.ts 가 세로쓰기 열을 manga-ocr 로 넘길 때
    // 줄 위치를 찾는 데 쓰는 것과 같은 함수). 언어를 아직 모르는 시점이라(본문 영역이
    // 정해진 뒤에 언어를 감지하는 순서라서) 'en' det 모델로 시도한다 — PaddleOCR 검출
    // 모델은 recognition 모델과 달리 스크립트 특정적이지 않아 이 정도로도 충분하다.
    const lines = await detectLinesWithPaddle(image, fullImage)
    console.log(`[regionSelection] 폴백 2단계 — PaddleOCR 텍스트 줄 검출: ${lines?.length ?? 'null(실패)'}개`)
    if (lines && lines.length > 0) {
      // ocr.ts 가 세로/가로 판별·인식에 그대로 재사용하도록 캐시를 갱신한다 — 여기서
      // 찾은 줄은 region(아래 padRect 결과) 기준과 사실상 같은 크롭이라(둘 다 이 줄들을
      // 감싼 뒤 같은 여백을 더한 값) 재검출 없이 안전하게 재사용할 수 있다.
      cachedDetection = { blocks: detected.blocks, vertical: detected.vertical, fallbackLines: lines }
      const x0 = Math.min(...lines.map((l) => l.x))
      const y0 = Math.min(...lines.map((l) => l.y))
      const x1 = Math.max(...lines.map((l) => l.x + l.width))
      const y1 = Math.max(...lines.map((l) => l.y + l.height))
      return padRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, AUTO_REGION_PADDING_X, AUTO_REGION_PADDING_Y, fullImage)
    }
    cachedDetection = null // 영역을 못 찾아 드래그로 폴백하니, 이 시도의 캐시는 의미 없음.
    return null
  }

  const x0 = Math.min(...body.map((b) => b.bbox.x))
  const y0 = Math.min(...body.map((b) => b.bbox.y))
  const x1 = Math.max(...body.map((b) => b.bbox.x + b.bbox.width))
  const y1 = Math.max(...body.map((b) => b.bbox.y + b.bbox.height))
  const union: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }

  return padRect(union, AUTO_REGION_PADDING_X, AUTO_REGION_PADDING_Y, fullImage)
}
