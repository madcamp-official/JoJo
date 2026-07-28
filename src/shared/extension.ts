// 공동 소유 — 크롬 확장 ↔ Electron 앱 WebSocket 프로토콜.
// native messaging 대신 로컬 WebSocket 을 쓴다(호스트 매니페스트 OS별 등록 불필요, TODO.md 참고).
// main(ws 서버)과 확장(ws 클라이언트) 둘 다 이 파일을 import 하므로 런타임 의존성 없이
// 타입·상수만 둔다. 확장 번들(esbuild)은 build-extension.mjs 의 @shared alias 로 이 파일을 찾는다.

// 앱이 여는 로컬 WS 서버 주소. 확장은 여기로 접속한다. 127.0.0.1 로 고정해 외부 노출을 막는다.
export const EXT_WS_HOST = '127.0.0.1'
export const EXT_WS_PORT = 17673
export function extWsUrl(): string {
  return `ws://${EXT_WS_HOST}:${EXT_WS_PORT}`
}

// 브라우저 활성 탭 정보 — 탭/URL 변화 감지 통지에 실린다(decideOcr 재판정용).
export interface ExtActiveTab {
  tabId: number
  url: string
  title?: string
}

// 뷰포트 기준 CSS 픽셀 사각형(getBoundingClientRect 값). 앱에서 브라우저 창 좌표계로 보정한다.
export interface RectPx {
  x: number
  y: number
  width: number
  height: number
}

export interface SubWord {
  text: string
  rect: RectPx // 뷰포트 기준 단어 사각형
}

export interface SubLine {
  text: string
  words: SubWord[]
}

// 현재 화면에 떠 있는 자막 한 프레임 + 좌표.
export interface SubtitleSnapshot {
  lines: SubLine[]
  viewport: {
    width: number
    height: number
    dpr: number
    // 브라우저 창 좌상단 → 뷰포트(콘텐츠 영역) 좌상단 오프셋(CSS px). 오버레이가 창에
    // 정렬돼 있으므로 뷰포트 좌표에 이 값만 더하면 오버레이 로컬 좌표가 된다.
    // 전체화면/극장모드에선 크롬이 사라져 0 에 수렴한다.
    chromeLeft: number
    chromeTop: number
  }
  currentTime: number // 영상 재생 위치(초) — 전체 자막에서 현재 자막(클릭 기준)을 찾는 기준
}

// timedtext 전체 자막 한 줄(cue). 앱이 이걸 이어붙여 팝업 문맥(전체 텍스트)을 만들고,
// 팝업이 설정 바이트(contextBytesBefore/After)만큼 선택 앞뒤를 보여준다.
export interface TranscriptCue {
  start: number // 시작 시각(초)
  text: string
}

// 확장 → 앱
export type ExtToApp =
  | { type: 'hello'; version: string } // 접속 직후 핸드셰이크
  | { type: 'pong' } // keepalive 응답(서비스 워커 생존 유지 겸)
  | { type: 'activeTab'; tab: ExtActiveTab | null } // 활성 탭 변화(없으면 null)
  | { type: 'subtitles'; snapshot: SubtitleSnapshot | null } // 화면 자막 프레임 갱신(사라지면 null)
  | { type: 'transcript'; videoId: string; cues: TranscriptCue[] } // 영상 전체 자막(로드 완료 시 1회)

// 앱 → 확장
export type AppToExt =
  | { type: 'welcome' } // 핸드셰이크 응답
  | { type: 'ping' } // keepalive
  | { type: 'requestActiveTab' } // 현재 활성 탭을 다시 보고하라(재접속 직후 등)
  | { type: 'setSubtitleCapture'; active: boolean } // 자막 캡처 on/off(선택 모드 진입/이탈 시)
  | { type: 'setVideoPlayback'; play: boolean } // 영상 재생/일시정지(팝업 열림=정지, 닫힘=재생)

export type ExtMessage = ExtToApp | AppToExt
