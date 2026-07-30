import { Notification } from 'electron'
import type { ExtractedSelection } from '@shared/types'
import { detectSupportedLanguage } from '@shared/languageDetect'
import { MIN_WEB_TEXT_LENGTH } from '@shared/extension'
import { extensionBridge } from '../extension/bridge'
import { getBrowserSource } from '../extension/activeTab'
import { getLanguageOverride } from '../settingsStore'
import { createPopupWindow, sendOverlayWords } from '../windows'

// 담당 milleion — 일반 웹페이지(뉴스·웹소설 등) 본문 DOM 텍스트 추출 경로(OCR 대체).
// 유튜브/넷플릭스 자막 경로(subtitleSource.ts)와 완전히 동일한 구조를 따른다: hover
// 하이라이트와 클릭은 확장이 페이지 안에서 직접 처리하고(articleHighlight.ts), 앱은 클릭
// 이벤트만 받아 ExtractedSelection 을 만들어 팝업을 연다. 자막과 다른 점: 확장이 본문
// 조립을 이미 끝내고 클릭 지점의 절대 오프셋까지 계산해서 보내므로(webArticle.ts
// extractArticleText), 앱 쪽에서 subtitleSource.ts의 anchorInTranscript 같은 별도 텍스트
// 검색이 필요 없다 — 받은 값을 그대로 anchor 로 쓰면 된다.

let active = false
let unsubscribeClick: (() => void) | null = null
// 팝업이 떠 있는 동안 OS 포커스가 Electron으로 넘어갔다가, 닫혀도 원래 브라우저 창으로
// 자동으로 돌아온다는 보장이 없다(특히 macOS는 다음 앱을 임의로 고를 수 있음 —
// subtitleSource.ts와 동일한 이유). 팝업이 뜰 때마다 'closed' 리스너를 새로 달면 팝업
// 재사용(같은 창에서 다른 단어 클릭) 시 리스너가 계속 쌓이므로, 자막 경로와 동일하게
// 한 번만 등록해두고 닫힐 때 플래그를 초기화한다(2026-07-30 사용자 요청).
let focusReturnRegistered = false
// startWebMode 호출마다 올리는 세대값. pageReady 응답/타임아웃이 도착했을 때 그 사이
// stopWebMode 나 새 startWebMode 호출로 무효화됐으면(선택 모드 이탈, 재판정 등) 무시한다
// — shortcut.ts의 decisionEpoch 와 동일한 이유의 동일한 패턴.
let epoch = 0

export function isWebModeActive(): boolean {
  return active
}

// 확장에 본문 캡처를 요청한 뒤, pageReady 응답을 최대 PAGE_READY_WAIT_MS 만큼 기다린다.
// 텍스트가 충분하면(webArticle.ts MIN_WEB_TEXT_LENGTH 이상) 클릭 리스너를 켜고 웹 모드로
// 전환한다. 부족하거나 응답이 안 오면(확장 미설치, 페이지 미주입 등) onInsufficientText()
// 를 호출해 호출부(shortcut.ts)가 기존 OCR 경로로 넘어가게 한다. 이 "요청 후 타임아웃까지
// 대기" 패턴은 subtitleSource.ts의 waitForMatchingTranscript/decideOcr.ts의
// waitForBrowserSource와 동일한 idiom이다(새 WS 요청/응답 프로토콜을 새로 만들지 않음).
const PAGE_READY_WAIT_MS = 1200

export function startWebMode(onInsufficientText: () => void): void {
  if (active) return
  const myEpoch = ++epoch
  extensionBridge.setPageCapture(true)

  const onReady = (report: { url: string; textLength: number }): void => {
    clearTimeout(timer)
    extensionBridge.off('pageReady', onReady)
    if (myEpoch !== epoch) return
    if (report.textLength < MIN_WEB_TEXT_LENGTH) {
      extensionBridge.setPageCapture(false)
      onInsufficientText()
      return
    }
    active = true
    // "텍스트 추출 중..." 배너는 OCR 경로 확정 시에만 뜨므로(2026-07-30, subtitleSource.ts
    // 동일 주석 참고) 웹 경로에선 애초에 뜨지 않지만, onExtractionWords 핸들러가
    // words/needsRegion 상태도 같이 정리하므로 빈 배열을 그대로 보내 그 배선을 재사용한다
    // (오버레이 자체 하이라이트도 안 그리게 되는 효과를 겸함 — hover는 확장이 그림).
    sendOverlayWords([])
    const handler = (hit: PageClickHit): void => void onPageClick(hit)
    extensionBridge.on('pageClick', handler)
    unsubscribeClick = () => extensionBridge.off('pageClick', handler)
  }

  const timer = setTimeout(() => {
    extensionBridge.off('pageReady', onReady)
    if (myEpoch !== epoch) return
    extensionBridge.setPageCapture(false)
    onInsufficientText()
  }, PAGE_READY_WAIT_MS)

  extensionBridge.on('pageReady', onReady)
}

export function stopWebMode(): void {
  epoch++ // 대기 중이던 startWebMode 콜백(있다면)을 무효화
  if (!active) return
  active = false
  unsubscribeClick?.()
  unsubscribeClick = null
  extensionBridge.setPageCapture(false)
}

interface PageClickHit {
  text: string
  anchorStart: number
  anchorEnd: number
  url: string
}

// subtitleSource.ts와 동일한 이유로(2026-07-30, 언어 tier 확장) tier3(미지원 언어)는
// 팝업 대신 짧은 OS 알림만 띄운다.
function notifyUnsupportedLanguage(): void {
  new Notification({ title: 'Nuance', body: '이 언어는 아직 지원하지 않습니다.' }).show()
}

function onPageClick(hit: PageClickHit): void {
  const selection = buildSelection(hit)
  if (selection === null) {
    notifyUnsupportedLanguage()
    return
  }
  if (!selection.text.trim()) return
  const win = createPopupWindow(selection)
  if (!focusReturnRegistered) {
    focusReturnRegistered = true
    win.once('closed', () => {
      focusReturnRegistered = false
      // 팝업이 뜨는 동안 OS 포커스가 Electron으로 넘어갔다가, 닫혀도 OS가 원래 브라우저
      // 창으로 자동으로 되돌려준다는 보장이 없다 — 캡처 중이던 탭/창에 명시적으로 포커스를
      // 되돌려달라고 확장에 요청한다(subtitleSource.ts와 동일한 메커니즘, 같은
      // pageCapturedTabId 를 추적하는 확장이 처리).
      extensionBridge.focusTab()
    })
  }
}

// null = tier3(미지원 언어) — 호출부가 팝업 대신 토스트로 처리한다.
function buildSelection(hit: PageClickHit): ExtractedSelection | null {
  const source = getBrowserSource()?.source ?? { kind: 'web' as const, url: hit.url }
  const language = getLanguageOverride() ?? detectSupportedLanguage(hit.text)
  if (language === null) return null
  return {
    text: hit.text,
    anchor: { start: hit.anchorStart, end: hit.anchorEnd },
    words: [],
    language,
    source,
    extraction: 'direct',
  }
}
