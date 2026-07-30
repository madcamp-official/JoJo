// 공동 소유 — keydown 이벤트 ↔ Electron accelerator 문자열 변환/매칭 (PLAN.md §4)
// SettingsScreen.tsx(단축키 녹화)와 App.tsx("설정 화면 열기" 로컬 리스너, 2026-07-29)가
// 공유한다 — 녹화 쪽 포맷과 매칭 쪽 포맷이 어긋나면 "방금 녹화한 값이 실제로는 안 먹힘"
// 같은 버그로 이어지므로 반드시 같은 변환 로직을 써야 한다.

export const IS_MAC = navigator.platform.toUpperCase().includes('MAC')

const NON_KEY_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

/** 수식키(Ctrl/Alt/Shift/Cmd) 단독 입력인지 — 조합키를 누르는 도중 자연히 먼저 발생하는
 *  중간 상태라 무시해야 한다(경고를 띄우면 정상적인 조합 입력 중에도 매번 뜬다). */
export function isModifierOnlyKey(key: string): boolean {
  return NON_KEY_MODIFIERS.has(key)
}

/** F1~F12 처럼 수식키 없이 단독으로도 전역 단축키로 적절한 키 */
export function isStandaloneKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key)
}

/**
 * keydown 이벤트를 Electron accelerator 문자열로 변환 (예: 'Alt+Q', 'Command+,', 'Control+K').
 * 유효하지 않은 입력(수식키 단독, 수식키 없는 일반 키)은 null 을 돌려준다.
 * 수식키 없는 일반 단일 키(예: 'Q')를 등록하면 정상 타이핑을 막으므로, F1~F12 를
 * 제외하고는 최소 1개의 수식키를 요구한다.
 *
 * macOS 는 Cmd(metaKey)와 Ctrl(ctrlKey)을 서로 다른 물리 키로 취급해 각각 'Command'/
 * 'Control'로 따로 기록한다(둘 다 눌러도 됨, 'CommandOrControl' 로 뭉치지 않음) — Windows/
 * Linux 는 Cmd 키 자체가 없어 물리적으로 Ctrl 만 눌리므로 자연히 'Control' 만 기록된다.
 */
export function toAccelerator(e: KeyboardEvent): string | null {
  if (NON_KEY_MODIFIERS.has(e.key)) return null // 수식키 단독 입력은 무시
  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (mods.length === 0 && !isStandaloneKey(key)) return null // 수식키 없는 일반 키 거부
  return [...mods, key].join('+')
}

/** Electron 은 등록 자체는 뭐든 받아준다(실측 확인, 2026-07-30) — OS 차원의 방어가 없어
 *  전적으로 이 녹화 로직이 걸러줘야 한다. `toAccelerator`가 만든 후보 중 "등록되면 안 되는"
 *  조합의 이유를 돌려준다(null = 문제 없음). */
export type UnsafeAcceleratorReason = 'shift-typing' | 'reserved'

// Shift 만 걸고 실제로 문자를 입력하는 키(letter/digit/symbol/space)를 누르면, 그 문자를
// 입력하는 물리 키 조합 자체를 전역으로 가로채 어디서든 타이핑이 깨진다 — 예외 없이 항상
// 나쁜 조합이라 별도 목록 없이 구조로 판정한다(mods 가 Shift 하나뿐 + key 가 한 글자).

// OS/다른 앱이 이미 쓰는 필수 단축키 — 등록되면 Nuance가 켜져 있는 동안 시스템 전체에서
// 그 기능이 먹통이 된다(실측 확인: Electron 이 이런 조합도 register() 를 그냥 성공시킴).
// mac 전용(Command 계열)·Windows 전용(대응 물리 키 없음) 항목이 섞여 있어도 상관없다 —
// 해당 OS에 없는 키는 애초에 눌리지 않으므로 다른 쪽 항목은 자연히 무해하다.
const RESERVED_ACCELERATORS = new Set([
  'Command+Space', // Spotlight
  'Command+Tab', // 앱 전환
  'Command+Q', // 앱 종료
  'Command+W', // 창 닫기
  'Command+Alt+Escape', // 강제 종료
  'Command+C',
  'Command+V',
  'Command+X',
  'Command+Z',
  'Command+A',
  'Command+S',
  'Control+C',
  'Control+V',
  'Control+X',
  'Control+Z',
  'Control+A',
  'Control+S',
  'Alt+Tab', // 앱 전환(Windows)
  'Alt+F4', // 창 닫기(Windows)
  'Control+Shift+Escape', // 작업 관리자(Windows)
  'Control+Alt+Delete',
])

export function unsafeAcceleratorReason(accelerator: string): UnsafeAcceleratorReason | null {
  const parts = accelerator.split('+')
  const mods = parts.slice(0, -1)
  const key = parts[parts.length - 1]!
  if (mods.length === 1 && mods[0] === 'Shift' && key.length === 1) return 'shift-typing'
  if (RESERVED_ACCELERATORS.has(accelerator)) return 'reserved'
  return null
}

/**
 * keydown 이벤트가 저장된 accelerator 문자열(설정에 저장된 값)과 일치하는지 판정한다.
 * 'CommandOrControl'(과거 기본값 호환용 토큰)은 이 OS에서 실제로 눌리는 키(mac=Command,
 * 그 외=Control)로 바꿔서 비교한다 — 새로 녹화되는 값은 이 토큰을 안 쓰지만, 사용자가
 * 아직 안 바꾼 기본값에는 남아있을 수 있다(SettingsScreen.tsx formatAccelerator 주석 참고).
 */
export function matchesAccelerator(e: KeyboardEvent, stored: string): boolean {
  if (!stored) return false
  const live = toAccelerator(e)
  if (!live) return false
  const normalizedStored = stored
    .split('+')
    .map((token) => (token === 'CommandOrControl' ? (IS_MAC ? 'Command' : 'Control') : token))
    .join('+')
  return live === normalizedStored
}
