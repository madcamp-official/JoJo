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
    // url 은 항상 최신으로 유지하되(source.url 메타데이터), 재판정(change)은 추출 방식이
    // 달라질 수 있는 "분류"가 바뀔 때만 낸다 — 같은 유튜브 안에서 동영상만 바뀌면(분류 동일)
    // OCR 여부 결정은 그대로라 재판정하지 않는다(자막 내용은 content script 가 알아서 갱신).
    const changed = classKey(this.current) !== classKey(next)
    this.current = next
    // 탭/URL 은 포커스 전환·SPA 네비게이션마다 자주 바뀌지만, 재판정에 영향을 주는 "분류"가
    // 실제로 바뀔 때만 로그를 남긴다(매번 찍으면 브라우징 중 로그가 너무 시끄러워진다).
    if (changed) {
      console.log('[activeTab]', next ? `${next.source.kind} media=${next.isMedia} ${next.source.url}` : 'null')
      this.emit('change', next)
    }
  }

  get(): BrowserSource | null {
    return this.current
  }
}

// 추출 방식 판정에 영향을 주는 분류 키. isMedia(자막 대상 미디어 페이지)면 기존처럼
// kind|isMedia 로 URL(동영상 id 등)과 무관하게 같은 분류로 본다 — 영상 재생 중 URL이
// 바뀌어도(다음 동영상 등) 자막 내용은 content script 가 알아서 갱신하므로 재판정 불필요.
//
// isMedia가 아니면(일반 웹페이지든, 유튜브/넷플릭스 홈·피드처럼 영상이 아닌 페이지든) URL
// 까지 키에 포함시켜 URL이 바뀔 때마다 재판정이 걸리게 한다 — 이 경우는 전부 mode:'web'
// 경로(decideOcr.ts)로 확장의 DOM 텍스트 추출을 시도하는데, 그 성공 여부는 페이지마다
// 다르므로(웹소설 A→B챕터, 유튜브 홈→구독피드 등) 페이지가 바뀔 때마다 다시 확인해야
// 한다(2026-07-30 사용자 지적 — "텍스트 많은 곳에서 적은 곳으로 이동해도 자동 해제 안 됨").
function classKey(s: BrowserSource | null): string {
  if (!s) return 'none'
  if (!s.isMedia) return `nonmedia|${s.source.url ?? ''}`
  return `${s.source.kind}|${s.isMedia}`
}

export const activeTabTracker = new ActiveTabTracker()

export function startActiveTabTracker(): void {
  activeTabTracker.start()
}

export function getBrowserSource(): BrowserSource | null {
  return activeTabTracker.get()
}
