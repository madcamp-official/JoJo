import koffi from 'koffi'

// 담당 milleion — macOS 오버레이가 클릭을 받으려고 비-클릭스루 상태(interactive=true,
// windows.ts: setOverlayInteractive)가 되는 동안, 스크롤 휠 이벤트까지 함께 막혀버리는
// 문제를 우회한다(사용자 요청, 2026-07-30 — "호버박스 위에서도 스크롤이 가능하게").
//
// 근본 원인: `BrowserWindow.setIgnoreMouseEvents(false)`는 macOS 에서 "전부 아니면
// 전무"라 클릭을 받으려면 창이 모든 마우스 입력(스크롤 포함)을 가로챌 수밖에 없다
// (`{forward: true}` 옵션은 Windows 전용이라 mac 에선 아무 효과가 없다 — OVERLAY_CURSOR
// 채널을 새로 만든 이유와 동일한 한계, windows.ts 주석 참고).
//
// 해결: 오버레이가 가로챈 wheel 이벤트를 여기서 합성 CGEvent 로 다시 만들어 대상 창의
// 소유 프로세스(PID)에 직접 꽂아준다(`CGEventPostToPid`) — 이 함수는 화면 좌표 히트테스트를
// 건너뛰고 프로세스에 직접 전달하므로, 우리 오버레이가 화면상 그 앞에 떠 있어도 무관하게
// 전달된다(hit-test 기반 CGEventPost 였다면 다시 우리 오버레이로 돌아왔을 것).
//
// **주의**: 스크롤 방향 부호는 실사용으로 검증 필요 — macOS 시스템 설정의 "자연스러운
// 스크롤" 이 이 합성 이벤트에도 그대로 적용되는지, 방향이 반대로 느껴지면 postScrollToPid
// 의 deltaY/deltaX 부호를 뒤집으면 된다(아래 주석 참고).

const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

type KFn = (...args: unknown[]) => unknown

// koffi.struct 는 이름으로 타입을 등록해 이후 함수 프로토타입 문자열('ScrollCGPoint')이
// 그 이름으로 참조할 수 있게 한다 — 반환값 자체는 다시 쓰지 않지만 등록(부작용) 때문에
// 호출은 반드시 필요하다.
koffi.struct('ScrollCGPoint', { x: 'double', y: 'double' })

/** CGScrollEventUnit — 픽셀 단위(트랙패드/정밀 스크롤에 대응, 브라우저 wheel 이벤트의
 *  deltaMode=0 픽셀 값과 그대로 맞는다). 라인 단위(1)를 쓰면 델타 크기 해석이 달라진다. */
const kCGScrollEventUnitPixel = 0

let loaded = false
let CGEventCreateScrollWheelEvent: KFn | null = null
let CGEventSetLocation: KFn | null = null
let CGEventPostToPid: KFn | null = null
let CFRelease: KFn | null = null

function ensure(): boolean {
  if (loaded) return CGEventCreateScrollWheelEvent !== null
  loaded = true
  if (process.platform !== 'darwin') return false
  try {
    const cg = koffi.load(CORE_GRAPHICS)
    const cf = koffi.load(CORE_FOUNDATION)
    // CGEventCreateScrollWheelEvent 는 wheelCount 에 따라 가변 인자(wheel1..wheel3)를 받는
    // 진짜 variadic 함수다 — **첫 구현에서 이걸 고정 5개 인자 함수처럼 선언했다가 ARM64
    // (Apple Silicon)에서 조용히 실패했다(사용자 실사용 확인, 2026-07-30 — "스크롤은
    // 여전히 안돼")**: variadic 호출은 ARM64 AAPCS64 규약상 고정 인자와 레지스터/스택
    // 배치 규칙이 달라서, 가변 인자를 고정 인자인 것처럼 선언하면 값이 엉뚱한 위치로
    // 전달된다. koffi 는 프로토타입 끝에 `...`를 명시하고 호출 시 (타입, 값) 쌍으로
    // 넘기는 진짜 variadic 호출을 지원한다(koffi/doc/load.md 참고) — 그 방식으로 수정.
    CGEventCreateScrollWheelEvent = cg.func(
      'void* CGEventCreateScrollWheelEvent(void* source, uint32_t units, uint32_t wheelCount, ...)',
    )
    CGEventSetLocation = cg.func('void CGEventSetLocation(void* event, ScrollCGPoint point)')
    CGEventPostToPid = cg.func('void CGEventPostToPid(int pid, void* event)')
    CFRelease = cf.func('void CFRelease(void* cf)')
    return true
  } catch (err) {
    console.warn('[macScroll] CoreGraphics 로드 실패:', (err as Error)?.message)
    CGEventCreateScrollWheelEvent = null
    return false
  }
}

/**
 * 스크린 좌표 `point`(포인트 단위, macWindow.ts 의 다른 좌표들과 동일한 좌상단 원점
 * 전역 좌표계)에서 `pid` 소유 프로세스로 스크롤 휠 이벤트를 합성해 전달한다.
 * deltaX/deltaY 는 브라우저 wheel 이벤트의 그것을 그대로 받는다(픽셀 단위).
 *
 * 부호 관례(실사용 검증 필요, 위 파일 주석 참고): DOM `wheel` 이벤트는 사용자가
 * 트랙패드에서 손가락을 위로 밀 때(콘텐츠가 아래로 스크롤) deltaY 가 음수, 아래로 밀 때
 * (콘텐츠가 위로 스크롤) 양수다. CGEvent 의 wheel1 은 반대로 양수가 "위로 스크롤"(콘텐츠가
 * 아래로 이동)을 뜻하는 고전적 마우스 휠 관례를 따른다 — 그래서 부호를 반전해서 넘긴다.
 * 시스템 "자연스러운 스크롤" 설정은 우리가 신경 쓸 필요 없이 OS가 합성 이벤트에도 동일하게
 * 적용해준다(실제 장치 이벤트와 동일한 처리 경로를 타므로).
 */
export function postScrollToPid(pid: number, point: { x: number; y: number }, deltaX: number, deltaY: number): void {
  // 임시 진단 로그(2026-07-31, 사용자 제보 — 스크롤 우회가 여전히 안 됨) — 어느 단계에서
  // 멈추는지(로드 실패/이벤트 생성 실패/여기까진 왔는데 실제 스크롤만 안 되는지) 구분한다.
  if (!ensure()) {
    console.warn('[macScroll] CoreGraphics 바인딩 준비 안 됨 — 스크롤 전달 포기')
    return
  }
  if (deltaX === 0 && deltaY === 0) return
  try {
    // 가변 인자는 koffi 관례대로 (타입, 값) 쌍으로 넘긴다 — wheel1(수직), wheel2(수평).
    const event = CGEventCreateScrollWheelEvent!(
      null,
      kCGScrollEventUnitPixel,
      2,
      'int32_t',
      Math.round(-deltaY),
      'int32_t',
      Math.round(-deltaX),
    )
    if (!event) {
      console.warn('[macScroll] CGEventCreateScrollWheelEvent 가 null 반환')
      return
    }
    try {
      CGEventSetLocation!(event, point)
      CGEventPostToPid!(pid, event)
      console.log(`[macScroll] pid=${pid} 로 스크롤 이벤트 전달 완료`)
    } finally {
      CFRelease!(event)
    }
  } catch (err) {
    console.warn('[macScroll] 스크롤 이벤트 전달 실패:', (err as Error)?.message)
  }
}
