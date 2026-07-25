// 공동 소유 — IPC 채널 상수 (PLAN.md §7 통합 지점)
// A→B: selection:resolved / B: question:request, question:stream

export const IPC = {
  // 창 선택 / 모드 (담당 A)
  WINDOW_LIST: 'window:list',
  SELECT_WINDOW: 'window:select',
  WINDOW_SELECTED: 'window:selected',
  OPEN_WINDOW_PICKER: 'window:openPicker',
  CLOSE_WINDOW_PICKER: 'window:closePicker',
  GET_MODE: 'mode:get',
  SET_MODE: 'mode:set',
  MODE_CHANGED: 'mode:changed',
  OPEN_SETTINGS: 'settings:open',

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
  APIKEY_SET: 'apikey:set',
  APIKEY_DELETE: 'apikey:delete',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
