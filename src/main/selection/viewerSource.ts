import { BrowserWindow, Notification } from 'electron'
import type { ExtractedSelection, ViewerWordHit } from '@shared/types'
import { detectSupportedLanguage } from '@shared/languageDetect'
import { getLanguageOverride } from '../settingsStore'
import { createPopupWindow } from '../windows'

// 자체 문서 뷰어(pdf/epub/txt) 클릭 → 팝업. webSource.ts(웹 문단 경로)와 같은 구조다 —
// 뷰어 렌더러가 확장과 동일한 공용 호버 스택(shared/hover)으로 클릭 지점의 절대 오프셋까지
// 다 계산해 보내주므로, 여기서는 ExtractedSelection 으로 감싸 기존 팝업을 띄우기만 한다.

// tier3(미지원 언어)는 팝업 대신 짧은 OS 알림만 — subtitleSource/webSource 와 동일.
function notifyUnsupportedLanguage(): void {
  new Notification({ title: 'Nuance', body: '이 언어는 아직 지원하지 않습니다.' }).show()
}

// null = tier3(미지원 언어) — 호출부가 팝업 대신 알림으로 처리한다.
function buildSelection(hit: ViewerWordHit): ExtractedSelection | null {
  const language = getLanguageOverride() ?? detectSupportedLanguage(hit.text)
  if (language === null) return null
  return {
    text: hit.text,
    anchor: { start: hit.anchorStart, end: hit.anchorEnd },
    words: [],
    language,
    source: { kind: hit.kind, appName: hit.name },
    extraction: 'direct',
  }
}

export function onViewerWordClicked(hit: ViewerWordHit, sender: BrowserWindow | null): void {
  const selection = buildSelection(hit)
  if (selection === null) {
    notifyUnsupportedLanguage()
    return
  }
  if (!selection.text.trim()) return
  const popup = createPopupWindow(selection)
  // 팝업이 닫히면 포커스를 뷰어 창으로 되돌린다 — 확장 경로가 focusTab() 으로 브라우저
  // 탭에 포커스를 돌려주는 것과 같은 이유(OS 가 알아서 되돌려준다는 보장이 없다).
  if (sender && !sender.isDestroyed()) {
    popup.once('closed', () => {
      if (!sender.isDestroyed()) sender.focus()
    })
  }
}
