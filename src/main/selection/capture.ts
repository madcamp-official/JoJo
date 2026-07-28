import { BrowserWindow, desktopCapturer, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CaptureSource } from '@shared/types'

const execFileAsync = promisify(execFile)
// win32Capture 는 koffi 로 user32.dll 등을 로드하므로 최상단 static import 로 두면
// Windows 가 아닌 OS(맥·리눅스)에서도 import 시점에 DLL 로드가 실행돼 크래시한다.
// → Windows 경로에서만 동적 import 로 지연 로드한다(koffi 는 optionalDependencies).

// 담당 A — 창 선택 & 포커스 창 캡처 (PLAN.md §4.1)
// Zoom 화면공유처럼 창 목록을 제공하고, 선택된 창의 화면을 캡처한다.
//
// Windows 에서는 desktopCapturer 대신 win32Capture(EnumWindows + PrintWindow)를
// 사용한다 — desktopCapturer 는 다른 창에 완전히 가려진 창을 누락시키거나 빈
// 썸네일을 주는 한계가 있다(PLAN.md 체크리스트: "창 선택 UI" 실사용 중 발견).

// 썸네일 그리드 타일과 동일한 종횡비로 고정 크롭한다(모든 창이 같은 픽셀 크기로 나가도록).
const THUMBNAIL_SIZE = { width: 320, height: 205 }

/** "앱 이름 - 창 제목" 형태로 합친다 — 앱 이름을 못 구했거나 제목과 중복되면 제목만 반환. */
function withOwnerName(owner: string | null | undefined, title: string): string {
  if (!owner || owner === title) return title
  return `${owner} - ${title}`
}

/** exe 파일명(확장자 제외, 예: "chrome")을 "Chrome" 처럼 대략적인 표시용 이름으로 만든다. */
function friendlyExeName(exeBase: string): string {
  return exeBase.charAt(0).toUpperCase() + exeBase.slice(1)
}

/** cover 방식으로 리사이즈 후 중앙 크롭 — 원본 창 크기/비율과 무관하게 항상 같은 크기를 반환. */
function toUniformThumbnail(image: Electron.NativeImage): Electron.NativeImage {
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return image

  const scale = Math.max(THUMBNAIL_SIZE.width / size.width, THUMBNAIL_SIZE.height / size.height)
  const scaled = image.resize({
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  })
  const scaledSize = scaled.getSize()
  const x = Math.max(0, Math.floor((scaledSize.width - THUMBNAIL_SIZE.width) / 2))
  const y = Math.max(0, Math.floor((scaledSize.height - THUMBNAIL_SIZE.height) / 2))

  return scaled.crop({
    x,
    y,
    width: Math.min(THUMBNAIL_SIZE.width, scaledSize.width),
    height: Math.min(THUMBNAIL_SIZE.height, scaledSize.height),
  })
}

async function listWindowsWin32(): Promise<CaptureSource[]> {
  // Windows 에서만 실행되는 경로. koffi 의존 모듈을 여기서 지연 로드한다.
  const { captureMinimizedWin32Window, captureWin32Window, listWin32Windows } = await import(
    './win32Capture'
  )

  const ownHwnds = new Set(
    BrowserWindow.getAllWindows().map((w) => w.getNativeWindowHandle().readBigUInt64LE(0)),
  )

  const targets = listWin32Windows().filter((win) => !ownHwnds.has(win.hwnd))

  // 순차적으로 캡처한다 — 창 사이에 짧은 텀을 두어 GDI/DWM 리소스 경합을 줄인다.
  const sources: CaptureSource[] = []
  for (let i = 0; i < targets.length; i++) {
    const win = targets[i]
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 150))
    const shot = win.minimized
      ? await captureMinimizedWin32Window(win.hwnd)
      : await captureWin32Window(win.hwnd, win.width, win.height)
    if (!shot) continue

    const image = nativeImage.createFromBitmap(shot.buffer, { width: shot.width, height: shot.height })
    const thumbnail = toUniformThumbnail(image).toDataURL()
    const owner = win.ownerName ? friendlyExeName(win.ownerName) : null
    sources.push({ id: String(win.hwnd), name: withOwnerName(owner, win.title), thumbnail })
  }
  return sources
}

async function listWindowsElectron(): Promise<CaptureSource[]> {
  const ownSourceIds = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: THUMBNAIL_SIZE.width * 2, height: THUMBNAIL_SIZE.height * 2 },
  })

  // macOS: desktopCapturer 는 owner 앱 이름을 안 주므로 CGWindowList 로 windowId → 앱 이름
  // 맵을 한 번에 조회해 "앱 이름 - 창 제목"으로 합쳐 보여준다.
  let ownerNames: Map<number, string> | null = null
  if (process.platform === 'darwin') {
    const { listMacWindowOwnerNames } = await import('./macWindow')
    ownerNames = listMacWindowOwnerNames()
  }

  return sources
    .filter((s) => !ownSourceIds.has(s.id))
    .map((s) => {
      const wid = ownerNames ? Number(/^window:(\d+)/.exec(s.id)?.[1]) : NaN
      const owner = ownerNames && Number.isFinite(wid) ? ownerNames.get(wid) : undefined
      return {
        id: s.id,
        name: withOwnerName(owner, s.name),
        thumbnail: toUniformThumbnail(s.thumbnail).toDataURL(),
      }
    })
}

export async function listWindows(): Promise<CaptureSource[]> {
  if (process.platform === 'win32') {
    try {
      return await listWindowsWin32()
    } catch (err) {
      console.error('[capture] win32 window enumeration failed, falling back:', err)
    }
  }
  return listWindowsElectron()
}

let selectedWindowId: string | null = null
let selectedWindowName: string | null = null

export function getSelectedWindowId(): string | null {
  return selectedWindowId
}

export function setSelectedWindowId(id: string | null): void {
  selectedWindowId = id
}

/** "오너앱 - 창 제목" 형식(withOwnerName)의 선택된 창 이름 — 브라우저 여부 판정 등에 씀. */
export function getSelectedWindowName(): string | null {
  return selectedWindowName
}

export function setSelectedWindowName(name: string | null): void {
  selectedWindowName = name
}

// 선택된 창을 프레임 캡처하여 OCR 입력용 이미지 버퍼(PNG) 반환.
export async function captureFocusedWindow(): Promise<Buffer> {
  if (!selectedWindowId) throw new Error('captureFocusedWindow: 선택된 창 없음')
  if (process.platform === 'darwin') return captureMacWindow(selectedWindowId)
  if (process.platform !== 'win32') {
    throw new Error('captureFocusedWindow: 지원하지 않는 플랫폼')
  }

  const hwnd = BigInt(selectedWindowId)
  const { captureMinimizedWin32Window, captureWin32Window, getWindowScreenRect } = await import(
    './win32Capture'
  )

  const rect = getWindowScreenRect(hwnd)
  const shot = rect
    ? await captureWin32Window(hwnd, rect.width, rect.height)
    : await captureMinimizedWin32Window(hwnd)
  if (!shot) throw new Error('captureFocusedWindow: 캡처 실패')

  return nativeImage
    .createFromBitmap(shot.buffer, { width: shot.width, height: shot.height })
    .toPNG()
}

/**
 * macOS 창 캡처 — 내장 `screencapture -l<windowID>` 로 대상 창을 네이티브 해상도 PNG 로 캡처한다
 * (Windows 의 PrintWindow 와 동급 품질). desktopCapturer 썸네일보다 선명해 OCR 정확도가 높다.
 * 화면 기록 권한이 필요하다(창 목록 표시에서 이미 요구됨). Retina 에선 물리 픽셀(2x)로 캡처되며,
 * OCR bbox 의 배율 보정은 alignWordsToOverlay(mac 분기)에서 처리한다.
 */
async function captureMacWindow(sourceId: string): Promise<Buffer> {
  const m = /^window:(\d+)/.exec(sourceId)
  if (!m) throw new Error(`captureFocusedWindow: mac window id 파싱 실패 (${sourceId})`)
  return captureMacWindowById(Number(m[1]))
}

async function captureMacWindowById(windowId: number): Promise<Buffer> {
  const out = join(tmpdir(), `nuance-capture-${process.pid}-${Date.now()}-${windowId}.png`)
  // -x: 소리 없음, -o: 창 그림자 제외(창 프레임만), -t png: PNG, -l<id>: 해당 CGWindowID 창만
  await execFileAsync('screencapture', ['-x', '-o', '-t', 'png', `-l${windowId}`, out])
  try {
    return await readFile(out)
  } finally {
    void unlink(out).catch(() => {})
  }
}
