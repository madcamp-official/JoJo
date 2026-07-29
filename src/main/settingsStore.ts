import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '@shared/types'

// 담당 B — 앱 설정(AppSettings) 영속화 (PLAN.md §4 설정 화면)
// userData/settings.json 에 평문 JSON으로 저장한다 (민감정보 없음 — API 키는 keyStore 가 별도 암호화 저장).

const DEFAULT_SETTINGS: AppSettings = {
  llm: null, // 기본 provider 를 임의 지정하지 않음 — 사용자가 처음 고르기 전엔 미선택
  language: 'auto',
  modeShortcut: 'Alt+Q',
  // macOS 는 Cmd/Ctrl 을 서로 다른 물리 키로 취급(둘 다 registerModeShortcut 처럼 한 accelerator
  // 에 뭉뚱그리지 않음) — 관례상 Cmd. Windows 는 Ctrl 밖에 없으니 그대로 Ctrl.
  settingsShortcut: process.platform === 'darwin' ? 'Command+,' : 'Control+,',
  // Alt 는 macOS 에서 Option 으로 자동 매핑된다(shortcut.ts 주석 참고) — 트레이 메뉴
  // 순서(창 선택 전환 / 창 선택 해제 / 영역 수동 선택)대로 Opt+1/2/3 을 기본 배정
  // (2026-07-29, 재수정 — 전환/해제 순서와 단축키를 서로 교체).
  windowSelectShortcut: 'Alt+1',
  windowDeselectShortcut: 'Alt+2',
  manualRegionShortcut: 'Alt+3',
  contextBytesBefore: 1024,
  contextBytesAfter: 1024,
  contextBytesLinked: true,
  models: {},
  autoDetectRegion: false,
}

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cached: AppSettings | null = null

/** 앱 시작 시 1회 호출 — 디스크에서 로드(없으면 기본값)하고 캐시한다. */
export function loadSettings(): AppSettings {
  let loaded: AppSettings
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    loaded = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    loaded = { ...DEFAULT_SETTINGS }
  }
  cached = loaded
  return loaded
}

export function getSettings(): AppSettings {
  return cached ?? loadSettings()
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
