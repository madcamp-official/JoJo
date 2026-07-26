import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import { onWindowResized, sendOverlayNotice, sendRegionSelectionNeeded, setOverlayMode } from '../windows'
import { invalidateExtractionCache, refreshExtractionCache } from './extractionCache'
import { clearRegion, getRegion } from './regionSelection'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 macOS: Option+Q / Windows: Alt+Q)
// Electron accelerator 의 'Alt' 는 macOS 에서 Option 키로 자동 매핑되므로 플랫폼 분기가 필요 없다.
let mode: AppMode = 'normal'
let currentAccelerator: string | null = null

// 창 크기가 바뀌면 이전에 지정한 OCR 영역(regionSelection.ts)의 좌표가 더 이상 유효하지
// 않다 — 선택 모드는 그대로 유지하되(모드를 강제로 바꾸지 않음), 영역과 캐시된 단어를
// 비워서 더 이상 아무 박스도 선택되지 않게 하고, 안내 배너와 함께 바로 영역 재선택
// 드래그 모드로 들어간다(오버레이가 배너를 먼저 잠깐 보여준 뒤 드래그 안내로 전환).
onWindowResized(() => {
  if (mode !== 'select') return
  clearRegion()
  invalidateExtractionCache() // 이전 영역 기준 캐시/단어를 비움(오버레이에도 빈 배열 통지돼 박스가 사라짐)
  sendOverlayNotice('창 크기가 바뀌었어요. 영역을 다시 선택해주세요.')
  sendRegionSelectionNeeded()
})

function toggleMode(): void {
  mode = mode === 'normal' ? 'select' : 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  if (mode !== 'select') return

  if (getRegion()) {
    // 이전에 지정해둔 영역 재사용 — 클릭 시 매번 새로 돌리면 느려서, 모드 진입 시
    // 미리 캡처+추출해 캐시를 채워둔다(extractionCache.ts).
    refreshExtractionCache()
  } else {
    // 영역이 없으면(처음 선택하는 창이거나, 리사이즈로 무효화된 뒤) 오버레이에 드래그
    // 선택을 요청한다 — 사용자가 영역을 그리면 ipc.ts(SUBMIT_REGION)가 저장 후 추출을 시작한다.
    sendRegionSelectionNeeded()
  }
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
