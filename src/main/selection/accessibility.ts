// 담당 A — 데스크톱 접근성 API 브릿지 (PLAN.md §5.1)
// macOS AX / Windows UIA 로 (1) 전자책 뷰어 렌더 텍스트 추출,
// (2) 탭/URL 변화 감지(브라우저 밖). 브라우저 내부는 확장이 담당.
// TODO(담당 A): OS별 네이티브 애드온 또는 라이브러리 연동.

export interface AccessibilitySnapshot {
  appName: string
  url?: string
  text?: string
}

export async function readActiveWindow(): Promise<AccessibilitySnapshot> {
  throw new Error('not implemented: readActiveWindow')
}

export function onUrlChange(_cb: (url: string) => void): void {
  // TODO(담당 A): 폴링/이벤트로 URL 변화 감지 → decideOcr.invalidate 호출.
}

/**
 * 표준 텍스트 컨트롤(메모장의 EDIT 등)에서 렌더된 텍스트를 직접 읽는다 — OCR 없이도
 * 정확한 텍스트를 얻을 수 있는 경우. 브라우저·PDF 뷰어처럼 캔버스에 직접 그리는 앱은
 * 이 방식으로 텍스트를 못 얻으므로 null 을 반환한다 — 호출부가 OCR 로 폴백해야 한다.
 * Windows(UIA 대신 WM_GETTEXT 기반, 표준 컨트롤만 커버) 전용 — macOS 미구현.
 */
export async function readWindowText(hwnd: bigint): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const { readWin32WindowText } = await import('./win32Capture')
  return readWin32WindowText(hwnd)
}
