import type { QuestionResult, SelectionContext } from '@shared/types'

// 담당 B — 사전 검색 (PLAN.md §4.2-2)
// 선택 영역을 단어 단위 분해 → 사전 API 로 각 단어 정보 획득
// → 문맥과 함께 LLM 에 넘겨 "해당 맥락에서 사전상 몇 번 뜻인지" 판정.
// TODO(담당 B): streamLlm 호출 시 user 메시지는 @shared/questionText 의
// DICTIONARY_QUESTION 을 그대로 써야 한다(PopupScreen.tsx 채팅창 라벨과 일치시키기 위함,
// pronunciation.ts 의 PRONUNCIATION_QUESTION 사용 방식 참고).

export async function lookupDictionary(
  ctx: SelectionContext,
  _onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  // TODO(담당 B): 언어별 사전 API 연동 + LLM 뜻 번호 매핑.
  void ctx
  return { kind: 'dictionary', content: '', meta: {} }
}
