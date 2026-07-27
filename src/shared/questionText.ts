// 공동 소유 — main(question/*.ts)이 LLM에 보내는 실제 user 메시지와
// renderer(PopupScreen.tsx)가 채팅창에 표시하는 사용자 말풍선이 같은 문구를 쓰도록 공유.
export const PRONUNCIATION_QUESTION = '[선택된 표현]의 문맥상 발음은?'

// 사전 검색 LLM 연동(question/dictionary.ts, 아직 스텁)이 구현되면 streamLlm 의 user
// 메시지로 이 상수를 그대로 써야 한다 — PopupScreen.tsx 채팅창 라벨과 일치시키기 위함.
export const DICTIONARY_QUESTION = '[선택된 표현]의 문맥상 사전적 의미는?'
