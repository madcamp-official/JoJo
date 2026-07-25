// 담당 A — Windows 전용 창 열거/캡처.
//
// Electron 의 desktopCapturer.getSources() 는 Windows 에서 다른 창에 완전히
// 가려진(occluded) 창을 목록에서 누락시키거나 빈 썸네일을 반환하는 한계가 있다
// (Chrome 등이 가려지면 DirectComposition 렌더링을 중단하기 때문). user32/gdi32 를
// 직접 호출해 이를 우회한다:
//   - EnumWindows 로 창을 직접 열거 (가려짐/최소화와 무관하게 항상 보임)
//   - PrintWindow(..., PW_RENDERFULLCONTENT) 로 가려진 창도 강제 렌더링해 캡처
//   - 최소화된 창은 앱이 렌더링을 멈춰서 PrintWindow 로는 빈 화면만 나온다.
//     대신 DWM Thumbnail API(작업표시줄 미리보기·Alt+Tab 이 쓰는 것과 동일)로
//     DWM 이 캐싱해둔 마지막 프레임을 가져온다 — Zoom 화면공유 목록과 같은 방식.
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const kernel32 = koffi.load('kernel32.dll')

koffi.proto('int __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)')

const EnumWindows = user32.func(
  'int __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)',
)
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)')
const IsIconic = user32.func('int __stdcall IsIconic(void *hwnd)')
const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32_t uCmd)')
const GetWindowLongPtrW = user32.func(
  'intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int32_t nIndex)',
)
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)')
const GetWindowTextW = user32.func(
  'int __stdcall GetWindowTextW(void *hwnd, _Out_ str16 lpString, int nMaxCount)',
)
const GetClassNameW = user32.func(
  'int __stdcall GetClassNameW(void *hwnd, _Out_ str16 lpClassName, int nMaxCount)',
)
const GetDC = user32.func('void * __stdcall GetDC(void *hwnd)')
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)')
const PrintWindow = user32.func('int __stdcall PrintWindow(void *hwnd, void *hdc, uint32_t flags)')

koffi.struct('RECT', {
  left: 'int32_t',
  top: 'int32_t',
  right: 'int32_t',
  bottom: 'int32_t',
})
const GetClientRect = user32.func('int __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)')

const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *lpModuleName)')
const DefWindowProcW = user32.func(
  'intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)',
)
koffi.proto('intptr_t __stdcall WNDPROC(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint32_t',
  style: 'uint32_t',
  lpfnWndProc: 'void *',
  cbClsExtra: 'int32_t',
  cbWndExtra: 'int32_t',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'str16',
  lpszClassName: 'str16',
  hIconSm: 'void *',
})
const RegisterClassExW = user32.func('uint16_t __stdcall RegisterClassExW(_In_ WNDCLASSEXW *lpwcx)')
const CreateWindowExW = user32.func(
  'void * __stdcall CreateWindowExW(uint32_t dwExStyle, str16 lpClassName, str16 lpWindowName, uint32_t dwStyle, int32_t x, int32_t y, int32_t nWidth, int32_t nHeight, void *hWndParent, void *hMenu, void *hInstance, void *lpParam)',
)
const DestroyWindow = user32.func('int __stdcall DestroyWindow(void *hwnd)')
const GetSystemMetrics = user32.func('int32_t __stdcall GetSystemMetrics(int32_t nIndex)')

koffi.struct('DWM_SIZE', { cx: 'int32_t', cy: 'int32_t' })
koffi.struct('DWM_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
koffi.struct('DWM_THUMBNAIL_PROPERTIES', {
  dwFlags: 'uint32_t',
  rcDestination: 'DWM_RECT',
  rcSource: 'DWM_RECT',
  opacity: 'uint8_t',
  fVisible: 'int32_t',
  fSourceClientAreaOnly: 'int32_t',
})
const DwmRegisterThumbnail = dwmapi.func(
  'int32_t __stdcall DwmRegisterThumbnail(void *hwndDestination, void *hwndSource, _Out_ void **phThumbnailId)',
)
const DwmUnregisterThumbnail = dwmapi.func('int32_t __stdcall DwmUnregisterThumbnail(void *hThumbnailId)')
const DwmQueryThumbnailSourceSize = dwmapi.func(
  'int32_t __stdcall DwmQueryThumbnailSourceSize(void *hThumbnailId, _Out_ DWM_SIZE *pSize)',
)
const DwmUpdateThumbnailProperties = dwmapi.func(
  'int32_t __stdcall DwmUpdateThumbnailProperties(void *hThumbnailId, _In_ DWM_THUMBNAIL_PROPERTIES *ptnProperties)',
)
const DwmFlush = dwmapi.func('int32_t __stdcall DwmFlush()')

const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)')
const CreateCompatibleBitmap = gdi32.func(
  'void * __stdcall CreateCompatibleBitmap(void *hdc, int32_t w, int32_t h)',
)
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *hobj)')
const DeleteDC = gdi32.func('int __stdcall DeleteDC(void *hdc)')
const DeleteObject = gdi32.func('int __stdcall DeleteObject(void *hobj)')
const BitBlt = gdi32.func(
  'int __stdcall BitBlt(void *hdcDest, int32_t x, int32_t y, int32_t w, int32_t h, void *hdcSrc, int32_t x1, int32_t y1, uint32_t rop)',
)

koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t',
  biWidth: 'int32_t',
  biHeight: 'int32_t',
  biPlanes: 'uint16_t',
  biBitCount: 'uint16_t',
  biCompression: 'uint32_t',
  biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t',
  biYPelsPerMeter: 'int32_t',
  biClrUsed: 'uint32_t',
  biClrImportant: 'uint32_t',
})
const GetDIBits = gdi32.func(
  'int __stdcall GetDIBits(void *hdc, void *hbmp, uint32_t start, uint32_t cLines, _Out_ uint8_t *lpvBits, _Inout_ BITMAPINFOHEADER *lpbi, uint32_t usage)',
)

const DwmGetWindowAttribute = dwmapi.func(
  'int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)',
)

const GW_OWNER = 4
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const PW_RENDERFULLCONTENT = 2
const DWMWA_CLOAKED = 14
const THUMB_HOST_CLASS = 'NuanceThumbHost'

/** 우리가 DWM 캡처용으로 만드는 숨김 호스트 창인지 — 목록에 절대 노출되면 안 된다. */
function isOwnThumbHost(hwnd: bigint): boolean {
  const buf = Buffer.alloc(64 * 2)
  const len = GetClassNameW(hwnd, buf, 64)
  if (len === 0) return false
  return buf.toString('utf16le').replace(/\0.*$/, '') === THUMB_HOST_CLASS
}

/** DWM 이 실제로 그리지 않는(cloaked) 창인지 — 백그라운드 UWP 호스트 등 시스템 창을 걸러낸다. */
function isCloaked(hwnd: bigint): boolean {
  const out = [0]
  const hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4)
  return hr === 0 && out[0] !== 0
}

export interface Win32Window {
  hwnd: bigint
  title: string
  width: number
  height: number
  /** 최소화 상태 — PrintWindow 로는 캡처 불가, captureMinimizedWin32Window 사용 필요. */
  minimized: boolean
}

/** 화면상 최상위 창 목록 — 가려짐/최소화와 무관하게 항상 보인다. */
export function listWin32Windows(): Win32Window[] {
  const results: Win32Window[] = []

  const cb = koffi.register((hwnd: bigint) => {
    if (!IsWindowVisible(hwnd)) return 1
    if (GetWindow(hwnd, GW_OWNER)) return 1 // 소유 창(툴팁/자식) 제외
    if (isOwnThumbHost(hwnd)) return 1 // 우리 자신의 DWM 캡처용 숨김 창 제외
    const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    if (exStyle & WS_EX_TOOLWINDOW) return 1
    if (isCloaked(hwnd)) return 1 // 백그라운드 UWP 호스트 등 실제로 안 그려지는 창 제외

    const len = GetWindowTextLengthW(hwnd)
    if (len === 0) return 1
    const buf = Buffer.alloc((len + 1) * 2)
    GetWindowTextW(hwnd, buf, len + 1)
    const title = buf.toString('utf16le').replace(/\0.*$/, '').trim()
    if (!title) return 1

    const minimized = !!IsIconic(hwnd)
    let width = 0
    let height = 0
    if (!minimized) {
      const rect = { left: 0, top: 0, right: 0, bottom: 0 }
      GetClientRect(hwnd, rect)
      width = rect.right - rect.left
      height = rect.bottom - rect.top
      if (width <= 0 || height <= 0) return 1
    }
    // 최소화된 창은 크기를 여기서 알 수 없다 (GetClientRect 는 복원 아이콘 placeholder를
    // 반환) — captureMinimizedWin32Window 가 DWM 에서 실제 크기를 다시 조회한다.

    results.push({ hwnd, title, width, height, minimized })
    return 1
  }, koffi.pointer('WNDENUMPROC'))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return results
}

type CaptureResult = { buffer: Buffer; width: number; height: number }

/**
 * "빈 캡처"인지 판정 — 단순히 0이 아닌 바이트가 하나라도 있는지가 아니라, 실제
 * 화면 내용이라 할 만큼 충분한 비율(1%)의 바이트가 0이 아닌지로 판단한다.
 * (거의 새까만 캡처도 가장자리 몇 픽셀의 노이즈 때문에 "nonzero"는 쉽게 참이 된다.)
 */
function hasRealContent(buffer: Buffer): boolean {
  let nonzero = 0
  const sampleStep = 4 // 픽셀 단위(4바이트)로 샘플링
  let sampled = 0
  for (let i = 0; i < buffer.length; i += sampleStep) {
    sampled++
    if (buffer[i] !== 0) nonzero++
  }
  return nonzero / sampled > 0.01
}

/** hdcMem 에 이미 그려진 내용을 top-down BGRA 버퍼로 읽어온다. */
function readBitmapPixels(hdcMem: unknown, hBitmap: unknown, width: number, height: number): Buffer {
  const bmi = {
    biSize: 40,
    biWidth: width,
    biHeight: -height, // 음수 = top-down (nativeImage 가 기대하는 순서)
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  }
  const buffer = Buffer.alloc(width * height * 4)
  GetDIBits(hdcMem, hBitmap, 0, height, buffer, bmi, 0)
  return buffer
}

/**
 * PW_RENDERFULLCONTENT 로 가려진 창도 강제 렌더링해 캡처한다.
 * 최소화된 창에는 쓸 수 없다 — captureMinimizedWin32Window 사용.
 *
 * PrintWindow 가 TRUE 를 반환해도, GPU 합성을 쓰는 창(Chrome 등)은 그 순간 즉시
 * 다 그려지는 게 아니라 살짝 뒤에 비동기로 완성되는 경우가 있다. 한 번에 여러 창을
 * 연속으로 캡처하면 뒤쪽 창들이 그 완성 전에 읽혀 빈 화면이 나오는 걸 막기 위해,
 * 완전히 빈 결과면 짧게 대기했다가 재시도한다.
 */
export async function captureWin32Window(
  hwnd: bigint,
  width: number,
  height: number,
): Promise<CaptureResult | null> {
  if (width <= 0 || height <= 0) return null

  for (const delayMs of [0, 80, 200]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))

    const hdcScreen = GetDC(null)
    const hdcMem = CreateCompatibleDC(hdcScreen)
    const hBitmap = CreateCompatibleBitmap(hdcScreen, width, height)
    const hOld = SelectObject(hdcMem, hBitmap)
    let buffer: Buffer | null = null
    try {
      const ok = PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)
      if (ok) buffer = readBitmapPixels(hdcMem, hBitmap, width, height)
    } finally {
      SelectObject(hdcMem, hOld)
      DeleteObject(hBitmap)
      DeleteDC(hdcMem)
      ReleaseDC(null, hdcScreen)
    }
    if (buffer && hasRealContent(buffer)) return { buffer, width, height }
  }
  return null
}

let thumbHostClassReady = false

/** DWM 썸네일 호스트 창 클래스를 최초 1회만 등록한다. */
function ensureThumbHostClass(): void {
  if (thumbHostClassReady) return
  const hInstance = GetModuleHandleW(null)
  const wndProc = koffi.register(
    (hwnd: unknown, msg: number, wParam: unknown, lParam: unknown) =>
      DefWindowProcW(hwnd, msg, wParam, lParam),
    koffi.pointer('WNDPROC'),
  )
  RegisterClassExW({
    cbSize: 80, // sizeof(WNDCLASSEXW) on x64
    style: 0,
    lpfnWndProc: wndProc,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance,
    hIcon: null,
    hCursor: null,
    hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: THUMB_HOST_CLASS,
    hIconSm: null,
  })
  thumbHostClassReady = true
}

const WS_POPUP = 0x80000000
const WS_VISIBLE = 0x10000000
const WS_EX_TOPMOST = 0x00000008
const DWM_TNP_RECTDESTINATION = 0x00000001
const DWM_TNP_VISIBLE = 0x00000008
const DWM_TNP_SOURCECLIENTAREAONLY = 0x00000010
const SRCCOPY = 0x00cc0020
const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
// 호스트 창을 화면 밖(-32000,-32000)에 두면 DWM 이 이 창의 합성을 건너뛰어 썸네일이
// 계속 빈 화면으로 나오는 문제가 있었다. 화면 우하단 구석에 실제로(아주 짧은 순간)
// 띄우고 PrintWindow 대신 화면 자체를 BitBlt 로 읽으면 안정적으로 캡처된다 — DWM 이
// 최종 합성한 결과는 반드시 실제 화면 버퍼에 반영되기 때문. 최종 썸네일 크기보다
// 살짝 큰 정도로만 다운스케일해 화면에 잠깐 뜨는 영역을 최소화한다.
const HOST_MAX_SIZE = 340

/**
 * 최소화된 창은 앱이 렌더링을 멈춰서 PrintWindow 로 캡처하면 빈 화면만 나온다.
 * 대신 DWM Thumbnail API 로 DWM 이 캐싱해둔 "최소화되기 직전 마지막 프레임"을
 * 화면 좌상단의 작은 호스트 창에 합성시킨 뒤, 화면을 BitBlt 로 읽어 캡처한다.
 * (작업표시줄 마우스오버 미리보기·Zoom 화면공유 목록과 동일한 방식)
 */
export async function captureMinimizedWin32Window(hwnd: bigint): Promise<CaptureResult | null> {
  ensureThumbHostClass()
  const hInstance = GetModuleHandleW(null)

  // 원본 크기를 먼저 조회해서, 화면에 잠깐 뜰 호스트 창 크기를 정한다.
  const probeHost = CreateWindowExW(
    0,
    THUMB_HOST_CLASS,
    'thumbhost',
    (WS_POPUP) >>> 0,
    -32000,
    -32000,
    1,
    1,
    null,
    null,
    hInstance,
    null,
  )
  if (!probeHost) return null
  let nativeWidth = 0
  let nativeHeight = 0
  try {
    const idOut = [null]
    if (DwmRegisterThumbnail(probeHost, hwnd, idOut) === 0) {
      const size = { cx: 0, cy: 0 }
      if (DwmQueryThumbnailSourceSize(idOut[0], size) === 0) {
        nativeWidth = size.cx
        nativeHeight = size.cy
      }
      DwmUnregisterThumbnail(idOut[0])
    }
  } finally {
    DestroyWindow(probeHost)
  }
  if (nativeWidth <= 0 || nativeHeight <= 0) return null

  const scale = Math.min(1, HOST_MAX_SIZE / Math.max(nativeWidth, nativeHeight))
  const width = Math.max(1, Math.round(nativeWidth * scale))
  const height = Math.max(1, Math.round(nativeHeight * scale))

  // 화면 우하단 구석 — 캡처하는 아주 짧은 순간만 실제로 보인다.
  const screenX = Math.max(0, GetSystemMetrics(SM_CXSCREEN) - width)
  const screenY = Math.max(0, GetSystemMetrics(SM_CYSCREEN) - height)

  const hostHwnd = CreateWindowExW(
    WS_EX_TOPMOST,
    THUMB_HOST_CLASS,
    'thumbhost',
    (WS_POPUP | WS_VISIBLE) >>> 0,
    screenX,
    screenY,
    width,
    height,
    null,
    null,
    hInstance,
    null,
  )
  if (!hostHwnd) return null

  let thumbId: unknown = null
  try {
    const idOut = [null]
    if (DwmRegisterThumbnail(hostHwnd, hwnd, idOut) !== 0) return null
    thumbId = idOut[0]

    const props = {
      dwFlags: (DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY) >>> 0,
      rcDestination: { left: 0, top: 0, right: width, bottom: height },
      rcSource: { left: 0, top: 0, right: 0, bottom: 0 },
      opacity: 255,
      fVisible: 1,
      fSourceClientAreaOnly: 1,
    }
    if (DwmUpdateThumbnailProperties(thumbId, props) !== 0) return null

    // DwmFlush 는 다음 컴포지터 프레임(vsync)까지 기다려준다 — 임의의 setTimeout 보다
    // 훨씬 짧고 정확하게 "방금 합성됨"을 보장할 수 있어 화면 노출 시간이 최소화된다.
    for (const flushes of [2, 4]) {
      for (let i = 0; i < flushes; i++) DwmFlush()

      const hdcScreen = GetDC(null)
      const hdcMem = CreateCompatibleDC(hdcScreen)
      const hBitmap = CreateCompatibleBitmap(hdcScreen, width, height)
      const hOld = SelectObject(hdcMem, hBitmap)
      let buffer: Buffer | null = null
      try {
        const ok = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, screenX, screenY, SRCCOPY)
        if (ok) buffer = readBitmapPixels(hdcMem, hBitmap, width, height)
      } finally {
        SelectObject(hdcMem, hOld)
        DeleteObject(hBitmap)
        DeleteDC(hdcMem)
        ReleaseDC(null, hdcScreen)
      }
      if (buffer && hasRealContent(buffer)) return { buffer, width, height }
    }
    return null
  } finally {
    if (thumbId) DwmUnregisterThumbnail(thumbId)
    DestroyWindow(hostHwnd)
  }
}
