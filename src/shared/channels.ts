// 공동 소유 — IPC 채널 상수 (PLAN.md §8 통합 지점)
// A→B: selection:resolved / B: search:request, search:stream

export const IPC = {
  // 창 선택 / 모드 (담당 A)
  SELECT_WINDOW: 'window:select',
  SET_MODE: 'mode:set',
  MODE_CHANGED: 'mode:changed',

  // 선택 확정 → 검색 파이프라인으로 전달 (A → B)
  SELECTION_RESOLVED: 'selection:resolved',

  // 검색 (담당 B)
  SEARCH_REQUEST: 'search:request',
  SEARCH_STREAM: 'search:stream',

  // 설정 / API 키 (담당 B)
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APIKEY_SET: 'apikey:set',
  APIKEY_DELETE: 'apikey:delete',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
