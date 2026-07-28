import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  EXT_WS_HOST,
  EXT_WS_PORT,
  type AppToExt,
  type ExtActiveTab,
  type ExtToApp,
  type SubtitleSnapshot,
} from '@shared/extension'

// 담당 B — 크롬 확장 브릿지 (Electron main 쪽 WebSocket 서버).
// 확장 background 가 이 서버에 접속해 활성 탭 변화·자막 등을 보내온다.
// 접속은 항상 최신 소켓 1개만 유효(브라우저 하나 기준)로 둔다.

const KEEPALIVE_MS = 20_000 // 서비스 워커는 ~30초 유휴 시 종료됨 — 그 전에 ping 을 보내 살려둔다.

type BridgeEvents = {
  activeTab: [ExtActiveTab | null]
  subtitles: [SubtitleSnapshot | null]
  connected: []
  disconnected: []
}

class ExtensionBridge extends EventEmitter<BridgeEvents> {
  private wss: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private keepalive: NodeJS.Timeout | null = null
  private lastActiveTab: ExtActiveTab | null = null
  private lastSubtitles: SubtitleSnapshot | null = null

  start(): void {
    if (this.wss) return
    const wss = new WebSocketServer({ host: EXT_WS_HOST, port: EXT_WS_PORT })
    this.wss = wss
    wss.on('connection', (ws) => this.onConnection(ws))
    wss.on('error', (err) => console.warn('[ext-bridge] server error:', err.message))
    console.log(`[ext-bridge] listening on ws://${EXT_WS_HOST}:${EXT_WS_PORT}`)
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
    // 재접속 직후 상태를 맞추기 위해 현재 활성 탭을 다시 보고하도록 요청한다.
    this.send({ type: 'requestActiveTab' })
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

  // 선택 모드 진입/이탈 시 확장에 자막 캡처 on/off 를 지시한다.
  setSubtitleCapture(active: boolean): void {
    if (!active) this.lastSubtitles = null
    this.send({ type: 'setSubtitleCapture', active })
  }
}

export const extensionBridge = new ExtensionBridge()

export function startExtensionBridge(): void {
  extensionBridge.start()
}
