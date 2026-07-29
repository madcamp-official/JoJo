// 담당 A — 전역 입력(스크롤/클릭/키보드) 감지. **Windows 전용**(아래 설명).
//
// changeWatcher.ts 의 화면 변화 감지(픽셀 diff)는 원인을 전혀 구분 못 해서, 브라우저
// 같은 화면에서 마우스 hover 로 생기는 밑줄/툴팁 같은 작은 시각 변화에도 재추출이
// 걸리는 문제가 있었다(사용자 보고). "사용자가 실제로 조작해서" 생긴 변화(스크롤/
// 클릭/키 입력)만 재추출 트리거로 인정하기 위해, 저수준 전역 후크(WH_MOUSE_LL/
// WH_KEYBOARD_LL)로 그런 입력이 마지막으로 언제 있었는지 기록해둔다 — 마우스
// "이동"(hover 의 원인, WM_MOUSEMOVE)은 명시적으로 무시한다.
//
// 크로스플랫폼(타깃: Windows/macOS): 이 방식(SetWindowsHookEx)은 win32 전용 API라
// macOS 에는 없다 — 그래서 이 모듈은 win32Capture.ts 와 같은 패턴으로 macOS 에서 아예
// 안 불러지게 한다. macOS 는 대신 macInput.ts 가 훨씬 가벼운 공개 API
// (CGEventSourceSecondsSinceLastEventType, 권한 불필요)로 동일한 게이트를 제공한다
// (2026-07-29 추가). changeWatcher.ts: getLastInputTime 이 플랫폼별로 알맞은 쪽을 부른다.
//
// 저수준 후크는 설치한 스레드의 메시지 루프가 계속 펌핑돼야 콜백이 실행된다 —
// Electron 메인 프로세스는 자신의 창(BrowserWindow 등)을 위해 이미 Windows 메시지
// 루프를 돌리고 있어서 별도 루프를 만들 필요는 없다. 콜백은 절대 무거운 작업을 하면
// 안 된다(동기적으로 시스템 입력 파이프라인을 막는다 — Windows 는 기본 300ms 넘게
// 응답 없으면 훅을 강제로 해제함) — 그래서 타임스탬프만 기록하고 즉시 다음 훅으로
// 넘긴다.
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

koffi.proto('intptr_t __stdcall HOOKPROC(int nCode, uintptr_t wParam, intptr_t lParam)')

const SetWindowsHookExW = user32.func(
  'void * __stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hMod, uint32_t dwThreadId)',
)
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)')
const CallNextHookEx = user32.func(
  'intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, intptr_t lParam)',
)
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *lpModuleName)')

const WH_KEYBOARD_LL = 13
const WH_MOUSE_LL = 14

const WM_KEYDOWN = 0x0100
const WM_SYSKEYDOWN = 0x0104
const WM_LBUTTONDOWN = 0x0201
const WM_RBUTTONDOWN = 0x0204
const WM_MBUTTONDOWN = 0x0207
const WM_MOUSEWHEEL = 0x020a
const WM_MOUSEHWHEEL = 0x020e // 가로 스크롤(트랙패드 등)

let lastQualifyingInputAt = 0
let keyboardHook: unknown = null
let mouseHook: unknown = null
let started = false

function markInput(): void {
  lastQualifyingInputAt = Date.now()
}

/**
 * 진짜 사용자 입력(스크롤/클릭/키보드)이 마지막으로 있었던 시각(`Date.now()` 기준
 * ms) — 한 번도 없었으면(또는 훅이 아예 없는 플랫폼이면) 0을 반환한다.
 * changeWatcher.ts 가 이 값의 "최근성"을 재추출 트리거 게이트로 쓴다.
 */
export function getLastQualifyingInputTime(): number {
  return lastQualifyingInputAt
}

/** 앱 시작 시(index.ts) 한 번 호출 — 이미 설치돼 있으면 무시(idempotent). Windows 전용. */
export function startInputHook(): void {
  if (process.platform !== 'win32' || started) return
  started = true
  try {
    const hMod = GetModuleHandleW(null)

    const keyboardProc = koffi.register(
      (nCode: number, wParam: number, lParam: unknown) => {
        if (nCode === 0 && (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN)) markInput()
        return CallNextHookEx(null, nCode, wParam, lParam)
      },
      koffi.pointer('HOOKPROC'),
    )

    const mouseProc = koffi.register(
      (nCode: number, wParam: number, lParam: unknown) => {
        if (
          nCode === 0 &&
          (wParam === WM_LBUTTONDOWN ||
            wParam === WM_RBUTTONDOWN ||
            wParam === WM_MBUTTONDOWN ||
            wParam === WM_MOUSEWHEEL ||
            wParam === WM_MOUSEHWHEEL)
        ) {
          markInput()
        }
        return CallNextHookEx(null, nCode, wParam, lParam)
      },
      koffi.pointer('HOOKPROC'),
    )

    keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardProc, hMod, 0)
    mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, hMod, 0)
    if (!keyboardHook || !mouseHook) {
      console.error('[inputHook] 후크 설치 실패 — 스크롤/클릭/키보드 필터링 없이 동작(기존 픽셀 diff 만으로 판단)')
    }
  } catch (err) {
    console.error('[inputHook] 초기화 실패(무시):', err)
  }
}

/** 앱 종료 시(index.ts before-quit) 호출 — 설치된 후크를 해제한다. */
export function stopInputHook(): void {
  if (keyboardHook) {
    UnhookWindowsHookEx(keyboardHook)
    keyboardHook = null
  }
  if (mouseHook) {
    UnhookWindowsHookEx(mouseHook)
    mouseHook = null
  }
  started = false
}
