import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import { setOverlayMode } from '../windows'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 macOS: Option+Q / Windows: Alt+Q)
// Electron accelerator 의 'Alt' 는 macOS 에서 Option 키로 자동 매핑되므로 플랫폼 분기가 필요 없다.
let mode: AppMode = 'normal'
let currentAccelerator: string | null = null

function toggleMode(): void {
  mode = mode === 'normal' ? 'select' : 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  // TODO(담당 A): 선택 모드 진입 시 대상 창 위 오버레이 표시/해제(단어 hover 등) 로직 연결.
}

export function registerModeShortcut(accelerator = 'Alt+Q'): void {
  globalShortcut.register(accelerator, toggleMode)
  currentAccelerator = accelerator
}

/** 설정 화면에서 단축키를 변경할 때 호출 — 기존 등록 해제 후 새 accelerator 로 재등록. */
export function updateModeShortcut(accelerator: string): void {
  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
  registerModeShortcut(accelerator)
}

export function currentMode(): AppMode {
  return mode
}
