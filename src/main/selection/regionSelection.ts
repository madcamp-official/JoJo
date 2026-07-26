import type { Rect } from '@shared/types'
import { getPhysicalToDipScale } from '../windows'
import { getSelectedWindowId } from './capture'

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
