import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import { setOverlayMode } from '../windows'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 Ctrl+1)
let mode: AppMode = 'normal'

export function registerModeShortcut(accelerator = 'CommandOrControl+1'): void {
  globalShortcut.register(accelerator, () => {
    mode = mode === 'normal' ? 'select' : 'normal'
    setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
    // TODO(담당 A): 선택 모드 진입 시 대상 창 위 오버레이 표시/해제(단어 hover 등) 로직 연결.
  })
}

export function currentMode(): AppMode {
  return mode
}
