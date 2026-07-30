import type { AnyLanguage, SelectionSource } from '@shared/types'
import { getSelectedWindowName } from './capture'
import { detectLanguage } from './langDetect'
import { isPreviewWindowSelected } from './pdfAxSource'
import { activeTabTracker, getBrowserSource, type BrowserSource } from '../extension/activeTab'
import { extensionBridge } from '../extension/bridge'

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

// 담당 A/B — 추출 방식 판정 (PLAN.md §5.1 / §8)
// 원칙: 직접 추출 먼저 시도, 텍스트가 부족할 때만 OCR fallback.
// 브라우저(확장 연결)면 활성 탭 URL 로 유튜브/넷플릭스 자막 경로를 우선 분기한다.
// 판정 시점: 선택 모드 진입 시 1회 + URL 변화 시 재판정 (URL 을 캐시 키로).

export interface ExtractionDecision {
  // subtitle = 확장으로 원어 자막 추출(유튜브/넷플릭스 미디어 페이지)
  // web = 확장으로 일반 웹페이지 본문 DOM 텍스트 추출(비미디어 브라우저 페이지) — 낙관적
  // 판정이라 실제 텍스트 충분 여부는 webSource.ts: startWebMode()가 확인 후 부족하면
  // 스스로 OCR 경로로 넘어간다(§5.1 "텍스트 양으로 분기" 원칙).
  // direct = macOS 미리보기(Preview.app) PDF를 접근성(AX) API로 직접 추출(pdfAxSource.ts)
  mode: 'direct' | 'ocr' | 'subtitle' | 'web'
  source: SelectionSource
  language: AnyLanguage
}

const cache = new Map<string, ExtractionDecision>() // key: url ?? appName

// 크롬 창을 선택한 직후엔 확장의 첫 activeTab 보고(WS 핸드셰이크)가 아직 도착하기 전일 수
// 있다 — 이 짧은 순간에 판정하면 getBrowserSource() 가 null 이라 "브라우저 아님"으로 오판해
// 유튜브/넷플릭스 재생 중에도 OCR 영역 지정 배너가 잠깐 떴다 사라지는 레이스가 있었다
// (사용자 피드백, 2026-07-29 — "가끔씩 OCR 영역 지정 메시지가 뜬다"). 선택된 창이 크롬인
// 게 이미 확실하니, 첫 보고를 이 시간만큼 기다렸다 재확인한다(대부분 수십~수백ms 안에
// 도착 — 이미 도착해 있으면 바로 반환되고 대기 자체가 없다).
const BROWSER_SOURCE_WAIT_MS = 1200

/** 확장의 첫(또는 다음) activeTab 보고를 기다린다 — 이미 있으면 즉시, 없으면 timeoutMs
 *  안에 도착하는 것만 기다리고 그래도 없으면 null(포기, 호출부가 기존처럼 OCR 로 폴백).
 *  확장 자체가 아예 연결돼 있지 않으면(미설치 등) 영원히 안 올 보고를 기다리는 셈이라
 *  매번 크롬 창을 고를 때마다 불필요한 지연이 생긴다 — WS 연결 여부(`isConnected`)부터
 *  확인해 연결 안 됐으면 기다리지 않고 바로 포기한다. */
function waitForBrowserSource(timeoutMs: number): Promise<BrowserSource | null> {
  const immediate = getBrowserSource()
  if (immediate) return Promise.resolve(immediate)
  if (!extensionBridge.isConnected()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const onChange = (next: BrowserSource | null) => {
      clearTimeout(timer)
      resolve(next)
    }
    const timer = setTimeout(() => {
      activeTabTracker.off('change', onChange)
      resolve(getBrowserSource())
    }, timeoutMs)
    activeTabTracker.once('change', onChange)
  })
}

export async function decideExtraction(): Promise<ExtractionDecision> {
  const language = await detectLanguage()

  // 브라우저면(확장이 활성 탭을 보고 중, 그리고 선택된 창이 실제로 크롬) URL 로 자막/웹
  // 경로를 먼저 분기한다. 유튜브 동영상·넷플릭스 에피소드 = 확장으로 원어 자막 추출(subtitle).
  const isChrome = selectedWindowIsChrome()
  const browser = isChrome ? await waitForBrowserSource(BROWSER_SOURCE_WAIT_MS) : null
  console.log(
    `[decideExtraction] selectedWindowIsChrome=${isChrome} browserSource =`,
    browser ? `${browser.source.kind} media=${browser.isMedia}` : 'null(확장 미연결/미보고/선택창이 크롬 아님)',
  )
  if (browser) {
    if (browser.isMedia) {
      return { mode: 'subtitle', source: browser.source, language }
    }
    // 일반 웹페이지: 확장의 범용 본문 탐지로 direct 추출을 우선 시도한다(낙관적 판정).
    // 실제 텍스트가 부족하면 webSource.ts가 스스로 OCR 경로로 넘어간다(shortcut.ts 참고).
    return { mode: 'web', source: browser.source, language }
  }

  // macOS 미리보기(Preview.app)로 연 PDF — 접근성(AX) API 로 텍스트와 좌표를 둘 다 직접
  // 얻을 수 있어 OCR 이 필요 없다(pdfAxSource.ts). 여기서는 창 이름만 보고 낙관적으로
  // 판정하고, 실제로 텍스트가 나오는지(스캔본이면 안 나온다)는 startPdfAxMode 가 확인해
  // 부족하면 스스로 OCR 로 넘어간다 — web 경로(위)와 같은 방식이다.
  if (isPreviewWindowSelected()) {
    return { mode: 'direct', source: { kind: 'pdf' }, language }
  }

  // 표준 텍스트 컨트롤(메모장의 WM_GETTEXT 등) 직접 읽기 경로는 실제로 쓰는 분기가 없어
  // 제거됐다(dev, 7f79b0f — extractionCache.ts 주석 참고: 좌표가 없어 direct 판정 자체가
  // 의미 없었다). PDF(위)는 AX 로 좌표까지 얻으므로 이 문제가 없어 별개로 유지한다.

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
