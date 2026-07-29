import koffi from 'koffi'

// 담당 A(보완) — macOS 창 좌표/앞으로 올리기 (PLAN.md §3)
//
// Windows 의 win32Capture 에 대응하는 mac 경로. osascript(System Events 자동화)는
// unsigned dev 앱에서 권한 프롬프트가 안 뜨고 조용히 거부되는 문제가 있어, 대신
// CoreGraphics `CGWindowListCopyWindowInfo` 를 koffi 로 직접 호출한다:
//  - 창 bounds: desktopCapturer 가 주는 window number 로 즉시 조회(추가 권한 프롬프트 없음.
//    창 목록 표시에 이미 화면기록 권한을 받았고, 창 geometry 조회 자체는 권한이 필요 없다).
//  - 앞으로 올리기: 창의 owner PID → NSRunningApplication(objc) activate.
// 좌표는 CGWindow 전역 디스플레이 포인트(좌상단 원점) = Electron DIP 와 동일 좌표계.
//
// **PID 만으로는 부족한 경우(2026-07-29)**: 크롬 개발자도구를 별도 창으로 띄운 상태에서
// 크롬의 "다른" 창(원래 선택 대상)을 고르면, activateApp(pid) 는 그 앱(크롬) 전체를
// 앞으로 올릴 뿐 "어느 창"이 key window 가 될지는 macOS 가 그 앱의 마지막 포커스 기준으로
// 알아서 정한다 — devtools 창이 최근에 포커싱돼 있었으면 그게 앞으로 온다(실사용 확인).
// 이걸 막으려면 "이 PID 의 어느 창"인지까지 지정해야 하는데 CoreGraphics 는 그 API가
// 없어 Accessibility(AX) API 로 보완한다: AXUIElementCreateApplication(pid) 로 앱의
// AX 루트를 얻고, AXWindows 목록에서 bounds(AXPosition/AXSize)가 우리가 아는 대상 창의
// CGWindow bounds 와 일치하는 AXUIElement 를 찾아 AXRaise 액션 + AXFocusedWindow 지정으로
// "그 창"만 특정해 앞으로 올린다. **손쉬운 사용(Accessibility) 권한이 필요**(TODO.md
// 배포 항목에 이미 명시된 권한) — 권한이 없으면 AX 호출이 실패해 조용히 기존 방식
// (activateApp 만, 앱 전체 활성화)으로 폴백한다(권한 프롬프트가 안 뜨는 케이스에서도
// 동작 자체가 나빠지진 않음, 그냥 창 특정이 안 될 뿐).

export interface MacWindowRect {
  x: number
  y: number
  width: number
  height: number
}

// ---- CoreGraphics / CoreFoundation 바인딩 -----------------------------------

// koffi.func() 가 돌려주는 네이티브 함수 핸들(라이브러리마다 시그니처가 달라 느슨하게 둔다).
type KFn = (...args: unknown[]) => unknown

const CGRect = koffi.struct('CGRect', {
  x: 'double',
  y: 'double',
  width: 'double',
  height: 'double',
})

let cg: ReturnType<typeof koffi.load> | null = null
let cf: ReturnType<typeof koffi.load> | null = null
let CGWindowListCopyWindowInfo: KFn | null = null
let CGRectMakeWithDictionaryRepresentation: KFn | null = null
let CFArrayGetCount: KFn | null = null
let CFArrayGetValueAtIndex: KFn | null = null
let CFDictionaryGetValue: KFn | null = null
let CFNumberGetValue: KFn | null = null
let CFRelease: KFn | null = null
let CFStringGetLength: KFn | null = null
let CFStringGetCString: KFn | null = null
let boundsKey: unknown = null // CFString "kCGWindowBounds" (재사용 위해 캐시)
let ownerPidKey: unknown = null // CFString "kCGWindowOwnerPID"
let ownerNameKey: unknown = null // CFString "kCGWindowOwnerName"
let numberKey: unknown = null // CFString "kCGWindowNumber"
let layerKey: unknown = null // CFString "kCGWindowLayer"

const kCGWindowListOptionIncludingWindow = 1 << 3
const kCGWindowListOptionOnScreenOnly = 1 << 0
const kCFStringEncodingUTF8 = 0x08000100
const kCFNumberSInt32Type = 3

function ensureCoreGraphics(): boolean {
  if (cg && cf) return true
  try {
    cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    CGWindowListCopyWindowInfo = cg.func(
      'void* CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)',
    )
    CGRectMakeWithDictionaryRepresentation = cg.func(
      'bool CGRectMakeWithDictionaryRepresentation(void* dict, void* rect)',
    )
    CFArrayGetCount = cf.func('long CFArrayGetCount(void* arr)')
    CFArrayGetValueAtIndex = cf.func('void* CFArrayGetValueAtIndex(void* arr, long idx)')
    CFDictionaryGetValue = cf.func('void* CFDictionaryGetValue(void* dict, void* key)')
    CFNumberGetValue = cf.func('bool CFNumberGetValue(void* number, long theType, void* value)')
    CFRelease = cf.func('void CFRelease(void* cf)')
    CFStringGetLength = cf.func('long CFStringGetLength(void* str)')
    CFStringGetCString = cf.func(
      'bool CFStringGetCString(void* str, _Out_ char* buffer, long bufferSize, uint32_t encoding)',
    )
    const CFStringCreateWithCString = cf.func(
      'void* CFStringCreateWithCString(void* alloc, const char* cstr, uint32_t encoding)',
    )
    boundsKey = CFStringCreateWithCString(null, 'kCGWindowBounds', kCFStringEncodingUTF8)
    ownerPidKey = CFStringCreateWithCString(null, 'kCGWindowOwnerPID', kCFStringEncodingUTF8)
    ownerNameKey = CFStringCreateWithCString(null, 'kCGWindowOwnerName', kCFStringEncodingUTF8)
    numberKey = CFStringCreateWithCString(null, 'kCGWindowNumber', kCFStringEncodingUTF8)
    layerKey = CFStringCreateWithCString(null, 'kCGWindowLayer', kCFStringEncodingUTF8)
    return true
  } catch {
    cg = cf = null
    return false
  }
}

interface WindowInfo {
  bounds: MacWindowRect
  pid: number | null
}

/** windowId(=CGWindowID)로 창의 bounds + owner PID 를 조회한다(실패 시 null). */
function getWindowInfo(windowId: number): WindowInfo | null {
  if (!ensureCoreGraphics()) return null
  let arr: unknown = null
  try {
    arr = CGWindowListCopyWindowInfo!(kCGWindowListOptionIncludingWindow, windowId)
    if (!arr) return null
    const count = Number(CFArrayGetCount!(arr))
    if (count < 1) return null
    const dict = CFArrayGetValueAtIndex!(arr, 0)
    if (!dict) return null

    const boundsDict = CFDictionaryGetValue!(dict, boundsKey)
    if (!boundsDict) return null
    const rectPtr = koffi.alloc(CGRect, 1)
    const ok = CGRectMakeWithDictionaryRepresentation!(boundsDict, rectPtr)
    if (!ok) return null
    const r = koffi.decode(rectPtr, CGRect) as MacWindowRect
    if (!(r.width > 0 && r.height > 0)) return null

    let pid: number | null = null
    const pidNum = CFDictionaryGetValue!(dict, ownerPidKey)
    if (pidNum) {
      const pidPtr = koffi.alloc('int32_t', 1)
      if (CFNumberGetValue!(pidNum, kCFNumberSInt32Type, pidPtr)) {
        pid = koffi.decode(pidPtr, 'int32_t') as number
      }
    }
    return { bounds: { x: r.x, y: r.y, width: r.width, height: r.height }, pid }
  } catch {
    return null
  } finally {
    if (arr) {
      try {
        CFRelease!(arr)
      } catch {
        /* ignore */
      }
    }
  }
}

/** windowId 로 창의 bounds 만 조회(실시간 추적 폴링용 — 단일 창이라 가볍다). */
export function getMacWindowBounds(windowId: number): MacWindowRect | null {
  return getWindowInfo(windowId)?.bounds ?? null
}

/**
 * windowId 가 지금 최소화되지 않고 화면에 보이는 상태인지 확인한다 — win32 의
 * `IsIconic`(win32Capture.ts) 에 대응. `getMacWindowBounds`(kCGWindowListOptionIncludingWindow
 * 만 사용)는 창이 최소화돼도 마지막 bounds 를 그대로 돌려주도록 의도돼 있어(닫힘 판정과
 * 구분하려고) 그 값만으로는 최소화 여부를 알 수 없다 — `kCGWindowListOptionOnScreenOnly`
 * 를 같이 줘서 조회하면 최소화된 창은 결과가 비어 온다(2026-07-29, 코드 감사로 발견한
 * 격차 수정 — win32 는 최소화 시 오버레이를 숨기는데 mac 은 옛 위치에 그대로 떠 있었음).
 */
export function isMacWindowOnScreen(windowId: number): boolean {
  if (!ensureCoreGraphics()) return true // 조회 자체가 안 되면 "보임"으로 낙관적 폴백(기존 getWindowInfo 와 동일한 실패 처리 기조)
  let arr: unknown = null
  try {
    arr = CGWindowListCopyWindowInfo!(kCGWindowListOptionOnScreenOnly | kCGWindowListOptionIncludingWindow, windowId)
    if (!arr) return false
    return Number(CFArrayGetCount!(arr)) > 0
  } catch {
    return true
  } finally {
    if (arr) {
      try {
        CFRelease!(arr)
      } catch {
        /* ignore */
      }
    }
  }
}

/** dict 에서 int32 값 하나를 읽는다(CFNumber). */
function readInt(dict: unknown, key: unknown): number | null {
  const num = CFDictionaryGetValue!(dict, key)
  if (!num) return null
  const p = koffi.alloc('int32_t', 1)
  if (CFNumberGetValue!(num, kCFNumberSInt32Type, p)) return koffi.decode(p, 'int32_t') as number
  return null
}

/** CFStringRef를 JS 문자열로 변환한다(실패 시 null). */
function cfStringToJs(str: unknown): string | null {
  if (!str) return null
  const len = Number(CFStringGetLength!(str))
  const bufSize = len * 4 + 1 // UTF-8 최악의 경우(문자당 4바이트) + null 종단
  const buf = Buffer.alloc(bufSize)
  if (!CFStringGetCString!(str, buf, bufSize, kCFStringEncodingUTF8)) return null
  return buf.toString('utf8').replace(/\0.*$/, '')
}

/**
 * 화면에 보이는 창들의 windowId → owner 앱 이름 맵을 한 번에 조회한다(창 목록에
 * "앱 이름 - 창 제목" 표시용). `desktopCapturer`(창 목록)와 마찬가지로 on-screen 창만
 * 대상으로 하므로 목록 항목과 1:1로 맞는다.
 */
export function listMacWindowOwnerNames(): Map<number, string> {
  const map = new Map<number, string>()
  if (!ensureCoreGraphics()) return map
  let arr: unknown = null
  try {
    arr = CGWindowListCopyWindowInfo!(kCGWindowListOptionOnScreenOnly, 0)
    if (!arr) return map
    const count = Number(CFArrayGetCount!(arr))
    for (let i = 0; i < count; i++) {
      const dict = CFArrayGetValueAtIndex!(arr, i)
      if (!dict) continue
      const wid = readInt(dict, numberKey)
      if (wid == null) continue
      const owner = cfStringToJs(CFDictionaryGetValue!(dict, ownerNameKey))
      if (owner) map.set(wid, owner)
    }
    return map
  } catch {
    return map
  } finally {
    if (arr) {
      try {
        CFRelease!(arr)
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- orderWindow:relativeTo: — 오버레이를 대상 창 바로 위 z-order 한 칸에 꽂기 --------
//
// 처음엔 "대상이 지금 화면 맨 앞(포커싱된 창)인지"를 매 틱 확인해 그때만 alwaysOnTop 을
// 켜는 방식(isMacWindowFrontmost, 이젠 삭제됨)으로 접근했는데, 껐을 때 오버레이가 "일반
// 레벨의 어디쯤"으로 가라앉을 뿐이라 대상 창 자체가 멀쩡히 보이는데도(아무것도 안 덮었는데도)
// 테두리가 안 보이는 문제가 있었다(사용자 피드백, 2026-07-29 — "테두리가 선택창 포커스가
// 해제되면 안보이게 됐어. 선택창 바로 위에 붙어있게 해줘"). win32(`syncOverlayZOrder`)처럼
// "정확히 대상 창 바로 위 한 칸"에 꽂아야 이 문제가 없다 — mac 공개 API 중
// `-[NSWindow orderWindow:relativeTo:]`(AppKit, 어떤 창 번호를 relativeTo 로 줘도 동작하며
// 우리 앱 소유가 아닌 창도 기준으로 삼을 수 있다)가 정확히 이 용도다. Electron
// `getNativeWindowHandle()`은 NSWindow*가 아니라 NSView*(contentView)를 주므로, 먼저
// `-window` 접근자로 NSWindow*를 얻은 뒤 이 메서드를 호출한다.
let orderWindowReady = false
let orderWindowOk = false
let msgSendGetWindow: KFn | null = null // NSView* -> NSWindow*("window" 접근자)
let msgSendOrderWindow: KFn | null = null // NSWindow* -orderWindow:relativeTo:
let selWindowAccessor: unknown = null
let selOrderWindowRelativeTo: unknown = null

const NSWindowAbove = 1

function ensureOrderWindow(): boolean {
  if (orderWindowReady) return orderWindowOk
  orderWindowReady = true
  try {
    const objc = koffi.load('/usr/lib/libobjc.A.dylib')
    const sel_registerName = objc.func('void* sel_registerName(const char* name)')
    msgSendGetWindow = objc.func('objc_msgSend', 'void*', ['void*', 'void*'])
    msgSendOrderWindow = objc.func('objc_msgSend', 'void', ['void*', 'void*', 'long', 'long'])
    selWindowAccessor = sel_registerName('window')
    selOrderWindowRelativeTo = sel_registerName('orderWindow:relativeTo:')
    orderWindowOk = true
  } catch {
    orderWindowOk = false
  }
  return orderWindowOk
}

/**
 * 오버레이(Electron BrowserWindow)를 targetWindowId(CGWindowID) 바로 위 z-order 한 칸에
 * 꽂는다. overlayNsView 는 오버레이 창의 `getNativeWindowHandle()`(NSView* 를 담은
 * Buffer) 를 그대로 넘기면 된다. 실패(권한·API 변경 등)해도 예외 없이 false 만 반환 —
 * 호출부(windows.ts)가 이 경우 기존 alwaysOnTop 방식으로 폴백한다. */
export function orderOverlayAboveWindow(overlayNsView: Buffer, targetWindowId: number): boolean {
  if (!ensureOrderWindow()) return false
  try {
    const nsViewPtr = overlayNsView.readBigUInt64LE(0)
    const nsWindow = msgSendGetWindow!(nsViewPtr, selWindowAccessor)
    if (!nsWindow) return false
    msgSendOrderWindow!(nsWindow, selOrderWindowRelativeTo, NSWindowAbove, targetWindowId)
    return true
  } catch {
    return false
  }
}

// ---- objc: NSRunningApplication 으로 소유 앱을 앞으로 --------------------------

let objcReady = false
let objcOk = false
let msgSendPid: KFn | null = null
let msgSendActivate: KFn | null = null
let clsNSRunningApplication: unknown = null
let selRunningAppForPid: unknown = null
let selActivate: unknown = null

function ensureObjc(): boolean {
  if (objcReady) return objcOk
  objcReady = true
  try {
    const objc = koffi.load('/usr/lib/libobjc.A.dylib')
    // NSRunningApplication 은 AppKit 클래스라, AppKit 을 로드해 클래스가 등록되게 한다
    // (Electron 메인 프로세스엔 대개 이미 로드돼 있지만 명시적으로 보장).
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
    const objc_getClass = objc.func('void* objc_getClass(const char* name)')
    const sel_registerName = objc.func('void* sel_registerName(const char* name)')
    // objc_msgSend 는 호출 시그니처별로 따로 바인딩한다(같은 심볼, 다른 프로토타입).
    msgSendPid = objc.func('objc_msgSend', 'void*', ['void*', 'void*', 'int'])
    msgSendActivate = objc.func('objc_msgSend', 'bool', ['void*', 'void*', 'unsigned long'])
    clsNSRunningApplication = objc_getClass('NSRunningApplication')
    selRunningAppForPid = sel_registerName('runningApplicationWithProcessIdentifier:')
    selActivate = sel_registerName('activateWithOptions:')
    objcOk = !!clsNSRunningApplication
  } catch {
    objcOk = false
  }
  return objcOk
}

// NSApplicationActivateAllWindows(1) | NSApplicationActivateIgnoringOtherApps(2)
const ACTIVATE_OPTIONS = 3

/** owner PID 의 앱을 앞으로 올린다(그 앱의 창들이 함께 전면으로). 실패 시 false. */
function activateApp(pid: number): boolean {
  if (!ensureObjc()) return false
  try {
    const app = msgSendPid!(clsNSRunningApplication, selRunningAppForPid, pid)
    if (!app) return false
    msgSendActivate!(app, selActivate, ACTIVATE_OPTIONS)
    return true
  } catch {
    return false
  }
}

// ---- Accessibility(AX): PID 의 여러 창 중 "이 창" 하나만 특정해 앞으로 올리기 --------

const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })
const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' })
const kAXValueCGPointType = 1
const kAXValueCGSizeType = 2

let axReady = false
let axOk = false
let AXUIElementCreateApplication: KFn | null = null
let AXUIElementCopyAttributeValue: KFn | null = null
let AXUIElementSetAttributeValue: KFn | null = null
let AXUIElementPerformAction: KFn | null = null
let AXValueGetValue: KFn | null = null
let axWindowsAttr: unknown = null
let axPositionAttr: unknown = null
let axSizeAttr: unknown = null
let axFocusedWindowAttr: unknown = null
let axRaiseAction: unknown = null

function ensureAX(): boolean {
  if (axReady) return axOk
  axReady = true
  try {
    // AX API 는 손쉬운 사용(Accessibility) 권한이 없으면 프롬프트도 없이 조용히 빈 결과만
    // 준다 — 시스템 설정 목록에 앱을 추가해주지도 않아서, 사용자가 수동으로 넣어줄 방법도
    // 마땅치 않다(실사용 확인, 2026-07-29: 목록에 Electron 항목 자체가 없었음). Electron 이
    // 이를 위해 제공하는 `systemPreferences.isTrustedAccessibilityClient(true)` 로 확인하면
    // 미허용 시 OS 권한 요청 다이얼로그가 뜨고 목록에도 추가된다 — 최초 1회만 프롬프트를
    // 띄우고(ensureAX 는 axReady 로 1회만 실행됨), 사용자가 허용 전이면 이번 세션은
    // 기존 폴백(activateApp, 앱 전체 활성화)으로 동작한다(허용 후 앱 재시작하면 반영).
    const { systemPreferences } = require('electron') as typeof import('electron')
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      console.warn(
        '[macWindow] 손쉬운 사용(Accessibility) 권한 없음 — 같은 앱(PID)의 특정 창 포커스 기능이 비활성화됩니다. ' +
          '시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 허용 후 앱을 재시작하세요.',
      )
      axOk = false
      return false
    }
    if (!ensureCoreGraphics()) return false
    const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    AXUIElementCreateApplication = ax.func('void* AXUIElementCreateApplication(int32_t pid)')
    AXUIElementCopyAttributeValue = ax.func(
      'int32_t AXUIElementCopyAttributeValue(void* element, void* attribute, void* value)',
    )
    AXUIElementSetAttributeValue = ax.func(
      'int32_t AXUIElementSetAttributeValue(void* element, void* attribute, void* value)',
    )
    AXUIElementPerformAction = ax.func('int32_t AXUIElementPerformAction(void* element, void* action)')
    AXValueGetValue = ax.func('bool AXValueGetValue(void* value, int32_t type, void* out)')
    const CFStringCreateWithCString = cf!.func(
      'void* CFStringCreateWithCString(void* alloc, const char* cstr, uint32_t encoding)',
    )
    axWindowsAttr = CFStringCreateWithCString(null, 'AXWindows', kCFStringEncodingUTF8)
    axPositionAttr = CFStringCreateWithCString(null, 'AXPosition', kCFStringEncodingUTF8)
    axSizeAttr = CFStringCreateWithCString(null, 'AXSize', kCFStringEncodingUTF8)
    axFocusedWindowAttr = CFStringCreateWithCString(null, 'AXFocusedWindow', kCFStringEncodingUTF8)
    axRaiseAction = CFStringCreateWithCString(null, 'AXRaise', kCFStringEncodingUTF8)
    axOk = true
    return true
  } catch {
    axOk = false
    return false
  }
}

/** AX 창의 bounds(AXPosition+AXSize)를 읽는다. 실패 시 null. */
function readAxWindowBounds(win: unknown): MacWindowRect | null {
  try {
    const posValPtr = koffi.alloc('void*', 1)
    if (Number(AXUIElementCopyAttributeValue!(win, axPositionAttr, posValPtr)) !== 0) return null
    const posVal = koffi.decode(posValPtr, 'void*')
    const posOut = koffi.alloc(CGPoint, 1)
    if (!AXValueGetValue!(posVal, kAXValueCGPointType, posOut)) return null
    const pos = koffi.decode(posOut, CGPoint) as { x: number; y: number }

    const sizeValPtr = koffi.alloc('void*', 1)
    if (Number(AXUIElementCopyAttributeValue!(win, axSizeAttr, sizeValPtr)) !== 0) return null
    const sizeVal = koffi.decode(sizeValPtr, 'void*')
    const sizeOut = koffi.alloc(CGSize, 1)
    if (!AXValueGetValue!(sizeVal, kAXValueCGSizeType, sizeOut)) return null
    const size = koffi.decode(sizeOut, CGSize) as { width: number; height: number }

    return { x: pos.x, y: pos.y, width: size.width, height: size.height }
  } catch {
    return null
  }
}

function boundsClose(a: MacWindowRect, b: MacWindowRect): boolean {
  const TOLERANCE = 2
  return (
    Math.abs(a.x - b.x) < TOLERANCE &&
    Math.abs(a.y - b.y) < TOLERANCE &&
    Math.abs(a.width - b.width) < TOLERANCE &&
    Math.abs(a.height - b.height) < TOLERANCE
  )
}

/**
 * pid 소유 창들 중 targetBounds 와 일치하는 창을 찾아 그 창만 특정해 앞으로 올린다
 * (AXRaise + AXFocusedWindow). 같은 pid 에 다른 창(devtools 등)이 더 있어도 이 창만
 * 골라 포커스한다. 손쉬운 사용 권한이 없거나 API 실패 시 false(호출부가 activateApp
 * 만으로 폴백).
 */
function raiseSpecificWindow(pid: number, targetBounds: MacWindowRect): boolean {
  if (!ensureAX()) return false
  try {
    const app = AXUIElementCreateApplication!(pid)
    if (!app) return false
    const windowsPtr = koffi.alloc('void*', 1)
    if (Number(AXUIElementCopyAttributeValue!(app, axWindowsAttr, windowsPtr)) !== 0) return false
    const windows = koffi.decode(windowsPtr, 'void*')
    if (!windows) return false
    const count = Number(CFArrayGetCount!(windows))
    for (let i = 0; i < count; i++) {
      const win = CFArrayGetValueAtIndex!(windows, i)
      if (!win) continue
      const bounds = readAxWindowBounds(win)
      if (!bounds || !boundsClose(bounds, targetBounds)) continue
      AXUIElementPerformAction!(win, axRaiseAction)
      AXUIElementSetAttributeValue!(app, axFocusedWindowAttr, win)
      return true
    }
    // bounds 가 일치하는 AX 창을 못 찾음(최소화된 창은 AXWindows 에 안 잡히거나 bounds 가
    // 다를 수 있음 등) — 진단용으로 남긴다(정상 폴백 경로라 warn 아님).
    console.log(`[macWindow] AX 창 매칭 실패(pid=${pid}, 후보 ${count}개) — 앱 전체 활성화로 폴백`)
    return false
  } catch {
    return false
  }
}

/** pid 소유의 화면에 보이는 일반(layer 0) 창 개수 — 권한이 필요 없는 CGWindowList 로 센다. */
function countOnScreenWindowsOfPid(pid: number): number {
  if (!ensureCoreGraphics()) return 0
  let arr: unknown = null
  try {
    arr = CGWindowListCopyWindowInfo!(kCGWindowListOptionOnScreenOnly, 0)
    if (!arr) return 0
    const total = Number(CFArrayGetCount!(arr))
    let count = 0
    for (let i = 0; i < total; i++) {
      const dict = CFArrayGetValueAtIndex!(arr, i)
      if (!dict) continue
      if (readInt(dict, layerKey) !== 0) continue // 메뉴바/독 등 비-0 레이어 제외
      if (readInt(dict, ownerPidKey) === pid) count++
    }
    return count
  } catch {
    return 0
  } finally {
    if (arr) {
      try {
        CFRelease!(arr)
      } catch {
        /* ignore */
      }
    }
  }
}

/** windowId 로 대상 창을 앞으로 올리고 bounds 를 반환한다(실패 시 null). */
export function raiseAndGetBounds(windowId: number): MacWindowRect | null {
  const info = getWindowInfo(windowId)
  if (!info) return null
  if (info.pid != null) {
    // 같은 pid 안에 여러 창(예: 크롬 + 별도 devtools 창)이 있을 수 있어, 앱 전체를
    // 활성화하기 전에 먼저 AX 로 "이 창"만 특정해 raise+focus 해둔다 — 그래야 이어지는
    // activateApp 이 앱을 앞으로 올릴 때 이미 포커스가 맞춰진 이 창이 key window 로 유지된다.
    // 단, AX(손쉬운 사용 권한 프롬프트 포함)는 실제로 필요할 때 — 그 앱에 창이 2개
    // 이상일 때 — 만 발동한다: 창이 하나뿐이면 activateApp 만으로 항상 그 창이 앞으로
    // 오므로 AX 가 필요 없고, 대부분의 사용자에게 권한 요청 자체가 안 뜬다(창 개수는
    // 권한이 필요 없는 CGWindowList 로 센다).
    if (countOnScreenWindowsOfPid(info.pid) >= 2) raiseSpecificWindow(info.pid, info.bounds)
    activateApp(info.pid)
  }
  return info.bounds
}

/** desktopCapturer 소스 id("window:12345:0")에서 CGWindowID 숫자를 파싱한다. */
export function parseMacWindowId(sourceId: string): number | null {
  const m = /^window:(\d+)/.exec(sourceId)
  return m ? Number(m[1]) : null
}
