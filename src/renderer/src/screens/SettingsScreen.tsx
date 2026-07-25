import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { PROVIDERS, PROVIDER_ORDER } from '@shared/providers'
import { LANGUAGES, LANGUAGE_ORDER } from '@shared/languages'

// 설정 화면 (PLAN.md §3) — 담당 B
// 1.LLM 선택 2.API 키 관리 3.단축키 4.AI 주변 범위(Byte) 5.언어 선택
// 메인 창 안에서 해시 라우팅으로 뜬다(#/main ↔ #/settings, 별도 창 아님).

const BYTE_STEPS = [256, 512, 1024, 2048, 4096] as const

const PREVIEW = {
  before: '… Technology opens the door to a world of resources, connections, and opportunities. But ',
  selected: 'curiosity and practice turn those resources into real understanding.',
  after: ' Keep asking questions, stay consistent, and enjoy the journey—small steps every day lead to big results. …',
}

const NON_KEY_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

/** F1~F12 처럼 수식키 없이 단독으로도 전역 단축키로 적절한 키 */
function isStandaloneKey(key: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(key)
}

/**
 * keydown 이벤트를 Electron accelerator 문자열로 변환 (예: 'Alt+Q', 'CommandOrControl+Shift+K').
 * 유효하지 않은 입력(수식키 단독, 수식키 없는 일반 키)은 null 을 돌려준다.
 * 수식키 없는 일반 단일 키(예: 'Q')를 전역 단축키로 등록하면 시스템 전역에서 그 키를
 * 가로채 정상 타이핑을 막으므로, F1~F12 를 제외하고는 최소 1개의 수식키를 요구한다.
 */
function toAccelerator(e: KeyboardEvent): string | null {
  if (NON_KEY_MODIFIERS.has(e.key)) return null // 수식키 단독 입력은 무시
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (mods.length === 0 && !isStandaloneKey(key)) return null // 수식키 없는 일반 키 거부
  return [...mods, key].join('+')
}

export function SettingsScreen() {
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [apiKey, setApiKeyState] = useState('')
  const [keyEditing, setKeyEditing] = useState(false)
  const [keyVisible, setKeyVisible] = useState(false)
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    window.nuance.getSettings().then(setSettingsState)
  }, [])

  useEffect(() => {
    if (!settings) return
    window.nuance.getApiKey(settings.llm).then((k) => setApiKeyState(k ?? ''))
    setKeyEditing(false)
    setKeyVisible(false)
    // llm 이 바뀔 때만 다시 조회하면 된다(의도적으로 settings 전체가 아닌 llm 만 의존).
  }, [settings?.llm])

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setRecording(false) // 취소 — 기존 단축키 유지
        return
      }
      const accelerator = toAccelerator(e)
      if (!accelerator) return // 유효하지 않은 조합은 무시하고 계속 대기
      setRecording(false)
      void patch({ modeShortcut: accelerator })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // recording 상태에만 반응하면 된다(patch 는 재실행 불필요).
  }, [recording])

  if (!settings) return <div className="screen settings-screen" />

  async function patch(p: Partial<AppSettings>) {
    const next = await window.nuance.setSettings(p)
    setSettingsState(next)
  }

  async function saveKey() {
    setKeyEditing(false)
    const trimmed = apiKey.trim()
    if (trimmed) await window.nuance.setApiKey(settings!.llm, trimmed)
  }

  async function deleteKey() {
    await window.nuance.deleteApiKey(settings!.llm)
    setApiKeyState('')
  }

  const byteIndex = BYTE_STEPS.indexOf(settings.contextBytes)

  return (
    <div className="screen settings-screen">
      <div className="settings-header">
        <button className="icon-btn back" onClick={() => (window.location.hash = '#/main')}>
          ←
        </button>
        <div>
          <h1>설정</h1>
          <p>AI 기능 및 단축키를 설정하고 관리하세요.</p>
        </div>
      </div>

      {/* 1. LLM 선택 */}
      <section className="settings-section">
        <h2>1. LLM 선택</h2>
        <p className="desc">사용할 언어 모델을 선택하세요.</p>
        <div className="provider-cards">
          {PROVIDER_ORDER.map((p) => {
            const info = PROVIDERS[p]
            const active = settings.llm === p
            return (
              <button
                key={p}
                type="button"
                className={`provider-card${active ? ' active' : ''}`}
                onClick={() => void patch({ llm: p })}
              >
                {active && <span className="check">✓</span>}
                <span className="icon">{info.icon}</span>
                <span className="label">{info.label}</span>
              </button>
            )
          })}
        </div>
        <div className="settings-note">ℹ️ 선택한 모델이 AI 프롬프트 제출에 사용됩니다.</div>
      </section>

      {/* 2. API 키 관리 */}
      <section className="settings-section">
        <h2>2. API 키 관리</h2>
        <p className="desc">선택한 LLM의 API 키를 입력하고 관리하세요.</p>
        <div className="apikey-row">
          <div className="apikey-main">
            <label>API 키</label>
            <div className="apikey-field">
              <input
                type={keyVisible ? 'text' : 'password'}
                value={apiKey}
                disabled={!keyEditing}
                placeholder="API 키를 입력하세요"
                onChange={(e) => setApiKeyState(e.target.value)}
                onBlur={() => keyEditing && void saveKey()}
                onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setKeyVisible((v) => !v)}
                title={keyVisible ? '숨기기' : '보기'}
              >
                {keyVisible ? '🙈' : '👁'}
              </button>
            </div>
          </div>
          <div className="apikey-actions">
            <button type="button" className="btn-outline" onClick={() => setKeyEditing(true)}>
              ✏️ 수정
            </button>
            <button
              type="button"
              className="btn-outline danger"
              onClick={() => void deleteKey()}
              disabled={!apiKey}
            >
              🗑 삭제
            </button>
          </div>
        </div>
        <div className="settings-note">🔒 API 키는 안전하게 암호화되어 저장되며, 외부로 전송되지 않습니다.</div>
      </section>

      {/* 3. 단축키 설정 */}
      <section className="settings-section">
        <h2>3. 단축키 설정</h2>
        <p className="desc">일반 모드와 선택 모드를 전환하는 단축키를 지정하세요.</p>
        <div className="shortcut-row">
          <span className="label">⌨️ 모드 전환 (일반 ↔ 선택)</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recording ? ' recording' : ''}`}>
              {recording ? '수식키+키 입력 (Esc 취소)' : settings.modeShortcut}
            </span>
            <button type="button" className="btn-outline" onClick={() => setRecording(true)}>
              ✏️ 변경
            </button>
          </div>
        </div>
        <div className="settings-note">⌨️ 설정한 단축키를 누를 때마다 일반 모드와 선택 모드가 전환됩니다.</div>
      </section>

      {/* 4. AI 주변 범위(Byte) */}
      <section className="settings-section">
        <h2>4. AI 프롬프트 제출 시 AI가 함께 고려할 주변 범위 선택</h2>
        <p className="desc">프롬프트 제출 시 AI가 함께 고려할 주변 텍스트의 범위를 설정하세요.</p>

        <div className="byte-row">
          <span className="title">Byte 수 설정</span>
          <span className="value">{settings.contextBytes} Byte</span>
        </div>
        <p className="desc">선택한 텍스트를 기준으로 앞뒤 주변 텍스트를 포함할 Byte 수를 설정됩니다.</p>
        <input
          type="range"
          className="byte-slider"
          min={0}
          max={BYTE_STEPS.length - 1}
          step={1}
          value={byteIndex}
          onChange={(e) => void patch({ contextBytes: BYTE_STEPS[Number(e.target.value)] })}
        />
        <div className="byte-ticks">
          {BYTE_STEPS.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </div>

        <div className="byte-preview-legend">
          <span>
            <span className="swatch excluded" /> 포함 제외
          </span>
          <span>
            <span className="swatch selected" /> 사용자 선택 영역
          </span>
          <span>
            <span className="swatch context" /> 포함될 주변 범위 (설정: {settings.contextBytes} Byte)
          </span>
        </div>
        <div className="byte-preview">
          <span className="excluded">{PREVIEW.before.slice(0, 2)}</span>
          <span className="context-span">{PREVIEW.before.slice(2)}</span>
          <span className="selected-span">{PREVIEW.selected}</span>
          <span className="context-span">{PREVIEW.after.slice(0, -2)}</span>
          <span className="excluded">{PREVIEW.after.slice(-2)}</span>
        </div>
        <div className="settings-note">
          ℹ️ Byte 수가 클수록 더 많은 주변 텍스트가 포함되어 AI가 문맥을 더 잘 이해할 수 있습니다.
        </div>
      </section>

      {/* 5. 언어 선택 */}
      <section className="settings-section">
        <h2>5. 언어 선택</h2>
        <p className="desc">OCR의 언어 설정을 선택하세요.</p>
        <div className="lang-options">
          <label className="lang-option">
            <input
              type="radio"
              name="lang"
              checked={settings.language === 'auto'}
              onChange={() => void patch({ language: 'auto' })}
            />
            <div>
              <div className="title">자동 언어 감지</div>
              <div className="desc">OCR을 할 때 영어 / 일본어 / 중국어 중 언어를 자동으로 감지합니다.</div>
            </div>
          </label>
          <label className="lang-option">
            <input
              type="radio"
              name="lang"
              checked={settings.language !== 'auto'}
              onChange={() => void patch({ language: LANGUAGE_ORDER[0] })}
            />
            <div>
              <div className="title">언어 선택</div>
              <div className="desc">영어 / 일본어 / 중국어 중 하나를 직접 선택합니다.</div>
            </div>
            <div className="lang-select">
              {LANGUAGE_ORDER.map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`lang-pill${settings.language === code ? ' active' : ''}`}
                  onClick={(e) => {
                    e.preventDefault()
                    void patch({ language: code })
                  }}
                >
                  {LANGUAGES[code].name}
                </button>
              ))}
            </div>
          </label>
        </div>
      </section>
    </div>
  )
}
