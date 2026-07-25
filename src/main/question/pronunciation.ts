import type { QuestionResult, SelectionContext } from '@shared/types'

// 담당 B — 발음 (PLAN.md §4.2-1)
// 영: IPA / 일: 히라가나 / 중: 한어병음. 맥락 의존 발음을 LLM 으로 판정.
// 예) read(현재/과거), 後(あと/ご/のち), 得(de/dé/děi)

export async function getPronunciation(
  ctx: SelectionContext,
  _onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  // TODO(담당 B): 문맥 포함 프롬프트로 맥락상 발음 획득.
  void ctx
  return { kind: 'pronunciation', content: '', meta: {} }
}
