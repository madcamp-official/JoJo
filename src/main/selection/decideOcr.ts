import type { Language, SelectionSource } from '@shared/types'
import { readWindowText } from './accessibility'
import { getSelectedWindowId } from './capture'
import { detectLanguage } from './langDetect'

// 담당 A — OCR 사용 여부 판정 (PLAN.md §4.1 / §7)
// 원칙: 직접 추출 먼저 시도, 텍스트가 부족할 때만 OCR fallback.
// 판정 시점: 선택 모드 진입 시 1회 + URL 변화 시 재판정 (URL 을 캐시 키로).

export interface ExtractionDecision {
  mode: 'direct' | 'ocr'
  source: SelectionSource
  language: Language
}

const cache = new Map<string, ExtractionDecision>() // key: url ?? appName

// 이 미만이면 "의미 있는 텍스트"로 안 보고 OCR 로 폴백한다(빈 EDIT 컨트롤이나
// 검색창 placeholder 같은 잡음성 텍스트를 direct 로 잘못 채택하는 걸 막기 위함).
const MIN_DIRECT_TEXT_LENGTH = 20

export async function decideExtraction(): Promise<ExtractionDecision> {
  const language = await detectLanguage()

  // 표준 텍스트 컨트롤(메모장 등)이면 OCR 없이 바로 정확한 텍스트를 얻을 수 있다 —
  // 브라우저·PDF 뷰어처럼 캔버스에 그리는 앱은 여기서 안 잡히고 OCR 로 자연스럽게 폴백.
  // readWindowText 는 Windows 전용(WM_GETTEXT)이고, 창 id 도 Windows 에서만 숫자 hwnd 다.
  // macOS 의 desktopCapturer id 는 "window:7805:0" 형태라 BigInt 변환이 불가 → win32 에서만 시도.
  const id = getSelectedWindowId()
  if (id && process.platform === 'win32') {
    const text = await readWindowText(BigInt(id))
    if (text && text.trim().length >= MIN_DIRECT_TEXT_LENGTH) {
      return { mode: 'direct', source: { kind: 'txt' }, language }
    }
  }

  // TODO(담당 A):
  //  1) 활성 대상 식별 (브라우저=확장)로 source·url 파악, youtube·netflix 등 분기
  //  2) 전자책 뷰어 등 접근성 API 로 못 읽히는 나머지 direct 소스(epub/pdf 파일 등)
  //  3) pdf·web → 추출 텍스트 양으로 direct vs ocr 분기 (판정 캐싱: url 키)
  const source: SelectionSource = { kind: 'ocr' }
  const decision: ExtractionDecision = { mode: 'ocr', source, language }
  if (source.url) cache.set(source.url, decision)
  return decision
}

export function invalidate(urlKey: string): void {
  cache.delete(urlKey)
}
