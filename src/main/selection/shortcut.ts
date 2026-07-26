import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import { setOverlayMode } from '../windows'
import { refreshExtractionCache } from './extractionCache'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 macOS: Option+Q / Windows: Alt+Q)
// Electron accelerator 의 'Alt' 는 macOS 에서 Option 키로 자동 매핑되므로 플랫폼 분기가 필요 없다.
let mode: AppMode = 'normal'
let currentAccelerator: string | null = null

function toggleMode(): void {
  mode = mode === 'normal' ? 'select' : 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  // 선택 모드에 들어갈 때마다 미리 캡처+추출해 캐시를 채워둔다(extractionCache.ts) —
  // 클릭 시 매번 새로 돌리면 느려서, 진입 시 1회로 옮기고 클릭은 캐시를 즉시 쓴다.
  if (mode === 'select') refreshExtractionCache()
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

/**
 * 창을 (재)선택할 때 호출 — 선택 모드였다면 일반 모드로 되돌린다. 새로 선택한 창은
 * 아직 캐시된 단어 위치가 없는데 선택 모드 테두리만 남아있으면 헷갈리고, 굳이
 * 자동으로 새 창에 대해 선택 모드를 유지할 이유도 없다.
 */
export function resetToNormalMode(): void {
  if (mode === 'normal') return
  mode = 'normal'
  setOverlayMode(mode)
}
