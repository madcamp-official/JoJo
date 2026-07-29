import koffi from 'koffi'

// 담당 A — mac 버전의 inputHook.ts (2026-07-29, win32/mac 격차 감사로 발견 — changeWatcher.ts
// 의 "실제 입력이 최근에 있었는지" 게이트가 win32 전용이라 mac 은 그 필터링 없이 픽셀
// diff 만으로 판단해 hover 등 미세한 변화에도 더 민감했다).
//
// win32 는 저수준 전역 후크(SetWindowsHookExW, WH_MOUSE_LL/WH_KEYBOARD_LL)로 실시간 콜백을
// 받아야 했지만(inputHook.ts), mac 은 훨씬 가벼운 공개 API
// `CGEventSourceSecondsSinceLastEventType` 하나로 충분하다 — 이벤트를 실제로 가로채거나
// 관찰하는 게 아니라 "시스템 전역에서 이 타입의 이벤트가 마지막으로 언제 있었는지"를
// 그때그때 질의만 하는 방식이라, 손쉬운 사용(Accessibility) 권한도 CGEventTap 설치도
// 필요 없다(스크린세이버 등이 유휴 시간 판정에 흔히 쓰는 표준 API).

type KFn = (...args: unknown[]) => unknown

let cg: ReturnType<typeof koffi.load> | null = null
let CGEventSourceSecondsSinceLastEventType: KFn | null = null

const kCGEventSourceStateCombinedSessionState = 0

// win32 쪽과 동일한 기준(마우스 이동은 hover 의 원인이라 명시적으로 제외) — 좌/우/중간
// 클릭, 스크롤(세로/가로), 키 입력만 "진짜 사용자 조작"으로 인정한다.
const kCGEventLeftMouseDown = 1
const kCGEventRightMouseDown = 3
const kCGEventKeyDown = 10
const kCGEventScrollWheel = 22
const kCGEventOtherMouseDown = 25
const QUALIFYING_EVENT_TYPES = [
  kCGEventLeftMouseDown,
  kCGEventRightMouseDown,
  kCGEventOtherMouseDown,
  kCGEventScrollWheel,
  kCGEventKeyDown,
]

function ensureCoreGraphics(): boolean {
  if (cg) return true
  try {
    cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    CGEventSourceSecondsSinceLastEventType = cg.func(
      'double CGEventSourceSecondsSinceLastEventType(int32_t stateID, uint32_t eventType)',
    )
    return true
  } catch {
    cg = null
    return false
  }
}

/**
 * 마지막으로 "진짜 사용자 입력"(클릭/스크롤/키보드 — 마우스 이동 제외)이 있었던
 * 시각(`Date.now()` 기준 ms)을 반환한다. 조회 실패 시 0(inputHook.ts 의
 * getLastQualifyingInputTime 과 동일한 실패 계약 — changeWatcher.ts 가 "입력 없음"으로
 * 처리). 이벤트 타입별로 "마지막으로부터 몇 초 지났는지"를 각각 물어본 뒤 가장 최근
 * (가장 작은 값) 하나를 쓴다.
 */
export function getMacLastQualifyingInputTime(): number {
  if (process.platform !== 'darwin' || !ensureCoreGraphics()) return 0
  try {
    let minSeconds = Infinity
    for (const type of QUALIFYING_EVENT_TYPES) {
      const seconds = Number(
        CGEventSourceSecondsSinceLastEventType!(kCGEventSourceStateCombinedSessionState, type),
      )
      if (Number.isFinite(seconds) && seconds < minSeconds) minSeconds = seconds
    }
    if (!Number.isFinite(minSeconds)) return 0
    return Date.now() - minSeconds * 1000
  } catch {
    return 0
  }
}
