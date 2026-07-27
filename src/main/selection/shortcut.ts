import { globalShortcut } from 'electron'
import type { AppMode } from '@shared/types'
import { onWindowResized, sendOverlayNotice, sendRegionSelectionNeeded, setOverlayMode } from '../windows'
import { startChangeWatcher, stopChangeWatcher } from './changeWatcher'
import { invalidateExtractionCache, refreshExtractionCache } from './extractionCache'
import { autoDetectRegion, clearRegion, getRegion, setRegion } from './regionSelection'

// 담당 A — 모드 전환 전역 단축키 (PLAN.md §3, 기본 macOS: Option+Q / Windows: Alt+Q)
// Electron accelerator 의 'Alt' 는 macOS 에서 Option 키로 자동 매핑되므로 플랫폼 분기가 필요 없다.
let mode: AppMode = 'normal'
let currentAccelerators: string[] = []

// 실제 마우스 드래그(이동이든 리사이즈든)는 WinEventHook 이 한 번에 끝나지 않고 위치가
// 바뀔 때마다(픽셀 단위로) 연달아 이벤트를 쏟아낸다 — resizeJitter 허용치(windows.ts)를
// 넘는 "진짜" 크기 변화라도, 드래그 도중에는 여러 번 연속으로 잡힐 수 있다. 매번 즉시
// 처리하면 자동 영역 감지(무거운 Python 서브프로세스 호출)가 겹쳐 돌면서 심한 렉을
// 유발했다(실사용 중 확인) — 드래그가 끝나고 크기가 안정된 뒤 한 번만 처리한다.
const RESIZE_SETTLE_DELAY_MS = 400
let resizeSettleTimer: NodeJS.Timeout | null = null

// 창 크기가 바뀌면 이전에 지정한 OCR 영역(regionSelection.ts)의 좌표가 더 이상 유효하지
// 않다 — 선택 모드는 그대로 유지하되(모드를 강제로 바꾸지 않음), 영역과 캐시된 단어를
// 비워서 더 이상 아무 박스도 선택되지 않게 하고, 안내 배너와 함께 바로 영역 재선택
// 드래그 모드로 들어간다(오버레이가 배너를 먼저 잠깐 보여준 뒤 드래그 안내로 전환).
onWindowResized(() => {
  if (mode !== 'select') return
  clearRegion()
  invalidateExtractionCache() // 이전 영역 기준 캐시/단어를 비움(오버레이에도 빈 배열 통지돼 박스가 사라짐)
  stopChangeWatcher() // 영역이 무효화됐으니 그 영역 기준 변화 감지도 멈춘다(재선택 후 다시 시작)
  sendOverlayNotice('창 크기가 바뀌었어요. 본문 영역을 다시 찾는 중이에요…')
  if (resizeSettleTimer) clearTimeout(resizeSettleTimer)
  resizeSettleTimer = setTimeout(() => {
    resizeSettleTimer = null
    void acquireRegionAutomaticallyOrAskDrag()
  }, RESIZE_SETTLE_DELAY_MS)
})

function toggleMode(): void {
  mode = mode === 'normal' ? 'select' : 'normal'
  setOverlayMode(mode) // 오버레이 테두리 색(일반=파랑/선택=보라) 갱신 + MODE_CHANGED 통지
  if (mode !== 'select') {
    stopChangeWatcher()
    return
  }

  if (getRegion()) {
    // 이전에 지정해둔 영역 재사용 — 클릭 시 매번 새로 돌리면 느려서, 모드 진입 시
    // 미리 캡처+추출해 캐시를 채워둔다(extractionCache.ts).
    refreshExtractionCache()
    startChangeWatcher() // 영역이 이미 있으니 바로 변화 감지 시작(changeWatcher.ts)
  } else {
    void acquireRegionAutomaticallyOrAskDrag()
  }
}

// autoDetectRegion() 은 Python(DocLayout-YOLO) 서브프로세스를 스폰하는 무거운 호출이라,
// 이미 하나가 진행 중인데 또 시작하면(예: 디바운스를 뚫고 연달아 들어온 요청) CPU를
// 서로 잡아먹어 렉이 심해진다(실사용 중 확인) — 한 번에 하나만 돌리고, 그사이 또
// 요청이 들어오면 지금 것이 끝난 뒤 딱 한 번만 더 돈다(여러 번 쌓아두지 않음).
let detecting = false
let pendingRedetect = false

/**
 * 담당 A — 실험용 브랜치(experiment/doclayout-yolo). 영역이 없을 때(처음 선택한 창,
 * 리사이즈로 무효화된 뒤) 먼저 DocLayout-YOLO 로 본문 영역 자동 감지를 시도한다
 * (regionSelection.ts: autoDetectRegion) — 모드 진입 시 기본으로 뜨는 "텍스트 추출
 * 중…" 표시가 이 대기 시간도 자연히 가려준다. 성공하면 드래그 없이 바로 그 영역으로
 * 추출을 시작하고, 실패하면(Python 환경 없음, 본문 인식 실패 등) 기존처럼 오버레이에
 * 드래그 선택을 요청한다 — 즉 이 실험 기능은 "잘 되면 자동, 안 되면 기존 수동 방식"
 * 으로 완전히 폴백하므로 항상 안전하다.
 */
async function acquireRegionAutomaticallyOrAskDrag(): Promise<void> {
  if (detecting) {
    pendingRedetect = true
    return
  }
  detecting = true
  try {
    const detected = await autoDetectRegion()
    if (mode !== 'select') return // 그 사이 모드가 바뀌었으면(빠른 토글 등) 무시
    if (detected) {
      setRegion(detected)
      refreshExtractionCache()
      startChangeWatcher()
    } else {
      // 영역이 없으면(처음 선택하는 창이거나, 리사이즈로 무효화된 뒤) 오버레이에 드래그
      // 선택을 요청한다 — 사용자가 영역을 그리면 ipc.ts(SUBMIT_REGION)가 저장 후 추출을 시작한다.
      sendRegionSelectionNeeded()
    }
  } finally {
    detecting = false
    if (pendingRedetect) {
      pendingRedetect = false
      void acquireRegionAutomaticallyOrAskDrag()
    }
  }
}

/**
 * accelerator 에 등록할 실제 조합 목록을 만든다. Electron 의 'CommandOrControl' 은
 * "Cmd 또는 Ctrl 둘 다"가 아니라 macOS 에서는 Cmd, 그 외에서는 Ctrl 로 딱 하나만 고정
 * 매핑된다 — 그래서 macOS 에서 물리 Ctrl 키를 눌러도 반응하지 않는다. macOS 에서
 * 'CommandOrControl' 이 포함된 경우, 'Control' 로 치환한 조합도 함께 등록해 Cmd/Ctrl
 * 둘 다 동작하게 한다.
 */
function expandAccelerator(accelerator: string): string[] {
  if (process.platform !== 'darwin' || !accelerator.includes('CommandOrControl')) {
    return [accelerator]
  }
  return [accelerator, accelerator.replace('CommandOrControl', 'Control')]
}

export function registerModeShortcut(accelerator = 'Alt+Q'): void {
  if (!accelerator) return // 빈 문자열 = 단축키 해제 상태(등록 안 함)
  const accelerators = expandAccelerator(accelerator)
  accelerators.forEach((a) => globalShortcut.register(a, toggleMode))
  currentAccelerators = accelerators
}

/**
 * 설정 화면에서 단축키를 변경/해제할 때 호출 — 기존 등록을 해제한 뒤 새 accelerator 로
 * 재등록한다. 빈 문자열을 넘기면 해제만 하고 새로 등록하지 않는다(단축키 없음 상태).
 */
export function updateModeShortcut(accelerator: string): void {
  currentAccelerators.forEach((a) => globalShortcut.unregister(a))
  currentAccelerators = []
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
  stopChangeWatcher()
}
