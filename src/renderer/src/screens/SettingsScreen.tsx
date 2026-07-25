import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { PROVIDERS, PROVIDER_ORDER } from '@shared/providers'
import { LANGUAGES, LANGUAGE_ORDER } from '@shared/languages'
import { computeContextRange, byteLength } from '@shared/context'

// 설정 화면 (PLAN.md §3) — 담당 B
// 1.LLM 선택 2.API 키 관리 3.단축키 4.AI 주변 범위(Byte) 5.언어 선택
// 메인 창 안에서 해시 라우팅으로 뜬다(#/main ↔ #/settings, 별도 창 아님).

// Byte 예산은 자유 지정(고정 단위 없음). 슬라이더 범위/숫자 입력 공통 상한.
const BYTE_MIN = 0
const BYTE_MAX = 4096

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return BYTE_MIN
  return Math.max(BYTE_MIN, Math.min(BYTE_MAX, Math.round(n)))
}

// 미리보기 예시 — 『The Hobbit』 첫 장. 선택 영역 기준으로 앞/뒤 바이트 범위 +
// 문장 경계 확장을 실시간 시각화한다.
const PREVIEW_TEXT = `In a hole in the ground there lived a hobbit. Not a nasty, dirty, wet hole, filled with the ends of worms and an oozy smell, nor yet a dry, bare, sandy hole with nothing in it to sit down on or to eat: it was a hobbit-hole, and that means comfort.
It had a perfectly round door like a porthole, painted green, with a shiny yellow brass knob in the exact middle. The door opened on to a tube-shaped hall like a tunnel: a very comfortable tunnel without smoke, with panelled walls, and floors tiled and carpeted, provided with polished chairs, and lots and lots of pegs for hats and coats—the hobbit was fond of visitors. The tunnel wound on and on, going fairly but not quite straight into the side of the hill—The Hill, as all the people for many miles round called it—and many little round doors opened out of it, first on one side and then on another. No going upstairs for the hobbit: bedrooms, bathrooms, cellars, pantries (lots of these), wardrobes (he had whole rooms devoted to clothes), kitchens, dining-rooms, all were on the same floor, and indeed on the same passage.
This hobbit was a very well-to-do hobbit, and his name was Baggins. The Bagginses had lived in the neighbourhood of The Hill for time out of mind, and people considered them very respectable, not only because most of them were rich, but also because they never had any adventures or did anything unexpected: you could tell what a Baggins would say on any question without the bother of asking him. This is a story of how a Baggins had an adventure, and found himself doing and saying things altogether unexpected.`

const PREVIEW_SELECTED = 'very respectable'
const PREVIEW_SEL_START = PREVIEW_TEXT.indexOf(PREVIEW_SELECTED)
const PREVIEW_SEL_END = PREVIEW_SEL_START + PREVIEW_SELECTED.length

function seg(text: string, cls: string, key: string) {
  return text ? (
    <span key={key} className={cls}>
      {text}
    </span>
  ) : null
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

  // 설정 화면 동안 메인 창을 세로로 확대, 이탈(언마운트) 시 원래 크기로 복원.
  useEffect(() => {
    void window.nuance.setWindowExpanded(true)
    return () => {
      void window.nuance.setWindowExpanded(false)
    }
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

  // 미리보기: 선택 기준 앞/뒤 바이트 범위 + 문장 경계 확장 범위 계산
  const range = computeContextRange(
    PREVIEW_TEXT,
    PREVIEW_SEL_START,
    PREVIEW_SEL_END,
    settings.contextBytes,
  )
  const includedBytes = byteLength(PREVIEW_TEXT.slice(range.extStart, range.extEnd))

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
        <p className="desc">
          선택한 텍스트를 기준으로 앞뒤 주변 텍스트를 포함할 Byte 수를 자유롭게 지정하세요. 실제
          전달 시에는 지정한 범위에서 <b>문장이 잘리지 않도록 문장 경계까지 확장</b>됩니다.
        </p>

        <div className="byte-row">
          <span className="title">Byte 수 설정</span>
          <div className="byte-input">
            <input
              type="number"
              min={BYTE_MIN}
              max={BYTE_MAX}
              value={settings.contextBytes}
              onChange={(e) => void patch({ contextBytes: clampByte(Number(e.target.value)) })}
            />
            <span className="unit">Byte</span>
          </div>
        </div>
        <input
          type="range"
          className="byte-slider"
          min={BYTE_MIN}
          max={BYTE_MAX}
          step={1}
          value={settings.contextBytes}
          onChange={(e) => void patch({ contextBytes: Number(e.target.value) })}
        />

        <div className="byte-preview-legend">
          <span>
            <span className="swatch excluded" /> 포함 제외
          </span>
          <span>
            <span className="swatch selected" /> 사용자 선택 영역
          </span>
          <span>
            <span className="swatch context" /> 바이트 범위 ({settings.contextBytes} Byte)
          </span>
          <span>
            <span className="swatch extend" /> 문장 경계 확장
          </span>
        </div>
        <div className="byte-preview">
          {seg(PREVIEW_TEXT.slice(0, range.extStart), 'excluded', 'e1')}
          {seg(PREVIEW_TEXT.slice(range.extStart, range.byteStart), 'extend-span', 'x1')}
          {seg(PREVIEW_TEXT.slice(range.byteStart, range.selStart), 'context-span', 'c1')}
          {seg(PREVIEW_TEXT.slice(range.selStart, range.selEnd), 'selected-span', 's')}
          {seg(PREVIEW_TEXT.slice(range.selEnd, range.byteEnd), 'context-span', 'c2')}
          {seg(PREVIEW_TEXT.slice(range.byteEnd, range.extEnd), 'extend-span', 'x2')}
          {seg(PREVIEW_TEXT.slice(range.extEnd), 'excluded', 'e2')}
        </div>
        <div className="settings-note">
          ℹ️ 설정 {settings.contextBytes} Byte(앞·뒤 각) → 문장 경계 확장 포함 실제 약{' '}
          {includedBytes} Byte 가 문맥으로 전달됩니다.
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
