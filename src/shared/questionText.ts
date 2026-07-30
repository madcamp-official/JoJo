// 공동 소유 — main(question/*.ts)이 LLM에 보내는 실제 user 메시지와
// renderer(PopupScreen.tsx)가 채팅창에 표시하는 사용자 말풍선이 같은 문구를 쓰도록 공유.
export const PRONUNCIATION_QUESTION = '[선택된 표현]의 문맥상 발음은?'

// PopupScreen.tsx 채팅창의 사용자 말풍선 라벨 전용(사전 버튼을 누르면 이 문구가 채팅에 남는다).
// question/dictionary.ts 는 pronunciation.ts 와 달리 이 문구를 LLM 에 그대로 보내지 않는다
// — LLM 에겐 번호 매긴 뜻풀이 후보 목록을 따로 만들어 보내고 번호만 판정시키므로, 이 상수는
// 채팅창 라벨(사람이 보는 질문 문구)로만 쓰인다.
export const DICTIONARY_QUESTION = '[선택된 표현]의 문맥상 사전적 의미는?'
