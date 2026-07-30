import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AnyLanguage, AppSettings } from '@shared/types'

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
  forceOcrShortcut: 'Alt+4',
  // 앞뒤 비대칭 기본값(2026-07-30, 사용자 요청 — 앞 700 / 뒤 300) — 값 자체가 다르므로
  // contextBytesLinked 기본값도 false 로 함께 바꿔야 앞뒤가 실제로 다르다는 걸 UI가
  // 일관되게 보여준다(linked=true 면 "앞·뒤 공통" 단일 컨트롤로 합쳐 보여주는데, 그 상태로
  // 서로 다른 700/300을 들고 있으면 화면엔 700만 보이고 실제 뒤 값(300)은 안 보이는
  // 모순이 생김).
  contextBytesBefore: 700,
  contextBytesAfter: 300,
  contextBytesLinked: false,
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

/** 설정 화면의 "기본값으로 초기화" 버튼용 — 단축키/문맥 범위 등 섹션별로 이 값들로
 *  되돌린다. 사본을 반환해 호출부가 실수로 DEFAULT_SETTINGS 원본을 변형하지 못하게 한다. */
export function getDefaultSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/** settings.language 가 'auto' 가 아니면(사용자가 특정 언어를 수동 지정) 그 값을,
 * 'auto' 면 null 을 반환한다 — 자막/화면 텍스트/OCR 판별 지점들이 공통으로 이걸 먼저
 * 확인해서, 지정돼 있으면 자동판별(eld/Tesseract OSD) 자체를 건너뛰고 항상 이 언어로
 * 확정한다(2026-07-30, 설정 화면 수동 선택을 실제 판별 로직에 연동). 특히 tier2에서
 * 라틴/키릴/아랍/데바나가리처럼 여러 언어가 스크립트를 공유해 자동판별이 흔들릴 수
 * 있는 경우, 사용자가 수동으로 확정해 그 모호성 자체를 없앨 수 있게 하는 게 목적. */
export function getLanguageOverride(): AnyLanguage | null {
  const { language } = getSettings()
  return language === 'auto' ? null : language
}
