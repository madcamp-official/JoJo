// 공동 소유 — IPC 채널 상수 (PLAN.md §7 통합 지점)
// A→B: selection:resolved / B: question:request, question:stream

export const IPC = {
  // 창 선택 / 모드 (담당 A)
  WINDOW_LIST: 'window:list',
  SELECT_WINDOW: 'window:select',
  WINDOW_SELECTED: 'window:selected',
  OPEN_WINDOW_PICKER: 'window:openPicker',
  CLOSE_WINDOW_PICKER: 'window:closePicker',
  SET_MODE: 'mode:set',
  MODE_CHANGED: 'mode:changed',

  // 선택 확정 → 질문 파이프라인으로 전달 (A → B)
  SELECTION_RESOLVED: 'selection:resolved',

  // 질문 (담당 B)
  QUESTION_REQUEST: 'question:request',
  QUESTION_STREAM: 'question:stream',

  // 설정 / API 키 (담당 B)
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APIKEY_GET: 'apikey:get',
  APIKEY_SET: 'apikey:set',
  APIKEY_DELETE: 'apikey:delete',

  // 창 크기 조정 (설정 화면 진입 시 세로 확대)
  WINDOW_SET_EXPANDED: 'window:setExpanded',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
