import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 Ctrl+1)
let mode: AppMode = 'normal'

export function registerModeShortcut(accelerator = 'CommandOrControl+1'): void {
  globalShortcut.register(accelerator, () => {
    mode = mode === 'normal' ? 'select' : 'normal'
    // TODO(담당 A): 오버레이 표시/해제 + 창 테두리 색(일반=파랑/선택=보라) 갱신,
    //              MODE_CHANGED 이벤트로 렌더러에 통지.
  })
}

export function currentMode(): AppMode {
  return mode
}
