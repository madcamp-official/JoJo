// 담당 A — 확장 content script (PLAN.md §4.1)
// (1) DOM 텍스트 추출(태그 제외, 문단 잇기)
// (2) 유튜브/넷플릭스 원어 자막 추출
// (3) 선택 모드 시 단어 주변 사각형 하이라이트

export function extractDomText(): { text: string; rects: DOMRect[] } {
  // TODO(담당 A): 가시 텍스트 노드 순회 → 태그 제외 후 이어붙이기 + 좌표.
  return { text: '', rects: [] }
}

export function extractSubtitles(): string[] {
  // TODO(담당 A): youtube=URL/timedtext, netflix=플레이어 자막 트랙에서 원어 자막.
  return []
}

// content ↔ background 메시지 예시
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'extract') sendResponse(extractDomText())
  return true
})
