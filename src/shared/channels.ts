// 공동 소유 — IPC 채널 상수 (PLAN.md §9 통합 지점)
// A→B: selection:extracted / B: question:request, question:stream

export const IPC = {
  // 창 선택 / 모드 (담당 A)
  WINDOW_LIST: 'window:list',
  SELECT_WINDOW: 'window:select',
  WINDOW_SELECTED: 'window:selected',
  GET_SELECTED_WINDOW_ID: 'window:getSelectedId',
  // 창 선택 화면에서 Esc — 이미 선택된 창이 있으면 메인 화면으로 안 돌아가고 그냥 숨는다
  // (2026-07-30 사용자 요청: "창 선택이 돼 있는 상태라면 메인 화면이 뜨지 않도록").
  WINDOW_HIDE: 'window:hide',
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
  // macOS 전용(2026-07-30) — 오버레이가 클릭을 받으려고 비-클릭스루 상태가 되는 동안
  // 스크롤 휠까지 같이 막히는 문제 우회. 렌더러(Overlay.tsx)가 자신이 가로챈 wheel
  // 이벤트의 델타를 메인으로 넘기면, 메인이 대상 창의 소유 프로세스에 합성 스크롤
  // 이벤트로 재전달한다(macScroll.ts: CGEventPostToPid — 히트테스트를 건너뛰어 우리
  // 오버레이가 화면상 앞에 있어도 무관하게 전달된다).
  OVERLAY_FORWARD_SCROLL: 'overlay:forwardScroll',
  // 선택 모드 진입 시 미리 캐시된 단어 bbox 목록을 오버레이로 통지 (extractionCache.ts)
  EXTRACTION_WORDS: 'selection:words',
  // 추출 파이프라인의 현재 단계 문구 — 담당 A(2026-07-31 재설계, 사용자 요청). 예전엔
  // EXTRACTION_STARTED("언어 감지 & 텍스트 영역 탐지")/EXTRACTION_OCR_STARTED("텍스트
  // 추출") 2단계 고정 채널이었는데, 이제 extractionCache.ts: runExtraction() 이 실제로
  // 거치는 단계마다(엔진 예열/영역 탐지/언어 감지/CJK 엔진 예열/텍스트 추출, 최대 5단계
  // — 앞의 예열 2개는 이미 예열돼 있으면 생략) 그때그때 문구를 실어 보낸다. 다음 단계로
  // 넘어갈 때마다 새 문구로 덮어쓰면 되고, 끝나면(EXTRACTION_WORDS 도착) Overlay.tsx 가
  // 알아서 배너를 끈다 — 명시적으로 null 을 보낼 필요는 보통 없다.
  EXTRACTION_PHASE: 'selection:extractionPhase',
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

  // 메인/피커/설정 화면 전환 (공동) — 세 화면은 한 창을 재사용한다(동시 표시 불필요).
  // 렌더러(goto()) → 메인: 창 크기만 맞춰달라 요청. 메인(트레이 등) → 렌더러: 화면을 바꾸라고 지시.
  WINDOW_SET_ROUTE: 'window:setRoute',
  // 렌더러가 NAVIGATE 를 받아 실제로 해당 라우트로 전환·렌더를 마쳤을 때 응답(windows.ts:
  // showMainWindowAtRoute 가 이 신호를 받은 뒤에야 숨겨진 창을 show() 해 화면 전환
  // 깜빡임을 없앤다).
  NAVIGATE_READY: 'window:navigateReady',
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

  // 자체 문서 뷰어(pdf/epub/txt) — 외부 뷰어의 접근성 API 좌표 문제를 피해 우리가 직접
  // 파싱·렌더링하고, 그 DOM 위에서 웹페이지와 똑같은 방식으로 호버박스를 띄운다(TODO.md).
  // OPEN_FILE_DIALOG: 메인 화면 "파일 열기" → 확장자 제한 다이얼로그 → 뷰어 창 생성까지.
  VIEWER_OPEN_FILE_DIALOG: 'viewer:openFileDialog',
  // 뷰어 렌더러가 자기 창에 열린 파일의 내용을 pull 한다(contextIsolation 유지 —
  // 렌더러는 fs 에 직접 접근하지 않고 메인이 읽어 넘긴다).
  VIEWER_GET_FILE: 'viewer:getFile',
  // 뷰어 안에서 단어를 클릭 — 확장의 pageClick 과 같은 역할(viewerSource.ts 가 받아
  // ExtractedSelection 으로 감싸 기존 팝업을 띄운다).
  VIEWER_WORD_CLICKED: 'viewer:wordClicked',
  // 뷰어 뒤로가기 — 뷰어 창을 닫고 메인 창을 다시 보여준다(뷰어는 별도 창이라
  // 같은 창 안에서 라우트를 되돌리는 대신 창을 닫는 게 자연스럽다).
  VIEWER_BACK: 'viewer:back',
  // 뷰어 보기 설정 변경 알림 / 반영 — 읽기 방식·넘김 효과·테마 같은 화면 취향은 파일
  // 종류와 무관하게 모든 뷰어가 같은 값을 쓴다(사용자 지정). 저장소(localStorage)는 이미
  // 공유하지만 그건 창을 새로 열 때만 읽으므로, 이미 떠 있는 창들에는 메인을 거쳐 전한다.
  VIEWER_PREFS_CHANGED: 'viewer:prefsChanged',
  VIEWER_PREFS_SYNC: 'viewer:prefsSync',

  // 뷰어 문단의 CJK 형태소 분할 요청 — 확장은 WebSocket 으로 하던 것을 IPC 로 연결한다
  // (메인의 기존 nlp/ 분할기를 그대로 호출).
  VIEWER_SEGMENT: 'viewer:segment',

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
  // 선택 표현 자동 복사(2026-07-30) — navigator.clipboard 는 문서가 포커스돼 있어야
  // 동작해서, 숨겨진 채로 만들어지는 팝업의 "뜬 직후" 초기 복사가 조용히 실패했다.
  // 포커스와 무관한 메인 프로세스 Electron clipboard 로 대신 쓴다.
  CLIPBOARD_COPY: 'popup:clipboardCopy',
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
