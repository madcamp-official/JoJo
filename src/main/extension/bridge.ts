import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  EXT_WS_HOST,
  EXT_WS_PORT,
  type AppToExt,
  type ExtActiveTab,
  type ExtToApp,
  type SubtitleClickMsg,
  type SubtitleSnapshot,
  type TranscriptCue,
  type WordSegment,
} from '@shared/extension'
import { detectCjkLanguage } from '@shared/cjkDetect'
import { segmentChineseWords } from '../nlp/chinese'
import { segmentJapaneseWords } from '../nlp/japanese'

export interface Transcript {
  videoId: string
  cues: TranscriptCue[]
}

// 담당 B — 크롬 확장 브릿지 (Electron main 쪽 WebSocket 서버).
// 확장 background 가 이 서버에 접속해 활성 탭 변화·자막 등을 보내온다.
// 접속은 항상 최신 소켓 1개만 유효(브라우저 하나 기준)로 둔다.

const KEEPALIVE_MS = 20_000 // 서비스 워커는 ~30초 유휴 시 종료됨 — 그 전에 ping 을 보내 살려둔다.

type BridgeEvents = {
  activeTab: [ExtActiveTab | null]
  subtitles: [SubtitleSnapshot | null]
  transcript: [Transcript]
  subtitleClick: [Omit<SubtitleClickMsg, 'type'>]
  connected: []
  disconnected: []
}

class ExtensionBridge extends EventEmitter<BridgeEvents> {
  private wss: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private keepalive: NodeJS.Timeout | null = null
  private lastActiveTab: ExtActiveTab | null = null
  private lastSubtitles: SubtitleSnapshot | null = null
  // videoId별 전체 자막 캐시 — 예전엔 마지막 것 하나만 들고 있었는데(`lastTranscript`),
  // 유튜브↔넷플릭스 탭을 오가면 서로 상대 영상 자막을 덮어써서, 확장 쪽 dedup(content.ts
  // `lastInterceptedSig`/`lastNetflixKey` — "이미 앱에 보냈으니 재전송 스킵")과 맞물려
  // 탭을 되돌아온 뒤엔 그 영상 자막을 앱이 영영 다시 못 받는 구조적 버그가 있었다
  // (2026-07-29 실사용 확정 — 탭 전환 후 팝업에 한 줄만 뜨는 문제의 진짜 원인).
  // videoId별로 따로 저장하면 덮어쓰기 자체가 없어 재전송이 아예 필요 없다.
  private transcripts = new Map<string, Transcript>()
  private lastCaptureActive = false
  // 이미 세그멘테이션을 요청/전송한 자막 줄 텍스트 — subtitles 스냅샷이 자주(폴링 300ms
  // 등) 갱신되므로 같은 줄을 반복해서 재분석하지 않는다.
  private segmentedLines = new Set<string>()

  start(): void {
    if (this.wss) return
    const wss = new WebSocketServer({ host: EXT_WS_HOST, port: EXT_WS_PORT })
    this.wss = wss
    wss.on('connection', (ws) => this.onConnection(ws))
    // 실제로 리슨 시작(바인딩 성공)한 시점에만 찍는다 — 실패면 error 가 대신 뜬다.
    wss.on('listening', () =>
      console.log(`[ext-bridge] listening on ws://${EXT_WS_HOST}:${EXT_WS_PORT} (확장 접속 대기)`),
    )
    wss.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[ext-bridge] 서버 시작 실패: ${err.code ?? ''} ${err.message}`)
      // 포트 충돌(EADDRINUSE) 등은 이전 앱 인스턴스가 안 죽었을 때 잘 난다.
    })
  }

  private onConnection(ws: WebSocket): void {
    // 새 접속이 오면 이전 소켓은 버린다(브라우저 하나 = 소켓 하나 유지).
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close()
      } catch {
        /* 무시 */
      }
    }
    this.socket = ws

    ws.on('message', (data) => this.onMessage(ws, data.toString()))
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null
        this.stopKeepalive()
        this.lastActiveTab = null
        this.emit('disconnected')
        this.emit('activeTab', null)
      }
    })
    ws.on('error', (err) => console.warn('[ext-bridge] socket error:', err.message))

    this.startKeepalive()
    this.emit('connected')
    console.log('[ext-bridge] 확장 연결됨')
    // 재접속 직후 상태를 맞추기 위해 현재 활성 탭을 다시 보고하도록 요청한다.
    this.send({ type: 'requestActiveTab' })
    // 재접속한 확장(background 서비스 워커 재시작 포함)은 자막 캡처 desired 상태를 모른다
    // (background.ts captureDesired 는 기본 false로 초기화됨) — 앱이 이미 자막 모드였다면
    // (selection/subtitleSource.ts startSubtitleMode 는 active 가 이미 true면 재전송을
    // 생략함) 여기서 다시 알려주지 않으면 hover 하이라이트가 영영 안 켜진다.
    if (this.lastCaptureActive) this.send({ type: 'setSubtitleCapture', active: true })
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ExtToApp
    try {
      msg = JSON.parse(raw) as ExtToApp
    } catch {
      console.warn('[ext-bridge] bad message:', raw.slice(0, 120))
      return
    }
    switch (msg.type) {
      case 'hello':
        this.sendTo(ws, { type: 'welcome' })
        break
      case 'pong':
        break
      case 'activeTab':
        this.lastActiveTab = msg.tab
        this.emit('activeTab', msg.tab)
        break
      case 'subtitles':
        this.lastSubtitles = msg.snapshot
        this.emit('subtitles', msg.snapshot)
        this.requestWordSegments(msg.snapshot?.lines.map((l) => l.text) ?? [])
        break
      case 'transcript': {
        const transcript: Transcript = { videoId: msg.videoId, cues: msg.cues }
        // 같은 videoId 재수신 시 최신으로 갱신(자막 언어 전환 등) — delete 후 set 으로
        // Map 삽입 순서를 "최근 수신 순"으로 유지한다(buildContextWindow 가 최근 것부터
        // 검색). Map 크기는 세션 중 방문한 영상 수만큼만 자라므로 별도 상한은 없다.
        this.transcripts.delete(msg.videoId)
        this.transcripts.set(msg.videoId, transcript)
        console.log(`[ext-bridge] transcript 수신: ${msg.cues.length} cues (video=${msg.videoId})`)
        this.emit('transcript', transcript)
        break
      }
      case 'subtitleClick':
        this.emit('subtitleClick', {
          word: msg.word,
          lineText: msg.lineText,
          wordOffsetInLine: msg.wordOffsetInLine,
          currentTime: msg.currentTime,
          videoId: msg.videoId,
        })
        break
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepalive = setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS)
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }

  private sendTo(ws: WebSocket, msg: AppToExt): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  send(msg: AppToExt): void {
    if (this.socket) this.sendTo(this.socket, msg)
  }

  isConnected(): boolean {
    return this.socket !== null
  }

  getActiveTab(): ExtActiveTab | null {
    return this.lastActiveTab
  }

  getSubtitles(): SubtitleSnapshot | null {
    return this.lastSubtitles
  }

  getTranscript(videoId: string): Transcript | null {
    return this.transcripts.get(videoId) ?? null
  }

  // CJK 자막 줄을 감지해 앱의 zh/ja 세그멘터로 분석한 뒤 확장에 내려준다 — 브라우저는
  // 공백 없는 CJK 텍스트를 글자 단위로만 쪼갤 수 있어서(youtube.ts), hover 박스를 실제
  // 단어 단위로 묶으려면 형태소 분석 결과가 필요하다(highlight.ts). 새로 보이는 줄에
  // 대해서만 1회 요청한다.
  private requestWordSegments(lineTexts: string[]): void {
    for (const text of lineTexts) {
      if (!text || this.segmentedLines.has(text)) continue
      // CJK(ja/zh)가 아니면 세그멘테이션 불필요 — 라틴 등은 브라우저의 공백 기준
      // 단어 분리로 이미 충분하다.
      const lang = detectCjkLanguage(text)
      if (!lang) continue
      this.segmentedLines.add(text)
      void this.segmentAndSend(text, lang)
    }
  }

  // 화면에 뜬 한 줄(lineText)이 속한 cue를 전체 자막 캐시(transcripts)에서 찾아 앞뒤 cue까지
  // 묶은 "문맥 윈도우" 텍스트를 만든다 — 형태소 분석기(스다치 등)는 Viterbi/lattice 방식이라
  // 주변 문맥에 따라 같은 글자열도 다르게 쪼갤 수 있다. 팝업은 이미 앞뒤 문맥이 다 붙은 긴
  // 텍스트를 통째로 분석하는데(popup/selection.ts), hover 세그멘테이션이 화면에 뜬 그 줄만
  // 따로 분석하면 서로 다른 경계가 나올 수 있었다(2026-07-29 사용자 제보 — 팝업에선
  // "ひとつ"가 한 단어로, 자막 hover에선 "ひと/つ"로 나뉘던 문제). 못 찾으면 null(줄만 분석
  // 하는 기존 폴백으로).
  private buildContextWindow(lineText: string): { windowText: string; lineOffset: number } | null {
    // 이 줄이 어느 영상 것인지 여기서는 모른다 — 캐시된 transcript 전체에서 lineText를
    // 포함하는 cue가 있는 것을 찾는다(최근 수신 순으로, Map은 삽입 순서 유지라 뒤에서부터).
    let cues: TranscriptCue[] | null = null
    let idx = -1
    for (const t of [...this.transcripts.values()].reverse()) {
      const i = t.cues.findIndex((c) => c.text.includes(lineText))
      if (i >= 0) {
        cues = t.cues
        idx = i
        break
      }
    }
    if (!cues) return null
    const WINDOW_RADIUS = 3 // 앞뒤 몇 cue까지 포함할지 — 팝업 문맥(앞뒤 2줄)보다 넉넉히 잡음
    const from = Math.max(0, idx - WINDOW_RADIUS)
    const to = Math.min(cues.length, idx + WINDOW_RADIUS + 1)
    let windowText = ''
    let lineOffset = -1
    for (let i = from; i < to; i++) {
      if (i === idx) {
        const within = cues[i]!.text.indexOf(lineText)
        lineOffset = windowText.length + (within >= 0 ? within : 0)
      }
      windowText += cues[i]!.text
      if (i < to - 1) windowText += ' '
    }
    return lineOffset >= 0 ? { windowText, lineOffset } : null
  }

  private async segmentAndSend(text: string, lang: 'ja' | 'zh-Hans' | 'zh-Hant'): Promise<void> {
    try {
      // ja는 원시 형태소(tokenizeJapanese)가 아니라 segmentJapaneseWords(OCR 단어 분리와
      // 동일 — JA_ENGINE에 맞는 mergeJaTokens/mergeJaTokensUnidic으로 문절 단위까지 병합)를
      // 써야 한다 — 팝업의 atom 경계(popup/selection.ts mergeJaTokensForEngine)와 동일한
      // 기준이어야, hover 박스에서 묶이는 단위와 클릭 후 팝업에서 묶이는 단위가 일치한다.
      // 원시 토큰을 그대로 쓰면 "食べられちゃった"가 자막에선 食べ/られちゃっ/た로 쪼개져
      // 보이는데 팝업에선 하나로 묶여 나오는 불일치가 생겼다(2026-07-29 사용자 제보).
      const ctxWindow = this.buildContextWindow(text)
      const targetText = ctxWindow?.windowText ?? text
      const lineOffset = ctxWindow?.lineOffset ?? 0

      const rawWords: WordSegment[] =
        lang === 'ja'
          ? (await segmentJapaneseWords(targetText)).map((t) => ({ start: t.start, end: t.end }))
          : (await segmentChineseWords(targetText, lang)).map((w) => ({ start: w.start, end: w.end }))

      // 문맥 윈도우 기준 offset을 화면 줄(text) 기준으로 되돌린다 — 윈도우 밖으로 걸치는
      // 세그먼트는 줄 경계로 잘라내고, 아예 줄과 안 겹치면 버린다.
      const words: WordSegment[] = rawWords
        .filter((w) => w.end > lineOffset && w.start < lineOffset + text.length)
        .map((w) => ({
          start: Math.max(0, w.start - lineOffset),
          end: Math.min(text.length, w.end - lineOffset),
        }))
        .filter((w) => w.end > w.start)

      // 분석 결과가 비어도(엔진이 그 줄을 통째로 못 쪼갠 경우 등) segmentedLines 에 남겨두면
      // hover 는 그 줄에 대해 영원히 글자 단위로 고정된다 — 다음에 같은 줄이 다시 보일 때
      // 재시도할 수 있게 표시를 지운다(2026-07-29 사용자 제보로 발견).
      if (words.length === 0) {
        this.segmentedLines.delete(text)
        return
      }
      this.send({ type: 'wordSegments', lineText: text, words })
    } catch (err) {
      console.warn('[ext-bridge] 자막 줄 세그멘테이션 실패:', (err as Error)?.message)
      // 실패도 마찬가지로 재시도 가능하게 표시를 지운다.
      this.segmentedLines.delete(text)
    }
  }

  // 선택 모드 진입/이탈 시 확장에 자막 캡처 on/off 를 지시한다. desired 상태를 기억해뒀다가
  // 재접속 시(onConnection) 다시 알려준다 — 그렇지 않으면 재시작된 확장 background 는
  // 이 상태를 모른 채 기본값(off)으로 남는다.
  setSubtitleCapture(active: boolean): void {
    this.lastCaptureActive = active
    if (!active) this.lastSubtitles = null
    this.send({ type: 'setSubtitleCapture', active })
  }

  // 팝업 열림/닫힘에 맞춰 영상 재생/일시정지를 지시한다.
  setVideoPlayback(play: boolean): void {
    this.send({ type: 'setVideoPlayback', play })
  }

  // 팝업(Electron 창)이 닫힌 뒤 원래 캡처 중이던 브라우저 탭/창에 OS 포커스를 되돌린다.
  focusTab(): void {
    this.send({ type: 'focusTab' })
  }
}

export const extensionBridge = new ExtensionBridge()

export function startExtensionBridge(): void {
  extensionBridge.start()
}
