// 설정 화면 (PLAN.md §3) — 담당 B
// 1.LLM 선택 2.API 키 관리 3.단축키 4.AI 주변 범위(Byte) 5.언어 선택
export function SettingsScreen() {
  return (
    <div className="screen settings-screen">
      <h1>설정</h1>
      <section>{/* 1. LLM 선택: GPT / Gemini / Claude */}</section>
      <section>{/* 2. API 키 관리: 입력·보기·수정·삭제 (safeStorage) */}</section>
      <section>{/* 3. 단축키 설정: 모드 전환 (기본 Alt+Q) */}</section>
      <section>{/* 4. AI 주변 범위: Byte 슬라이더 256~4096 + 미리보기 */}</section>
      <section>{/* 5. 언어 선택: 자동 감지 / 영·일·중 */}</section>
    </div>
  )
}
