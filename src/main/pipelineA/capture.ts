import { desktopCapturer } from 'electron'

// 담당 A — 창 선택 & 포커스 창 캡처 (PLAN.md §4.1)
// Zoom 화면공유처럼 창 목록을 제공하고, 선택된 창의 화면을 캡처한다.

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string // dataURL
}

export async function listWindows(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({ types: ['window'] })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
}

// TODO(담당 A): 선택된 창을 프레임 캡처하여 OCR 입력용 이미지 버퍼 반환.
export async function captureFocusedWindow(): Promise<Buffer> {
  throw new Error('not implemented: captureFocusedWindow')
}
