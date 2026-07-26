import { nativeImage } from 'electron'
import type { Rect } from '@shared/types'
import { getPhysicalToDipScale } from '../windows'
import { captureFocusedWindow, getSelectedWindowId } from './capture'
import { detectLayoutBlocks, padRect } from './layoutDetect'

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

export function getRegion(): Rect | null {
  return region
}

export function setRegion(rect: Rect): void {
  region = rect
}

export function clearRegion(): void {
  region = null
}

/**
 * 오버레이(DIP, 오버레이 로컬 좌표)에서 드래그로 그린 영역을 캡처 좌표계(물리 픽셀)로
 * 변환해 저장한다 — extractionCache.ts 의 bbox 정렬(alignWordsToOverlay)과 정반대 방향의
 * 변환. Windows 전용(비-win32 에선 변환 없이 그대로 저장 — 실제로 이 흐름 자체가 아직
 * win32 에서만 시작됨, macOS 미구현).
 */
export async function submitRegionFromOverlay(dipRect: Rect): Promise<void> {
  if (process.platform !== 'win32') {
    setRegion(dipRect)
    return
  }
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
}

// 본문으로 볼 레이아웃 라벨 — DocLayout-YOLO(DocStructBench 체크포인트)의 10개 클래스 중
// 제목/일반 텍스트만 포함한다. 메뉴바·사이드바·워터마크 등은 "abandon"으로, 그림/표/수식은
// 별도 라벨로 나오므로 자연히 제외된다(python/layout_detect.py 참고).
const BODY_LABELS = new Set(['title', 'plain text'])

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

  const blocks = await detectLayoutBlocks(image)
  if (!blocks) return null
  const body = blocks.filter((b) => BODY_LABELS.has(b.label))
  if (body.length === 0) return null

  const x0 = Math.min(...body.map((b) => b.bbox.x))
  const y0 = Math.min(...body.map((b) => b.bbox.y))
  const x1 = Math.max(...body.map((b) => b.bbox.x + b.bbox.width))
  const y1 = Math.max(...body.map((b) => b.bbox.y + b.bbox.height))
  const union: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }

  const { width: imageWidth, height: imageHeight } = nativeImage.createFromBuffer(image).getSize()
  return padRect(union, AUTO_REGION_PADDING_X, AUTO_REGION_PADDING_Y, {
    x: 0,
    y: 0,
    width: imageWidth,
    height: imageHeight,
  })
}
