// 공동 소유 — IPC 채널 상수 (PLAN.md §9 통합 지점)
// A→B: selection:extracted / B: question:request, question:stream

export const IPC = {
  // 창 선택 / 모드 (담당 A)
  WINDOW_LIST: 'window:list',
  SELECT_WINDOW: 'window:select',
  WINDOW_SELECTED: 'window:selected',
  GET_SELECTED_WINDOW_ID: 'window:getSelectedId',
  GET_MODE: 'mode:get',
  MODE_CHANGED: 'mode:changed',
  OVERLAY_SET_INTERACTIVE: 'overlay:setInteractive',
  // macOS 전용 커서 위치 통지(2026-07-30) — 클릭스루 상태(setIgnoreMouseEvents(true))의
  // 오버레이는 win32에선 forward:true 로 mousemove 가 렌더러까지 전달되지만, mac에선
  // 이 forwarding 이 실제로 동작하지 않아 hover 판정이 아예 안 돌았다(실사용 확인 —
  // 호버 박스가 커서를 안 따라오고, interactive 전환이 안 돼 커서 모양도 안 바뀜).
  // 메인이 커서 위치를 폴링(windows.ts)해 오버레이-로컬 좌표로 보내주면 렌더러
  // (Overlay.tsx)가 mousemove 와 동일하게 hover 판정에 쓴다.
  OVERLAY_CURSOR: 'overlay:cursor',
  // 선택 모드 진입 시 미리 캐시된 단어 bbox 목록을 오버레이로 통지 (extractionCache.ts)
  EXTRACTION_WORDS: 'selection:words',
  // 추출 진행 알림 1단계("언어 감지 & 텍스트 영역 탐지") — 선택 모드 진입, 리사이즈,
  // 화면 내용 변화 감지로 재추출이 시작될 때 오버레이에 표시를 띄운다(changeWatcher.ts,
  // Overlay.tsx 의 모드 진입 effect). 언어 감지가 끝나고 실제 OCR 이 시작되면
  // EXTRACTION_OCR_STARTED 가 2단계("텍스트 추출")로 문구를 넘기고, 끝나면
  // EXTRACTION_WORDS 가 표시를 끈다.
  EXTRACTION_STARTED: 'selection:extractionStarted',
  // 추출 진행 알림 2단계 — 언어 감지 완료 후 실제 OCR 을 시작하는 시점(extractionCache.ts).
  EXTRACTION_OCR_STARTED: 'selection:extractionOcrStarted',
  // OCR 대상 영역 지정 — 선택 모드 진입 시 영역이 없으면 메인이 오버레이에 드래그
  // 선택을 요청하고(REGION_SELECTION_NEEDED), 오버레이가 드래그 완료 시 그 영역을
  // 돌려준다(SUBMIT_REGION). OVERLAY_NOTICE 는 리사이즈로 영역이 무효화됐을 때 같은
  // 배너로 안내 문구를 띄우는 범용 채널.
  REGION_SELECTION_NEEDED: 'region:selectionNeeded',
  SUBMIT_REGION: 'region:submit',
  OVERLAY_NOTICE: 'overlay:notice',
  // OCR이 텍스트를 추출한 영역(블록/열 단위)을 오버레이에 반투명 사각형으로 보여준다
  // (extractionCache.ts, Overlay.tsx). 원래 개발 전용 디버그였으나(2026-07-28), 텍스트
  // 영역 자동 탐지 설정(autoDetectRegion, 2026-07-29)의 결과 시각화로 실사용 기능이 됐다
  // — 자동 탐지로 잡힌 영역일 때만 보내고(설정 OFF 이거나 사용자가 수동으로 영역을
  // 지정했으면 안 보냄), 개발 모드에서는 그 조건과 무관하게 항상 보낸다(디버깅용).
  DEBUG_BLOCKS: 'debug:blocks',

  // 실험용 브랜치(experiment/doclayout-yolo) — DocLayout-YOLO/PaddleOCR
  // Python 엔진 예열 상태. 앱 시작 시 백그라운드로 예열을 시작하는데(main/index.ts),
  // 다 끝나기 전에 사용자가 창 선택을 누르면 첫 선택 모드 진입 때 예열 대기 시간을
  // 그대로 겪게 된다 — 그래서 예열 중엔 창 선택 버튼을 막고 안내를 보여준다.
  WARMUP_GET: 'warmup:get',
  WARMUP_READY: 'warmup:ready',

  // 메인/피커/설정 화면 전환 (공동) — 세 화면은 한 창을 재사용한다(동시 표시 불필요).
  // 렌더러(goto()) → 메인: 창 크기만 맞춰달라 요청. 메인(트레이 등) → 렌더러: 화면을 바꾸라고 지시.
  WINDOW_SET_ROUTE: 'window:setRoute',
  NAVIGATE: 'window:navigate',
  // "설정 화면 열기" 단축키(기본 Cmd/Ctrl+,, 2026-07-29) — 예전엔 globalShortcut(OS
  // 전역 후킹)으로 구현했으나, Cmd+,는 VSCode/Claude Desktop 등 다른 앱도 흔히 쓰는
  // 조합이라 Nuance가 실행 중이기만 하면 그 키 자체를 OS 레벨에서 통째로 가로채(우리
  // 콜백이 "지금은 동작 안 함"이라 판단해도 이미 그 시점엔 늦음) 다른 앱에서 같은
  // 단축키가 먹통이 되는 문제가 있었다(사용자 제보) — Nuance 자신의 창(메인/설정/
  // 피커/팝업)에서만 반응하면 되는 조건은 굳이 전역 후킹이 필요 없어(그 창이 이미
  // 포커싱돼 있을 때만 의미가 있으므로), 각 렌더러가 로컬 keydown 리스너로 직접
  // 판정하고 이 채널로 메인 프로세스에 "설정 화면 열어줘"만 요청하는 방식으로 교체.
  // 다른 앱의 키 입력에는 전혀 관여하지 않는다.
  OPEN_SETTINGS: 'settings:open',

  // 팝업 직전 추출 결과 전달 = 팝업 트리거 (A → B). 최종 선택 확정은 B가 팝업에서.
  SELECTION_EXTRACTED: 'selection:extracted',

  // 질문 (담당 B)
  QUESTION_REQUEST: 'question:request',
  QUESTION_STREAM: 'question:stream',
  // 사전 어댑터 병렬 구현 디버깅용 임시 채널(2026-07-28) — 언어별로 실제 구현된
  // 소스 목록(question/dictionary/registry.ts)을 조회한다.
  DICTIONARY_SOURCES_GET: 'dictionary:sourcesGet',

  // 팝업 (담당 B) — 선택 확정 후 뜨는 검색/채팅 팝업
  OPEN_POPUP: 'popup:open',
  POPUP_GET_CONTEXT: 'popup:getContext',
  // 팝업이 실제 내용(빈 자리표시자가 아닌 baseCtx)을 그리고 첫 페인트까지 끝냈을 때
  // 렌더러가 1회 통지 — 빈 창이 잠깐 보였다 내용으로 채워지는 깜빡임을 없애려고,
  // 메인이 이 신호를 받을 때까지 창을 숨겨둔다(windows.ts: createPopupWindow).
  POPUP_CONTENT_READY: 'popup:contentReady',
  OPEN_GOOGLE: 'popup:openGoogle',
  OPEN_NAVER_DICT: 'popup:openNaverDict',
  // 채팅창 마크다운 안의 링크(사전 출처 등)를 구글/네이버 버튼과 동일한 방식(기본
  // 브라우저의 새 창, 팝업과 같은 위치·크기)으로 연다 — 이미 완성된 URL을 그대로 받는다.
  OPEN_EXTERNAL_LINK: 'popup:openExternalLink',
  // 팝업 원문 문맥의 가나 atom 병합용 — 일본어 형태소 분석(main/nlp/japanese.ts)
  TOKENIZE_JA: 'popup:tokenizeJa',
  // 팝업 원문 문맥의 중국어 단어 atom 구성용 — 형태소 분석(main/nlp/chinese.ts, zh-Hans/zh-Hant 별 엔진)
  TOKENIZE_ZH: 'popup:tokenizeZh',

  // 설정 / API 키 (담당 B)
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // 설정 화면 "기본값으로 초기화" 버튼용 — 코드에 박힌 기본값(settingsStore.ts DEFAULT_SETTINGS)을 그대로 내려준다.
  SETTINGS_GET_DEFAULTS: 'settings:getDefaults',
  FREQUENT_GET: 'frequent:get',
  FREQUENT_SET: 'frequent:set',
  APIKEY_GET: 'apikey:get',
  APIKEY_SET: 'apikey:set',
  APIKEY_DELETE: 'apikey:delete',
  PROVIDER_VALIDATE: 'provider:validate',
  // 모델 드롭다운에서 특정 모델을 고를 때 실제로 동작하는지 최소 비용(토큰 1개)으로
  // 실제 채팅 호출 1회를 해보는 검증 — /v1/models 목록엔 있어도 이미 단종됐거나
  // temperature 등 파라미터 제약이 있는 모델을 선택 시점에 걸러내기 위함.
  PROVIDER_TEST_MODEL: 'provider:testModel',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
