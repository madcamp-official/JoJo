import type { Language, SelectionSource } from '@shared/types'
import { readWindowText } from './accessibility'
import { getSelectedWindowId, getSelectedWindowName } from './capture'
import { detectLanguage } from './langDetect'
import { getBrowserSource } from '../extension/activeTab'

// 확장은 Nuance 에서 어떤 창을 선택했는지와 무관하게 자신이 설치된 브라우저의 활성 탭을
// 계속 보고한다 — 그래서 사용자가 브라우저가 아닌 다른 창을 선택해도(예: 메모장), 배경에
// 크롬이 유튜브를 띄우고 있으면 확장 정보가 그대로 잡혀 잘못 자막 경로로 갈 수 있었다.
// 선택된 창 이름("오너앱 - 창 제목", capture.ts: withOwnerName)이 크롬(계열)인지 확인해서
// 그 경우에만 확장이 보고하는 활성 탭 정보를 신뢰한다.
function selectedWindowIsChrome(): boolean {
  const name = getSelectedWindowName()
  if (!name) return false
  return /^(google chrome|chrome|chromium)\b/i.test(name)
}

// 담당 A/B — 추출 방식 판정 (PLAN.md §4.1 / §7)
// 원칙: 직접 추출 먼저 시도, 텍스트가 부족할 때만 OCR fallback.
// 브라우저(확장 연결)면 활성 탭 URL 로 유튜브/넷플릭스 자막 경로를 우선 분기한다.
// 판정 시점: 선택 모드 진입 시 1회 + URL 변화 시 재판정 (URL 을 캐시 키로).

export interface ExtractionDecision {
  // subtitle = 확장으로 원어 자막 추출(유튜브/넷플릭스 미디어 페이지)
  mode: 'direct' | 'ocr' | 'subtitle'
  source: SelectionSource
  language: Language
}

const cache = new Map<string, ExtractionDecision>() // key: url ?? appName

// 이 미만이면 "의미 있는 텍스트"로 안 보고 OCR 로 폴백한다(빈 EDIT 컨트롤이나
// 검색창 placeholder 같은 잡음성 텍스트를 direct 로 잘못 채택하는 걸 막기 위함).
const MIN_DIRECT_TEXT_LENGTH = 20

export async function decideExtraction(): Promise<ExtractionDecision> {
  const language = await detectLanguage()

  // 브라우저면(확장이 활성 탭을 보고 중, 그리고 선택된 창이 실제로 크롬) URL 로 자막/웹
  // 경로를 먼저 분기한다. 유튜브 동영상·넷플릭스 에피소드 = 확장으로 원어 자막 추출(subtitle).
  const isChrome = selectedWindowIsChrome()
  const browser = isChrome ? getBrowserSource() : null
  console.log(
    `[decideExtraction] selectedWindowIsChrome=${isChrome} browserSource =`,
    browser ? `${browser.source.kind} media=${browser.isMedia}` : 'null(확장 미연결/미보고/선택창이 크롬 아님)',
  )
  if (browser) {
    if (browser.isMedia) {
      return { mode: 'subtitle', source: browser.source, language }
    }
    // 일반 웹페이지: DOM 텍스트 추출은 후속 작업 — 지금은 OCR 로 폴백.
    // (kind 는 web/youtube/netflix 로 유지해 캐싱·디버깅에 쓴다)
    return { mode: 'ocr', source: browser.source, language }
  }

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
