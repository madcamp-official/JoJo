import { EventEmitter } from 'node:events'
import type { SelectionSource, SourceKind } from '@shared/types'
import { extensionBridge } from './bridge'
import type { ExtActiveTab } from '@shared/extension'

// 담당 B — 브라우저 활성 탭 추적 + URL 분류.
// 확장(bridge)이 보고하는 활성 탭을 받아 유튜브/넷플릭스/일반 웹으로 분류하고,
// 원어 자막을 추출할 수 있는 "미디어 재생 페이지"(유튜브 /watch, 넷플릭스 /watch/)인지
// 판정한다. 탭이 바뀌면 change 이벤트를 내보내 선택 모드 재판정에 쓴다.

export interface BrowserSource {
  source: SelectionSource // kind: youtube | netflix | web + url
  /** 원어 자막 추출 대상 페이지인지(유튜브 동영상/넷플릭스 에피소드). false 면 자막 없음 → OCR/웹 경로. */
  isMedia: boolean
}

export function classifyBrowserUrl(rawUrl: string): BrowserSource {
  let host = ''
  let pathname = ''
  let search = ''
  try {
    const u = new URL(rawUrl)
    host = u.hostname
    pathname = u.pathname
    search = u.search
  } catch {
    return { source: { kind: 'web', url: rawUrl }, isMedia: false }
  }

  let kind: SourceKind = 'web'
  let isMedia = false
  if (host.endsWith('youtube.com')) {
    kind = 'youtube'
    // 동영상 페이지: /watch?v=... (모바일/일반), 또는 /shorts/, /live/, /embed/
    isMedia =
      (pathname === '/watch' && /[?&]v=/.test(search)) ||
      pathname.startsWith('/shorts/') ||
      pathname.startsWith('/live/') ||
      pathname.startsWith('/embed/')
  } else if (host === 'youtu.be') {
    kind = 'youtube'
    isMedia = pathname.length > 1
  } else if (host.endsWith('netflix.com')) {
    kind = 'netflix'
    isMedia = pathname.startsWith('/watch/')
  }

  return { source: { kind, url: rawUrl }, isMedia }
}

type Events = {
  change: [BrowserSource | null]
}

class ActiveTabTracker extends EventEmitter<Events> {
  private current: BrowserSource | null = null
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    extensionBridge.on('activeTab', (tab) => this.onActiveTab(tab))
  }

  private onActiveTab(tab: ExtActiveTab | null): void {
    const next = tab ? classifyBrowserUrl(tab.url) : null
    if (sameSource(this.current, next)) return
    this.current = next
    this.emit('change', next)
  }

  get(): BrowserSource | null {
    return this.current
  }
}

function sameSource(a: BrowserSource | null, b: BrowserSource | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.source.url === b.source.url && a.isMedia === b.isMedia
}

export const activeTabTracker = new ActiveTabTracker()

export function startActiveTabTracker(): void {
  activeTabTracker.start()
}

export function getBrowserSource(): BrowserSource | null {
  return activeTabTracker.get()
}
