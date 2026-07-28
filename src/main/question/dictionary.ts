import type { DictionarySourceId, QuestionResult, SelectionContext } from '@shared/types'

// 담당 B — 사전 검색 (PLAN.md §4.2-2)
// 선택 영역을 단어 단위 분해 → 사전 API 로 각 단어 정보 획득
// → 문맥과 함께 LLM 에 넘겨 "해당 맥락에서 사전상 몇 번 뜻인지" 판정.
// TODO(담당 B): streamLlm 호출 시 user 메시지는 @shared/questionText 의
// DICTIONARY_QUESTION 을 그대로 써야 한다(PopupScreen.tsx 채팅창 라벨과 일치시키기 위함,
// pronunciation.ts 의 PRONUNCIATION_QUESTION 사용 방식 참고).
//
// `forceSource`: en/ja/zh 어댑터가 각자 다른 워크트리에서 병렬 구현 중이라(2026-07-28),
// 팝업의 임시 디버깅 드롭다운(registry.ts 참고)이 고른 소스를 여기로 받는다. 실제 폴백
// 오케스트레이션(이 값이 있으면 그 소스만, 없으면 정식 폴백 순서로 각 어댑터를 호출해
// DictionaryEntry 를 만들고 LLM 판정까지 잇는 것)은 각 어댑터가 merge 된 뒤 별도로 구현 —
// 지금은 스텁이라 받은 값을 그대로 반영하지 않고 자리만 마련해둔다.

export async function lookupDictionary(
  ctx: SelectionContext,
  _forceSource: DictionarySourceId | undefined,
  _onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  // TODO(담당 B): 언어별 사전 API 연동 + LLM 뜻 번호 매핑 + forceSource 반영.
  void ctx
  return { kind: 'dictionary', content: '', meta: {} }
}
