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

/** desktopCapturer 소스 id("window:12345:0")에서 CGWindowID 숫자를 파싱한다. */
export function parseMacWindowId(sourceId: string): number | null {
  const m = /^window:(\d+)/.exec(sourceId)
  return m ? Number(m[1]) : null
}
