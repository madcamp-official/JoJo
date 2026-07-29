// 공동 소유 — keydown 이벤트 ↔ Electron accelerator 문자열 변환/매칭 (PLAN.md §3)
// SettingsScreen.tsx(단축키 녹화)와 App.tsx("설정 화면 열기" 로컬 리스너, 2026-07-29)가
// 공유한다 — 녹화 쪽 포맷과 매칭 쪽 포맷이 어긋나면 "방금 녹화한 값이 실제로는 안 먹힘"
// 같은 버그로 이어지므로 반드시 같은 변환 로직을 써야 한다.

export const IS_MAC = navigator.platform.toUpperCase().includes('MAC')

const NON_KEY_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

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
