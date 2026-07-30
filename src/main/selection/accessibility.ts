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
