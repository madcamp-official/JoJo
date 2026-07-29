// 공동 소유 — 단어 hover 하이라이트 박스 스타일의 단일 소스.
// Electron 오버레이(renderer/src/screens/Overlay.tsx, styles.css .word-box)와 크롬 확장
// content script(extension/src/highlight.ts) 둘 다 이 값을 읽어 각자 렌더 방식(React
// inline style vs 주입 CSS)으로 적용한다 — 여기 값만 바꾸면 두 곳 다 반영된다.

export const WORD_BOX_STYLE = {
  borderColor: '#7c3aed', // --purple (선택 모드 테두리와 동일 톤)
  borderWidth: 2, // px
  background: 'rgba(124, 58, 237, 0.18)',
  // 박스 테두리가 글자 획과 겹치지 않게 사방으로 두는 여백(px)
  padding: 2,
  // 모서리가 각져 보인다는 사용자 피드백(2026-07-29)으로 살짝 둥글게 — 글자 하나~두 개
  // 정도의 좁은 박스도 있어 너무 크게 잡으면 옆면이 다 잘려 보이므로 작게만.
  borderRadius: 3, // px
} as const
