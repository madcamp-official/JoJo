import koffi from 'koffi'

// 담당 milleion — NSTrackingArea 기반 커서 관리(2026-07-31, 사용자 지적 — 사파리 탭 바의
// "+" 버튼은 사파리가 활성 앱이 아니어도 호버 시 정확히 하이라이트/커서가 바뀐다).
//
// windows.ts 의 기존 33ms 폴링(+ NSCursor.set() 강제 재적용) 방식은 macOS 의 정식 커서
// 소유 경로가 아니다 — "지금 마우스 아래 있는 창"이 아니라 "지금 마우스 위치를 계속
// 확인해 매 틱 커서를 덮어쓰는" 방식이라, 다른(활성) 앱의 창이 자기 커서 규칙을 스스로
// 재적용할 때 타이밍 경쟁에서 밀린다(실사용 확인, 2026-07-31 — 활성 앱이 Preview 가
// 아니면 커서가 안 바뀜). 정식 경로는 `NSTrackingArea`(`cursorUpdate:` +
// `NSTrackingActiveAlways`)를 그 창의 뷰에 등록하는 것 — 이러면 hit-test 로 그 창이
// 마우스 아래 있기만 하면(클릭스루가 꺼져 있어 실제로 이벤트를 받는 동안만) OS 가
// 알아서 그 창(프로세스)에게 커서 갱신 기회를 준다. 활성 앱 여부와 무관하다 — 사파리의
// "+" 버튼이 정확히 이 메커니즘을 쓴다.
//
// 이 파일은 컴파일된 네이티브 애드온을 새로 추가하지 않고, 기존 macWindow.ts/macAx.ts와
// 같은 순수 koffi(FFI) 패턴만으로 Objective-C 클래스를 런타임에 동적으로 하나 만들어서
// (`objc_allocateClassPair` 등) `cursorUpdate:` 를 구현하는 "커서 오너" 인스턴스를 만들고,
// 오버레이 창의 NSView 에 트래킹 영역으로 등록한다.
//
// **위험 격리(사용자 요청, 2026-07-31 — "이상해질 경우 롤백하기 쉽게")**: 이 모듈
// 전체가 한 파일로 독립돼 있어, 문제가 생기면 windows.ts 에서 이 모듈을 부르는 두 줄
// (ensureOverlayWindow 안의 `attachCursorTracking` 호출)만 지우면 도입 전 상태로 정확히
// 되돌아간다(git revert 로도 이 파일 + 그 두 줄만 되돌리면 끝). 초기화(`ensure`)가
// 실패하면(클래스 등록 실패, 프레임워크 심볼 변경 등) 예외를 잡아 조용히 비활성화하고,
// 그래도 기존 폴링 방식(windows.ts macCursorTimer)은 그대로 남아 있으므로 이 모듈이
// 통째로 실패해도 커서 기능 자체가 없어지진 않는다(폴링 방식으로 자연 폴백 — Preview가
// 활성 앱인 경우는 계속 정상 동작).
export type CursorKind = 'pointer' | 'crosshair'

const APPKIT = '/System/Library/Frameworks/AppKit.framework/AppKit'
const OBJC = '/usr/lib/libobjc.A.dylib'

type KFn = (...args: unknown[]) => unknown

// NSRect — NSPoint(x,y) + NSSize(width,height) 를 평평한 4-double 구조체로 취급해도
// 메모리 배치가 동일하다(macScroll.ts 의 CGPoint 재사용과 같은 방식).
const NSRectS = koffi.struct('CursorNSRect', { x: 'double', y: 'double', width: 'double', height: 'double' })

// NSTrackingAreaOptions(AppKit/NSTrackingArea.h) — 여러 macOS 버전에 걸쳐 안정적으로
// 유지되는 공개 상수라 하드코딩해도 안전하다.
const NSTrackingCursorUpdate = 0x04
const NSTrackingActiveAlways = 0x80
const NSTrackingInVisibleRect = 0x200
const TRACKING_OPTIONS = NSTrackingCursorUpdate | NSTrackingActiveAlways | NSTrackingInVisibleRect

let ready = false
let ok = false

let objc_getClass: KFn | null = null
let sel_registerName: KFn | null = null
let objc_allocateClassPair: KFn | null = null
let objc_registerClassPair: KFn | null = null
let class_addMethod: KFn | null = null
let msgSend0: KFn | null = null // (id, SEL) -> id — alloc/init 등 무인자 호출
let msgSendInitTrackingArea: KFn | null = null // -initWithRect:options:owner:userInfo:
let msgSendAddView: KFn | null = null // -addTrackingArea:
let msgSendCursorForKind: KFn | null = null // +pointingHandCursor 등 (id) -> id
let msgSendCursorSet: KFn | null = null // -set

let selAlloc: unknown = null
let selInit: unknown = null
let selInitTrackingArea: unknown = null
let selAddTrackingArea: unknown = null
let selCursorSet: unknown = null
let clsNSTrackingArea: unknown = null
let clsNSCursor: unknown = null
const cursorSelectors: Partial<Record<CursorKind, unknown>> = {}

let cursorOwnerClass: unknown = null
/** koffi.register() 로 등록한 콜백 — 앱이 사는 동안 계속 유효해야 하므로 절대
 *  unregister 하지 않는다(등록 해제하면 그 뒤 cursorUpdate: 호출이 use-after-free). */
let cursorUpdateCallback: unknown = null

/** cursorUpdate: 콜백이 호출될 때 "지금 원하는 커서가 뭔지" 묻는다 — windows.ts 의
 *  macDesiredCursor 를 그대로 참조하게 해서, 기존 폴링 로직과 같은 값을 공유한다. */
let getDesiredCursor: (() => CursorKind | null) | null = null

function ensure(): boolean {
  if (ready) return ok
  ready = true
  if (process.platform !== 'darwin') return false
  try {
    const objc = koffi.load(OBJC)
    koffi.load(APPKIT)

    objc_getClass = objc.func('void* objc_getClass(const char* name)')
    sel_registerName = objc.func('void* sel_registerName(const char* name)')
    objc_allocateClassPair = objc.func(
      'void* objc_allocateClassPair(void* superclass, const char* name, size_t extraBytes)',
    )
    objc_registerClassPair = objc.func('void objc_registerClassPair(void* cls)')
    class_addMethod = objc.func('bool class_addMethod(void* cls, void* sel, void* imp, const char* types)')

    // objc_msgSend 는 다형적이라, 호출 시그니처별로 따로 바인딩한다(같은 심볼, 다른
    // 프로토타입 — macWindow.ts 의 기존 관례와 동일).
    msgSend0 = objc.func('objc_msgSend', 'void*', ['void*', 'void*'])
    msgSendInitTrackingArea = objc.func('objc_msgSend', 'void*', [
      'void*',
      'void*',
      NSRectS,
      'unsigned long',
      'void*',
      'void*',
    ])
    msgSendAddView = objc.func('objc_msgSend', 'void', ['void*', 'void*', 'void*'])
    msgSendCursorForKind = objc.func('objc_msgSend', 'void*', ['void*', 'void*'])
    msgSendCursorSet = objc.func('objc_msgSend', 'void', ['void*', 'void*'])

    const nsObject = objc_getClass('NSObject')
    clsNSTrackingArea = objc_getClass('NSTrackingArea')
    clsNSCursor = objc_getClass('NSCursor')
    if (!nsObject || !clsNSTrackingArea || !clsNSCursor) return false

    // 클래스 이름은 프로세스마다(재시작 시) 겹치지 않게 pid 를 넣는다 — 같은 이름 재등록은
    // objc_allocateClassPair 가 실패(null)로 알려주므로 위험하진 않지만, 굳이 부딪힐
    // 이유가 없다.
    const className = `NuanceCursorOwner_${process.pid}`
    const cls = objc_allocateClassPair(nsObject, className, 0)
    if (!cls) return false

    const cursorUpdateSel = sel_registerName('cursorUpdate:')
    const CursorUpdateImp = koffi.proto('void CursorUpdateImp(void* self, void* cmd, void* event)')
    // IMP 시그니처: void cursorUpdate(id self, SEL _cmd, id event) — Objective-C 메서드
    // 실제 호출 규약(self, _cmd 뒤 인자들)과 정확히 일치해야 한다. koffi.register 로
    // 등록한 콜백은 프로세스가 사는 동안 계속 호출 가능해야 하므로(polling 이 아니라
        // OS 가 임의 시점에 호출) registered 콜백을 쓴다(transient 콜백은 C 함수가 아직
    // 실행 중일 때만 유효해서 여기엔 안 맞음).
    cursorUpdateCallback = koffi.register(() => {
      try {
        const kind = getDesiredCursor?.() ?? null
        if (!kind) return
        const sel = cursorSelectors[kind]
        if (!sel || !clsNSCursor) return
        const cursor = msgSendCursorForKind!(clsNSCursor, sel)
        if (cursor) msgSendCursorSet!(cursor, selCursorSet)
      } catch {
        /* 콜백 안 예외는 무시 — 커서가 안 바뀔 뿐 크래시로 이어지면 안 된다. */
      }
    }, koffi.pointer(CursorUpdateImp))

    const added = class_addMethod(cls, cursorUpdateSel, cursorUpdateCallback, 'v@:@')
    if (!added) return false
    objc_registerClassPair(cls)
    cursorOwnerClass = cls

    selAlloc = sel_registerName('alloc')
    selInit = sel_registerName('init')
    selInitTrackingArea = sel_registerName('initWithRect:options:owner:userInfo:')
    selAddTrackingArea = sel_registerName('addTrackingArea:')
    selCursorSet = sel_registerName('set')
    cursorSelectors.pointer = sel_registerName('pointingHandCursor')
    cursorSelectors.crosshair = sel_registerName('crosshairCursor')

    ok = true
    return true
  } catch (err) {
    console.warn('[macCursorTracking] 초기화 실패, 기존 폴링 방식으로만 동작:', (err as Error)?.message)
    ok = false
    return false
  }
}

/**
 * 오버레이 창의 NSView(Electron `getNativeWindowHandle()`가 주는 값 — NSWindow*가 아니라
 * NSView*)에 커서 트래킹 영역을 등록한다. `desiredCursor`는 windows.ts 의 기존
 * `macDesiredCursor`를 그대로 참조하는 getter — 두 메커니즘(폴링 + 트래킹 영역)이 같은
 * "지금 원하는 커서" 상태를 공유한다. 실패해도 예외 없이 false 만 반환(호출부는 기존
 * 폴링 방식이 알아서 커버하므로 별도 폴백 처리가 필요 없다).
 */
export function attachCursorTracking(nsView: Buffer, desiredCursor: () => CursorKind | null): boolean {
  if (!ensure()) return false
  getDesiredCursor = desiredCursor
  try {
    const viewPtr = nsView.readBigUInt64LE(0)
    const allocatedOwner = msgSend0!(cursorOwnerClass, selAlloc)
    if (!allocatedOwner) return false
    const owner = msgSend0!(allocatedOwner, selInit)
    if (!owner) return false

    const allocatedArea = msgSend0!(clsNSTrackingArea, selAlloc)
    if (!allocatedArea) return false
    // NSTrackingInVisibleRect 를 켰기 때문에 rect 인자는 무시된다(뷰 bounds 를 자동
    // 추적) — 굳이 [view bounds] 를 따로 물어볼 필요가 없다(구조체 반환값 처리를
    // 피하려는 의도도 있다).
    const area = msgSendInitTrackingArea!(
      allocatedArea,
      selInitTrackingArea,
      { x: 0, y: 0, width: 0, height: 0 },
      TRACKING_OPTIONS,
      owner,
      null,
    )
    if (!area) return false
    msgSendAddView!(viewPtr, selAddTrackingArea, area)
    return true
  } catch (err) {
    console.warn('[macCursorTracking] 트래킹 영역 등록 실패:', (err as Error)?.message)
    return false
  }
}
