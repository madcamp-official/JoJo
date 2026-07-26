// 공동 소유 — IPC 채널 상수 (PLAN.md §7 통합 지점)
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
  // 선택 모드 진입 시 미리 캐시된 단어 bbox 목록을 오버레이로 통지 (extractionCache.ts)
  EXTRACTION_WORDS: 'selection:words',
  // 화면 내용 변화 감지로 백그라운드 재추출을 시작할 때 오버레이에 "추출 중" 표시를
  // 띄우기 위한 통지 (changeWatcher.ts). 끝나면 EXTRACTION_WORDS 가 그 표시를 끈다.
  EXTRACTION_STARTED: 'selection:extractionStarted',
  // OCR 대상 영역 지정 — 선택 모드 진입 시 영역이 없으면 메인이 오버레이에 드래그
  // 선택을 요청하고(REGION_SELECTION_NEEDED), 오버레이가 드래그 완료 시 그 영역을
  // 돌려준다(SUBMIT_REGION). OVERLAY_NOTICE 는 리사이즈로 영역이 무효화됐을 때 같은
  // 배너로 안내 문구를 띄우는 범용 채널.
  REGION_SELECTION_NEEDED: 'region:selectionNeeded',
  SUBMIT_REGION: 'region:submit',
  OVERLAY_NOTICE: 'overlay:notice',

  // 메인/피커/설정 화면 전환 (공동) — 세 화면은 한 창을 재사용한다(동시 표시 불필요).
  // 렌더러(goto()) → 메인: 창 크기만 맞춰달라 요청. 메인(트레이 등) → 렌더러: 화면을 바꾸라고 지시.
  WINDOW_SET_ROUTE: 'window:setRoute',
  NAVIGATE: 'window:navigate',

  // 팝업 직전 추출 결과 전달 = 팝업 트리거 (A → B). 최종 선택 확정은 B가 팝업에서.
  SELECTION_EXTRACTED: 'selection:extracted',

  // 질문 (담당 B)
  QUESTION_REQUEST: 'question:request',
  QUESTION_STREAM: 'question:stream',

  // 팝업 (담당 B) — 선택 확정 후 뜨는 검색/채팅 팝업
  OPEN_POPUP: 'popup:open',
  POPUP_GET_CONTEXT: 'popup:getContext',
  OPEN_GOOGLE: 'popup:openGoogle',

  // 설정 / API 키 (담당 B)
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  FREQUENT_GET: 'frequent:get',
  FREQUENT_SET: 'frequent:set',
  APIKEY_GET: 'apikey:get',
  APIKEY_SET: 'apikey:set',
  APIKEY_DELETE: 'apikey:delete',
  PROVIDER_VALIDATE: 'provider:validate',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
