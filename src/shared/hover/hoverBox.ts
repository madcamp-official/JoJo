// 공용 — 확장이 페이지 안에서 직접 그리는 hover 단어 박스 + 커서 오버라이드.
// 자막(highlight.ts)과 웹 문단(articleHighlight.ts)이 각자 이 박스/커서 코드를 그대로
// 복제해 갖고 있었는데, 그 결과 한쪽만 고치고 다른 쪽은 뒤처지는 드리프트가 실제로
// 생겼다(예: 스크롤/리사이즈 시 박스 숨김, 클릭 시 박스 숨김이 웹에만 있었음, 2026-07-30
// "로직 통합해서 자막도 웹처럼" 사용자 지시). 자막 모드와 웹 모드는 항상 배타적으로만
// 켜지므로(같은 탭이 동시에 두 모드일 수 없다) 박스 풀/스타일시트 엘리먼트를 공유해도
// 안전하다.
import { WORD_BOX_STYLE } from '@shared/highlightStyle'
import type { RectPx } from '@shared/extension'

// 화면 줄바꿈에 걸친 세그먼트/단어(예: "当地政府"가 두 줄에 나뉘어 걸림)는 박스 하나가
// 아니라 줄 개수만큼 필요하다(groupRectsByLine 결과) — 풀로 관리해 매번 만들고 지우지
// 않는다.
let boxes: HTMLDivElement[] = []

// 박스를 그릴 문서 — 전역 document 가 기본이지만, 자체 뷰어의 epub 은 epubjs 가 내용을
// iframe 안에 띄우므로 그 iframe 의 문서에 그려야 좌표계(position:fixed 기준)가 맞는다.
// 문서가 바뀌면 기존 박스/스타일은 이전 문서에 속하므로 버리고 새로 만든다.
let docRef: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)

export function setHoverBoxDocument(doc: Document): void {
  if (doc === docRef) return
  for (const el of boxes) el.remove()
  boxes = []
  cursorStyleEl?.remove()
  cursorStyleEl = null
  cursorOverridden = false
  docRef = doc
  doc.addEventListener('fullscreenchange', reattachBoxes)
}

function reattachBoxes(): void {
  for (const el of boxes) boxParent().appendChild(el)
}

// 전체화면 API는 전체화면으로 전환된 엘리먼트(보통 플레이어 div, <html> 전체가 아님)와 그
// 자손만 "top layer"에 그린다 — 박스가 document.documentElement 에 그대로 붙어있으면 그
// top layer 바깥이라 전체화면 중엔 안 보인다(실사용 확인). 지금 전체화면 엘리먼트가 있으면
// 그 안에, 없으면 documentElement 에 붙인다.
function boxParent(): HTMLElement {
  return (docRef.fullscreenElement as HTMLElement | null) ?? docRef.documentElement
}

function createBox(): HTMLDivElement {
  const el = docRef.createElement('div')
  el.className = 'nuance-hover-word-box'
  Object.assign(el.style, {
    position: 'fixed',
    boxSizing: 'border-box',
    border: `${WORD_BOX_STYLE.borderWidth}px solid ${WORD_BOX_STYLE.borderColor}`,
    background: WORD_BOX_STYLE.background,
    borderRadius: `${WORD_BOX_STYLE.borderRadius}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
    display: 'none',
  })
  boxParent().appendChild(el)
  return el
}

// 필요한 개수만큼 박스를 확보한다(부족하면 새로 만들고, 남으면 숨겨서 재사용 대기).
function ensureBoxes(count: number): HTMLDivElement[] {
  while (boxes.length < count) boxes.push(createBox())
  return boxes
}

// 전체화면 진입/해제 시 박스를 새 top layer 대상 안으로 옮긴다(appendChild 는 이미 자식인
// 노드를 다시 넣으면 같은 부모 안에서 이동만 하므로 항상 안전하게 재부착된다). 모듈 로드
// 시 1회만 등록하면 되고, 자막/웹 어느 쪽이 활성이든 그대로 유효하다.
if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', reattachBoxes)

// 박스 자신은 pointerEvents:none 이라 실제 마우스는 밑에 깔린 페이지 요소가 받는다 —
// 그래서 박스에 cursor 를 줘도 반영이 안 되고, 대신 문서 전체 cursor 를 강제해야 한다.
// 조상(html)에 인라인 !important 를 걸어도 자손 요소 자신에게 어떤 값이든(비-important
// 라도) 지정돼 있으면 상속 자체가 발생하지 않아 안 먹힌다(유튜브 진행바 grab, 넷플릭스
// 자체 커서 인라인 지정 등 실사용 확인) — 대신 `*` 전체 선택자에 !important 를 건
// 스타일시트 규칙을 주입하면 각 자손에 직접 매치돼 비-important 인라인 스타일까지 이긴다.
let cursorOverridden = false
let cursorStyleEl: HTMLStyleElement | null = null
function ensureCursorStyle(): HTMLStyleElement {
  if (cursorStyleEl) return cursorStyleEl
  const el = docRef.createElement('style')
  el.textContent = 'html.nuance-hover-pointer, html.nuance-hover-pointer * { cursor: pointer !important; }'
  docRef.documentElement.appendChild(el)
  cursorStyleEl = el
  return el
}
function setHoveringCursor(hovering: boolean): void {
  if (hovering === cursorOverridden) return
  cursorOverridden = hovering
  ensureCursorStyle()
  docRef.documentElement.classList.toggle('nuance-hover-pointer', hovering)
}

export function hideHoverBox(): void {
  for (const el of boxes) el.style.display = 'none'
  setHoveringCursor(false)
}

// rects 는 줄마다 하나씩(groupRectsByLine 결과) — 화면 줄바꿈에 걸친 단어/세그먼트는
// 배열 길이가 2 이상이 된다. 필요한 개수만큼만 보이고 나머지 풀은 숨긴다.
export function showHoverBoxesAt(rects: RectPx[]): void {
  const els = ensureBoxes(rects.length)
  const p = WORD_BOX_STYLE.padding
  rects.forEach((rect, i) => {
    const el = els[i]!
    el.style.left = `${rect.x - p}px`
    el.style.top = `${rect.y - p}px`
    el.style.width = `${rect.width + p * 2}px`
    el.style.height = `${rect.height + p * 2}px`
    el.style.display = 'block'
  })
  for (let i = rects.length; i < els.length; i++) els[i]!.style.display = 'none'
  setHoveringCursor(rects.length > 0)
}
