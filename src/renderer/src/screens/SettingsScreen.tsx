import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { PROVIDERS, PROVIDER_ORDER } from '@shared/providers'
import { LANGUAGES, LANGUAGE_ORDER } from '@shared/languages'
import { computeContextRange, byteLength } from '@shared/context'

// 설정 화면 (PLAN.md §3) — 담당 B
// LLM·API 키 / 단축키 / AI 주변 범위(Byte) / 언어
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
This hobbit was a very well-to-do hobbit, and his name was Baggins. The Bagginses had lived in the neighbourhood of The Hill for time out of mind, and people considered them very respectable, not only because most of them were rich, but also because they never had any adventures or did anything unexpected: you could tell what a Baggins would say on any question without the bother of asking him. This is a story of how a Baggins had an adventure, and found himself doing and saying things altogether unexpected. He may have lost the neighbours’ respect, but he gained—well, you will see whether he gained anything in the end.`

// 선택 표현 = 전체 글의 정중앙에 걸친 단어
function centerWord(text: string): [number, number] {
  const mid = Math.floor(text.length / 2)
  let s = mid
  let e = mid
  while (s > 0 && !/\s/.test(text[s - 1])) s -= 1
  while (e < text.length && !/\s/.test(text[e])) e += 1
  return [s, e]
}
const [PREVIEW_SEL_START, PREVIEW_SEL_END] = centerWord(PREVIEW_TEXT)

function seg(text: string, cls: string, key: string) {
  return text ? (
    <span key={key} className={cls}>
      {text}
    </span>
  ) : null
}

/** 바이트 예산 입력 1개(숫자 입력 + 슬라이더) */
function ByteControl({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="byte-control">
      <div className="byte-row">
        <span className="title">{label}</span>
        <div className="byte-input">
          <input
            type="number"
            min={BYTE_MIN}
            max={BYTE_MAX}
            value={value}
            onChange={(e) => onChange(clampByte(Number(e.target.value)))}
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
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
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

  const previewRef = useRef<HTMLDivElement>(null)
  const selRef = useRef<HTMLSpanElement>(null)

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
    if (!settings.llm) {
      setApiKeyState('')
      return
    }
    window.nuance.getApiKey(settings.llm).then((k) => setApiKeyState(k ?? ''))
    setKeyEditing(false)
    setKeyVisible(false)
    // llm 이 바뀔 때만 다시 조회하면 된다(의도적으로 settings 전체가 아닌 llm 만 의존).
  }, [settings?.llm])

  // 미리보기 스크롤을 선택 표현 위치(중앙)로 이동 — 바이트 값이 바뀔 때마다 재이동.
  useEffect(() => {
    const box = previewRef.current
    const sel = selRef.current
    if (box && sel) {
      box.scrollTop = sel.offsetTop - box.clientHeight / 2 + sel.clientHeight / 2
    }
  }, [settings?.contextBytesBefore, settings?.contextBytesAfter])

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
    if (trimmed && settings!.llm) await window.nuance.setApiKey(settings!.llm, trimmed)
  }

  async function deleteKey() {
    if (!settings!.llm) return
    const label = PROVIDERS[settings!.llm].label
    if (!window.confirm(`${label} API 키를 정말 삭제하시겠습니까?`)) return
    await window.nuance.deleteApiKey(settings!.llm)
    setApiKeyState('')
  }

  function setBytes(side: 'before' | 'after', v: number) {
    const n = clampByte(v)
    if (settings!.contextBytesLinked) void patch({ contextBytesBefore: n, contextBytesAfter: n })
    else void patch(side === 'before' ? { contextBytesBefore: n } : { contextBytesAfter: n })
  }

  function toggleLinked() {
    const linked = !settings!.contextBytesLinked
    // 링크를 켜면 뒤 값을 앞 값에 맞춰 통일한다.
    if (linked) void patch({ contextBytesLinked: true, contextBytesAfter: settings!.contextBytesBefore })
    else void patch({ contextBytesLinked: false })
  }

  const aiReady = !!settings.llm && apiKey.trim().length > 0

  // 미리보기: 선택 기준 앞/뒤 바이트 범위 + 문장 경계 확장 범위 계산
  const range = computeContextRange(
    PREVIEW_TEXT,
    PREVIEW_SEL_START,
    PREVIEW_SEL_END,
    settings.contextBytesBefore,
    settings.contextBytesAfter,
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

      {/* LLM 및 API 키 */}
      <section className="settings-section">
        <h2>LLM 및 API 키</h2>
        <p className="desc">사용할 언어 모델을 선택하고, 해당 모델의 API 키를 입력하세요.</p>
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

        {settings.llm && (
          <div className="apikey-row">
            <div className="apikey-main">
              <label>{PROVIDERS[settings.llm].label} API 키</label>
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
        )}

        {!aiReady && (
          <div className="settings-warning">
            ⚠️{' '}
            {settings.llm
              ? 'API 키가 입력되지 않아 AI 관련 기능(발음·사전·통합 질문)을 사용할 수 없습니다.'
              : '사용할 LLM을 선택하고 API 키를 입력해야 AI 관련 기능을 사용할 수 있습니다.'}
          </div>
        )}

        <div className="settings-note">
          🔒 API 키는 안전하게 암호화되어 저장되며, 외부로 전송되지 않습니다.
        </div>
      </section>

      {/* 단축키 설정 */}
      <section className="settings-section">
        <h2>단축키 설정</h2>
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
        <div className="settings-note">
          ⌨️ 설정한 단축키를 누를 때마다 일반 모드와 선택 모드가 전환됩니다.
        </div>
      </section>

      {/* AI 주변 범위(Byte) */}
      <section className="settings-section">
        <h2>AI 주변 범위 (Byte)</h2>
        <p className="desc">
          선택한 표현을 기준으로 앞뒤 주변 텍스트를 포함할 Byte 수를 자유롭게 지정하세요. 실제
          전달 시에는 지정한 범위에서 <b>문장이 잘리지 않도록 문장 경계까지 확장</b>됩니다.
        </p>

        <label className="byte-link-toggle">
          <input
            type="checkbox"
            checked={settings.contextBytesLinked}
            onChange={toggleLinked}
          />
          앞·뒤를 동일한 값으로 설정
        </label>

        {settings.contextBytesLinked ? (
          <ByteControl
            label="앞·뒤 공통"
            value={settings.contextBytesBefore}
            onChange={(v) => setBytes('before', v)}
          />
        ) : (
          <>
            <ByteControl
              label="앞 (선택 이전)"
              value={settings.contextBytesBefore}
              onChange={(v) => setBytes('before', v)}
            />
            <ByteControl
              label="뒤 (선택 이후)"
              value={settings.contextBytesAfter}
              onChange={(v) => setBytes('after', v)}
            />
          </>
        )}

        <div className="byte-preview-legend">
          <span>
            <span className="swatch excluded" /> 포함 제외
          </span>
          <span>
            <span className="swatch selected" /> 사용자 선택 영역
          </span>
          <span>
            <span className="swatch context" /> 바이트 범위
          </span>
          <span>
            <span className="swatch extend" /> 문장 경계 확장
          </span>
        </div>
        <div className="byte-preview" ref={previewRef}>
          {seg(PREVIEW_TEXT.slice(0, range.extStart), 'excluded', 'e1')}
          {seg(PREVIEW_TEXT.slice(range.extStart, range.byteStart), 'extend-span', 'x1')}
          {seg(PREVIEW_TEXT.slice(range.byteStart, range.selStart), 'context-span', 'c1')}
          <span ref={selRef} className="selected-span">
            {PREVIEW_TEXT.slice(range.selStart, range.selEnd)}
          </span>
          {seg(PREVIEW_TEXT.slice(range.selEnd, range.byteEnd), 'context-span', 'c2')}
          {seg(PREVIEW_TEXT.slice(range.byteEnd, range.extEnd), 'extend-span', 'x2')}
          {seg(PREVIEW_TEXT.slice(range.extEnd), 'excluded', 'e2')}
        </div>
        <div className="settings-note">
          ℹ️ 설정 앞 {settings.contextBytesBefore} · 뒤 {settings.contextBytesAfter} Byte → 문장 경계
          확장 포함 실제 약 {includedBytes} Byte 가 문맥으로 전달됩니다.
        </div>
        <div className="settings-note cost">
          💸 범위를 넓게 잡을수록 AI가 문맥을 더 잘 이해하지만, 전달 텍스트가 늘어 요청 비용도
          증가합니다.
        </div>
      </section>

      {/* 언어 선택 */}
      <section className="settings-section">
        <h2>언어 선택</h2>
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
