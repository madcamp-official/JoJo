import koffi from 'koffi'

// 담당 A(보완) — macOS 창 좌표/앞으로 올리기 (PLAN.md §4)
//
// Windows 의 win32Capture 에 대응하는 mac 경로. osascript(System Events 자동화)는
// unsigned dev 앱에서 권한 프롬프트가 안 뜨고 조용히 거부되는 문제가 있어, 대신
// CoreGraphics `CGWindowListCopyWindowInfo` 를 koffi 로 직접 호출한다:
//  - 창 bounds: desktopCapturer 가 주는 window number 로 즉시 조회(추가 권한 프롬프트 없음.
//    창 목록 표시에 이미 화면기록 권한을 받았고, 창 geometry 조회 자체는 권한이 필요 없다).
//  - 앞으로 올리기: 창의 owner PID → NSRunningApplication(objc) activate.
// 좌표는 CGWindow 전역 디스플레이 포인트(좌상단 원점) = Electron DIP 와 동일 좌표계.
//
// PID 만으로는 "어느 창"이 key window 가 될지 특정할 수 없는 경우(예: 크롬 개발자도구가
// 별도 창으로 떠 있는 상태)가 있으나, 이를 보완하려던 Accessibility(AX) API 경로는
// 제거했다 — 손쉬운 사용 권한을 요청해도 시스템 설정 목록에 앱 자체가 추가되지 않아
// 사용자가 권한을 부여할 방법이 없었다(실사용 확인, 2026-07-29). 현재는 activateApp(pid)
// 로 앱 전체를 앞으로 올리는 것으로 충분하다.

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
 * windowId 가 지금 최소화되지 않고 화면에(=현재 활성 데스크탑/Space 에) 보이는 상태인지
 * 확인한다 — win32 의 `IsIconic`(win32Capture.ts) 에 대응. `getMacWindowBounds`
 * (kCGWindowListOptionIncludingWindow 만 사용)는 창이 최소화되거나 다른 데스크탑(Space)에
 * 있어도 마지막 bounds 를 그대로 돌려주도록 의도돼 있어(닫힘 판정과 구분하려고) 그 값만
 * 으로는 최소화/Space 이동 여부를 알 수 없다(2026-07-29, 코드 감사로 발견한 격차 수정 —
 * win32 는 최소화 시 오버레이를 숨기는데 mac 은 옛 위치에 그대로 떠 있었음).
 *
 * **재수정(2026-07-29, "데스크탑 전환 시 오버레이가 따라온다" 재발 제보)**: 처음엔
 * `kCGWindowListOptionOnScreenOnly`를 `kCGWindowListOptionIncludingWindow`(특정 windowId
 * 하나만 조회)와 비트 OR로 합쳐서 썼는데, `kCGWindowListOptionIncludingWindow`는 원래
 * "그 windowId 부터 시작하는 나머지 목록"을 뜻하는 옵션이라(relativeToWindow 위치 지정용)
 * onScreenOnly 와 합치면 "이 창 하나만"이 아니라 "이 창 위치부터 이어지는 모든 on-screen
 * 창들"이 반환돼, 대상이 안 보이는 상태여도 다른 on-screen 창들 때문에 결과가 거의 항상
 * 비어있지 않게(=true 로 오판) 나왔을 수 있다 — 이미 검증된 `listMacWindowOwnerNames`와
 * 동일하게 `kCGWindowListOptionOnScreenOnly` 단독으로 전체 on-screen 목록을 받아 그 안에
 * windowId 가 있는지 직접 찾는 방식으로 바꿔 이 모호함을 없앤다. */
export function isMacWindowOnScreen(windowId: number): boolean {
  if (!ensureCoreGraphics()) return true // 조회 자체가 안 되면 "보임"으로 낙관적 폴백(기존 getWindowInfo 와 동일한 실패 처리 기조)
  let arr: unknown = null
  try {
    arr = CGWindowListCopyWindowInfo!(kCGWindowListOptionOnScreenOnly, 0)
    if (!arr) return false
    const count = Number(CFArrayGetCount!(arr))
    for (let i = 0; i < count; i++) {
      const dict = CFArrayGetValueAtIndex!(arr, i)
      if (!dict) continue
      if (readInt(dict, numberKey) === windowId) return true
    }
    return false
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

/** windowId 로 대상 창을 앞으로 올리고 bounds 를 반환한다(실패 시 null). */
export function raiseAndGetBounds(windowId: number): MacWindowRect | null {
  const info = getWindowInfo(windowId)
  if (!info) return null
  if (info.pid != null) activateApp(info.pid)
  return info.bounds
}

// ---- objc: NSCursor 로 시스템 커서 모양 설정 ----------------------------------
// mac은 "활성 앱"이 시스템 커서를 소유해서, 비활성(백그라운드) 앱의 창 위에서는 CSS
// cursor 가 반영되지 않는다 — 오버레이는 focusable:false 라 항상 비활성이어서, hover
// (pointer)·영역 드래그(crosshair) 커서를 CSS 로는 못 바꾼다(2026-07-30 실사용 확인,
// win32는 "커서 아래 창"이 커서를 정하는 구조라 이 문제가 없음). NSCursor 의 클래스
// 프로퍼티(pointingHandCursor 등)로 커서 객체를 얻어 -set 을 직접 호출한다. 활성 앱이
// 마우스 이동 때마다 자기 커서로 덮어쓸 수 있어서, 호출부(windows.ts 커서 폴링)가
// 상태가 유지되는 동안 매 틱 재설정한다.

export type MacCursorKind = 'pointer' | 'crosshair'

let cursorReady = false
let cursorOk = false
let msgSendGetCursor: KFn | null = null // [NSCursor pointingHandCursor] 등 (cls, sel) -> NSCursor*
let msgSendCursorSet: KFn | null = null // [cursor set]
let clsNSCursor: unknown = null
let selCursorSet: unknown = null
const cursorSelectors: Partial<Record<MacCursorKind, unknown>> = {}

function ensureCursor(): boolean {
  if (cursorReady) return cursorOk
  cursorReady = true
  try {
    const objc = koffi.load('/usr/lib/libobjc.A.dylib')
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
    const objc_getClass = objc.func('void* objc_getClass(const char* name)')
    const sel_registerName = objc.func('void* sel_registerName(const char* name)')
    msgSendGetCursor = objc.func('objc_msgSend', 'void*', ['void*', 'void*'])
    msgSendCursorSet = objc.func('objc_msgSend', 'void', ['void*', 'void*'])
    clsNSCursor = objc_getClass('NSCursor')
    selCursorSet = sel_registerName('set')
    cursorSelectors.pointer = sel_registerName('pointingHandCursor')
    cursorSelectors.crosshair = sel_registerName('crosshairCursor')
    cursorOk = !!clsNSCursor
  } catch {
    cursorOk = false
  }
  return cursorOk
}

/** 시스템 커서를 지정 모양으로 설정한다. 실패해도 예외 없이 false 만 반환(커서가 안
 *  바뀔 뿐 기능엔 지장 없음 — 호출부가 폴백을 마련할 필요도 없다). */
export function setMacCursor(kind: MacCursorKind): boolean {
  if (!ensureCursor()) return false
  try {
    const cursor = msgSendGetCursor!(clsNSCursor, cursorSelectors[kind])
    if (!cursor) return false
    msgSendCursorSet!(cursor, selCursorSet)
    return true
  } catch {
    return false
  }
}

/** desktopCapturer 소스 id("window:12345:0")에서 CGWindowID 숫자를 파싱한다. */
export function parseMacWindowId(sourceId: string): number | null {
  const m = /^window:(\d+)/.exec(sourceId)
  return m ? Number(m[1]) : null
}
