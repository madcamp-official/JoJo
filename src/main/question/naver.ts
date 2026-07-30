import type { AnyLanguage } from '@shared/types'
import { getNaverDictUrl } from '@shared/languages'

// 담당 B — 네이버 사전 URL 생성. tier2-B(네이버 사전 없음)는 null — 팝업 UI가 애초에
// 이 언어에서 네이버 버튼을 안 보여주므로(Toolbar.tsx) 정상 경로로는 null이 안 나오지만,
// 방어적으로 그대로 흘려보낸다(ipc.ts 가 null이면 새 창을 안 연다).
// 실제 URL 패턴(서브도메인 vs kodict 경로)은 @shared/languages 참고.
// 새 창 열기 공통 로직은 ./browser (google.ts 와 공유).

export function naverDictionaryUrl(text: string, lang: AnyLanguage): string | null {
  return getNaverDictUrl(lang, text)
}
