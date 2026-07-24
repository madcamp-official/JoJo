// 팝업 화면 (PLAN.md §3 / §4.2) — 담당 B
// 상단 원문 문맥 → 툴바(발음·사전 체크박스 / 입력 / 구글 발음·이미지) → AI 채팅 → 자주 쓰는 질문
export function PopupScreen() {
  return (
    <div className="screen popup-screen">
      <div className="context">{/* 선택된 원문 문맥 표시 */}</div>
      <div className="toolbar">
        {/* LLM 아이콘 · [발음]·[사전 검색] 체크박스 · [입력] · [G 발음]·[G 이미지] */}
      </div>
      <div className="chat">{/* 질문/답변 말풍선 + 입력창 */}</div>
      <div className="frequent">{/* 자주 쓰는 질문 목록 (등록·수정·삭제) */}</div>
    </div>
  )
}
