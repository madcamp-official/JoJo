import { useEffect, useRef, useState } from 'react'
import type { AnyLanguage, AppSettings, ProviderValidation, QuestionErrorCode } from '@shared/types'
import { PROVIDERS, PROVIDER_ORDER, DEFAULT_MODELS } from '@shared/providers'
import { MW_DICTIONARY_SIGNUP_URL } from '@shared/dictionaries'
import { LANGUAGES, LANGUAGE_ORDER, LINK_LANGUAGES } from '@shared/languages'
import { computeContextRange, byteLength } from '@shared/context'
import { goto } from '../navigate'
import { IS_MAC, toAccelerator } from '../shortcutMatch'
import {
  ProviderLogo,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  WarnIcon,
  InfoIcon,
} from './icons'
import { EditDeleteGroup } from './EditDeleteGroup'

// 설정 화면 (PLAN.md §4) — 담당 B
// LLM·API 키 / 단축키 / 문맥 범위(Byte) / 언어
// 메인 창 안에서 해시 라우팅으로 뜬다(#/main ↔ #/settings, 별도 창 아님).

// 언어 수동 선택 드롭다운(2026-07-30) — tier1/tier2-A/tier2-B 세 그룹으로 나눠 <optgroup>
// 으로 묶는다(네이티브 select 가 그룹마다 굵은 라벨+들여쓰기로 시각적 구분선을 그려줌).
// tier2는 naverDictCode 유무로 A(네이버 사전 있음)/B(없음)를 가른다 — shared/languages.ts
// LinkLanguageInfo 주석 참고. 각 그룹 안에서는 한국어 이름 가나다순으로 정렬해 찾기 쉽게 한다.
const TIER2_A_CODES: AnyLanguage[] = (Object.keys(LINK_LANGUAGES) as (keyof typeof LINK_LANGUAGES)[])
  .filter((code) => LINK_LANGUAGES[code].naverDictCode !== undefined)
  .sort((a, b) => LINK_LANGUAGES[a].koName.localeCompare(LINK_LANGUAGES[b].koName, 'ko'))
const TIER2_B_CODES: AnyLanguage[] = (Object.keys(LINK_LANGUAGES) as (keyof typeof LINK_LANGUAGES)[])
  .filter((code) => LINK_LANGUAGES[code].naverDictCode === undefined)
  .sort((a, b) => LINK_LANGUAGES[a].koName.localeCompare(LINK_LANGUAGES[b].koName, 'ko'))
const TIER1_CODES_SORTED: AnyLanguage[] = [...LANGUAGE_ORDER].sort((a, b) =>
  LANGUAGES[a].koName.localeCompare(LANGUAGES[b].koName, 'ko'),
)

function languageLabel(code: AnyLanguage): string {
  const info = code in LANGUAGES ? LANGUAGES[code as keyof typeof LANGUAGES] : LINK_LANGUAGES[code as keyof typeof LINK_LANGUAGES]
  return `${info.koName} (${info.nativeName})`
}

// Byte 예산은 자유 지정(고정 단위 없음). 슬라이더 범위/숫자 입력 공통 하한.
// 상한(BYTE_MAX)은 미리보기 글 길이에서 자동 산출한다(아래, PREVIEW_TEXT 정의 후).
const BYTE_MIN = 0

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return BYTE_MIN
  return Math.max(BYTE_MIN, Math.min(BYTE_MAX, Math.round(n)))
}

// 미리보기 예시 — Lorem Ipsum. 선택 영역 기준으로 앞/뒤 바이트 범위 +
// 문장 경계 확장을 실시간 시각화한다.
const PREVIEW_TEXT = ` Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
 Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt, neque porro quisquam est.
 Qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem. Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur qui in ea voluptate velit esse quam nihil molestiae consequatur.
 Vel illum qui dolorem eum fugiat quo voluptas nulla pariatur. At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident, similique sunt in culpa qui officia deserunt mollitia animi, id est laborum et dolorum fuga.
 Et harum quidem rerum facilis est et expedita distinctio. Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus, omnis voluptas assumenda est, omnis dolor repellendus. Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet ut et voluptates repudiandae sint et molestiae non recusandae.
 Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis voluptatibus maiores alias consequatur aut perferendis doloribus asperiores repellat. Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur excepteur sint occaecat cupidatat.
 Nam libero tempore cum soluta nobis est eligendi optio cumque nihil impedit, quo minus id quod maxime placeat facere possimus, omnis voluptas assumenda est. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.
 Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est qui dolorem ipsum quia dolor sit amet consectetur adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.
 Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur. Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur sint obcaecati.
 Doloremque laudantium totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt, neque porro quisquam est qui dolorem ipsum quia dolor sit amet consectetur adipisci velit numquam.`

// 선택 표현 = 전체 글의 정중앙에 걸친 단어를 중심으로 앞뒤 1개씩, 총 3개 단어(앞뒤 문장부호 제거).
// 먼저 모든 단어를 훑어 그 중심이 글 중앙에 가장 가까운 단어(중앙 단어)를 찾고,
// 그 앞뒤 단어까지 묶어 선택한다 → 중앙 지점이 공백/부호에 걸려도 치우치지 않는다.
// 라틴 + CJK(일본어·중국어) 전용 문장부호까지 포함 — 선택 양끝의 부호만 제거.
// CJK: 、。，．・！？；：（）｛｝［］〔〕〖〗【】〈〉《》「」『』〝〞〟〜～‥
const WORD_EDGE_PUNCT =
  /[-.,!?;:'"“”‘’()[\]—…、。，．・！？；：（）｛｝［］〔〕〖〗【】〈〉《》「」『』〝〞〟〜～‥]/
const WORD_RE = /\S+/g
const PREVIEW_SEL_WORDS = 3 // 사용자 선택 영역으로 강조할 단어 수(중앙 단어 ± 좌우)

function centerWords(text: string, count: number): [number, number] {
  // 1) 모든 단어의 [start, end)(양끝 부호 제거) 수집
  const words: Array<[number, number]> = []
  let m: RegExpExecArray | null
  WORD_RE.lastIndex = 0
  while ((m = WORD_RE.exec(text))) {
    let s = m.index
    let e = m.index + m[0].length
    while (s < e && WORD_EDGE_PUNCT.test(text[s])) s += 1
    while (e > s && WORD_EDGE_PUNCT.test(text[e - 1])) e -= 1
    if (s < e) words.push([s, e]) // 부호만으로 이루어진 토큰은 제외
  }
  if (words.length === 0) return [0, 0]

  // 2) 중심이 글 중앙에 가장 가까운 단어 찾기
  const mid = text.length / 2
  let ci = 0
  let bestDist = Infinity
  words.forEach(([s, e], i) => {
    const dist = Math.abs((s + e) / 2 - mid)
    if (dist < bestDist) {
      bestDist = dist
      ci = i
    }
  })

  // 3) 중앙 단어 기준 좌우로 균등하게 count 개까지 확장
  const half = Math.floor((count - 1) / 2)
  const from = Math.max(0, ci - half)
  const to = Math.min(words.length - 1, from + count - 1)
  return [words[from]![0], words[to]![1]]
}
const [PREVIEW_SEL_START, PREVIEW_SEL_END] = centerWords(PREVIEW_TEXT, PREVIEW_SEL_WORDS)

// 상한 = 선택 중앙에서 앞/뒤로 미리보기 전체를 덮는 데 필요한 바이트(더 긴 쪽 절반).
// 최대로 올리면 예시 전체가 선택 범위로 표시된다. 미리보기 글을 바꾸면 자동 반영.
const BYTE_MAX = Math.max(
  byteLength(PREVIEW_TEXT.slice(0, PREVIEW_SEL_START)),
  byteLength(PREVIEW_TEXT.slice(PREVIEW_SEL_END)),
)

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

/** 키 검증 실패 사유(QuestionErrorCode) → 설정 화면 안내 문구 */
function validationMessage(code?: QuestionErrorCode): string {
  switch (code) {
    case 'invalid_api_key':
    case 'no_api_key':
      return '유효하지 않은 API 키입니다.'
    case 'insufficient_credit':
      return '키는 유효하지만 크레딧(사용 한도)이 부족합니다. 결제 정보를 확인해 주세요.'
    case 'rate_limited':
      return '요청이 많아 확인에 실패했습니다. 잠시 후 다시 시도하세요.'
    case 'network_error':
      return '네트워크 오류로 확인하지 못했습니다.'
    case 'invalid_model':
      return '이 모델을 찾을 수 없습니다(단종되었거나 이름이 바뀌었을 수 있습니다).'
    default:
      return '키를 확인하지 못했습니다.'
  }
}

// Electron accelerator 토큰을 화면 표시용 라벨로 바꾼다. 'CommandOrControl' 은 이제 새로
// 녹화되진 않지만, 과거에 저장된 값(예: 이전 기본값)을 열었을 때도 깨지지 않게 표시만 유지.
const MODIFIER_LABELS: Record<string, string> = IS_MAC
  ? { Command: 'Cmd', Control: 'Ctrl', CommandOrControl: 'Cmd', Alt: 'Opt', Shift: 'Shift' }
  : { Command: 'Ctrl', Control: 'Ctrl', CommandOrControl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }

// 수식키가 아닌 실제 키는 풀네임 대신 흔히 쓰는 약어/기호로 표시한다.
const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  Enter: '↵',
  ' ': 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

function formatAccelerator(accelerator: string): string {
  if (!accelerator) return '해제됨'
  return accelerator
    .split('+')
    .map((token) => MODIFIER_LABELS[token] ?? KEY_LABELS[token] ?? token)
    .join(' + ')
}

/** 뒤로가기/Esc 로 설정 화면을 나갈 때 — 이미 선택된 창이 있으면(백그라운드 실행 중 설정만
 *  열어본 상황) 메인 화면(창 선택 안내)으로 돌아갈 필요가 없다. 그 화면은 "아직 아무 창도
 *  선택 안 한" 초기 상태를 위한 것이라, 이미 선택돼 있는데 거기로 갔다가 다시 트레이로
 *  숨겨야 하는 건 불필요한 경유다 — window.close() 로 창을 바로 닫는다(메인 창은
 *  windows.ts: createMainWindow 의 close 핸들러가 실제 종료가 아니면 항상 hide 로 가로채므로,
 *  안전하게 "트레이로 숨기기"와 동일하게 동작한다 — SELECT_WINDOW 직후 getMainWindow()?.hide()
 *  하는 것과 같은 패턴). 선택된 창이 없으면 기존처럼 메인 화면으로. */
function exitSettings(hasSelection: boolean): void {
  if (hasSelection) window.close()
  else goto('main')
}

export function SettingsScreen() {
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  useEffect(() => {
    window.nuance.getSelectedWindowId().then((id) => setHasSelection(id !== null))
  }, [])
  const [apiKey, setApiKeyState] = useState('')
  const [keyEditing, setKeyEditing] = useState(false)
  const [keyVisible, setKeyVisible] = useState(false)
  // 지금 키 입력을 기다리는 단축키 필드 — null 이면 녹화 중이 아님. 두 단축키(모드 전환/설정
  // 화면 열기)가 같은 녹화 UI 를 공유하므로 어느 필드를 채울지 여기서 구분한다.
  const [recordingField, setRecordingField] = useState<
    | 'modeShortcut'
    | 'settingsShortcut'
    | 'windowSelectShortcut'
    | 'windowDeselectShortcut'
    | 'manualRegionShortcut'
    | 'forceOcrShortcut'
    | null
  >(null)
  // 현재 provider 의 키 검증 결과(유효성 + 사용 가능 모델). 무과금 GET 기반.
  const [validation, setValidation] = useState<ProviderValidation | null>(null)
  const [validating, setValidating] = useState(false)
  // 모델 드롭다운에서 실제 선택을 확정하기 전 1회 실호출로 동작 여부 확인(유과금, 토큰 1개).
  const [modelTesting, setModelTesting] = useState(false)
  const [modelTestError, setModelTestError] = useState<string | null>(null)

  // Merriam-Webster 사전 API 키 — LLM 과 별개 키(provider 선택 개념이 없어 항상 'mw' 고정).
  const [mwApiKey, setMwApiKeyState] = useState('')
  const [mwKeyEditing, setMwKeyEditing] = useState(false)
  const [mwKeyVisible, setMwKeyVisible] = useState(false)

  useEffect(() => {
    window.nuance.getApiKey('mw').then((k) => setMwApiKeyState(k ?? ''))
  }, [])

  const previewRef = useRef<HTMLDivElement>(null)
  const selRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    window.nuance.getSettings().then(setSettingsState)
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
    setValidation(null) // provider 가 바뀌면 이전 검증 결과 무효화
    setModelTestError(null) // 모델 검증 에러도 같이 초기화(다른 provider 의 메시지가 남지 않게)
    // llm 이 바뀔 때만 다시 조회하면 된다(의도적으로 settings 전체가 아닌 llm 만 의존).
  }, [settings?.llm])

  // provider 선택(키 있으면) + 키 입력/수정 시 → 디바운스 후 무과금 검증(유효성 + 모델 목록).
  useEffect(() => {
    const provider = settings?.llm
    const key = apiKey.trim()
    if (!provider || !key) {
      setValidation(null)
      setValidating(false)
      return
    }
    let active = true
    setValidating(true)
    const t = setTimeout(() => {
      void window.nuance.validateProvider(provider, key).then((v) => {
        if (!active) return
        setValidation(v)
        setValidating(false)
      })
    }, 500)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [settings?.llm, apiKey])

  // Esc → 나가기(exitSettings, 위 주석 참고). 단축키 녹화 중(recording)엔 Esc 가 "녹화
  // 취소" 의미로 이미 따로 처리되고 있어(위 useEffect) 그동안엔 건너뛴다.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !recordingField) exitSettings(hasSelection)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [recordingField, hasSelection])

  // 미리보기 스크롤을 선택 표현 위치(중앙)로 이동 — 미리보기가 처음 뜰 때 1회만.
  // (바이트 값을 바꿀 때는 스크롤을 건드리지 않아 사용자가 보던 위치를 유지한다.)
  const previewCenteredRef = useRef(false)
  useEffect(() => {
    if (previewCenteredRef.current) return
    const box = previewRef.current
    const sel = selRef.current
    if (box && sel) {
      box.scrollTop = sel.offsetTop - box.clientHeight / 2 + sel.clientHeight / 2
      previewCenteredRef.current = true
    }
  }, [settings != null])

  useEffect(() => {
    if (!recordingField) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setRecordingField(null) // 취소 — 기존 단축키 유지
        return
      }
      const accelerator = toAccelerator(e)
      if (!accelerator) return // 유효하지 않은 조합은 무시하고 계속 대기
      const field = recordingField
      setRecordingField(null)
      void patch({ [field]: accelerator })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // recordingField 에만 반응하면 된다(patch 는 재실행 불필요).
  }, [recordingField])

  if (!settings) return <div className="screen settings-screen" />

  async function patch(p: Partial<AppSettings>) {
    const next = await window.nuance.setSettings(p)
    setSettingsState(next)
  }

  /** 모델 드롭다운 선택 확정 — /v1/models 등 목록 조회는 무과금이라 "이름이 존재한다"만
   *  보장하고 "실제로 된다"는 안 보장한다(단종·파라미터 제약 등) — 실제로 저장하기 전에
   *  최소 비용(토큰 1개) 실호출로 한 번 검증한다. Default 는 우리가 고른 안정적인 값이라
   *  검증 없이 바로 저장한다. */
  async function selectModel(value: string) {
    setModelTestError(null)
    if (!value) {
      await patch({ models: { ...settings!.models, [settings!.llm!]: value } })
      return
    }
    setModelTesting(true)
    const error = await window.nuance.testModel(settings!.llm!, apiKey.trim(), value)
    setModelTesting(false)
    if (error) {
      setModelTestError(`"${value}" 모델을 사용할 수 없습니다 — ${validationMessage(error)}`)
      return
    }
    await patch({ models: { ...settings!.models, [settings!.llm!]: value } })
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

  async function saveMwKey() {
    setMwKeyEditing(false)
    const trimmed = mwApiKey.trim()
    if (trimmed) await window.nuance.setApiKey('mw', trimmed)
  }

  async function deleteMwKey() {
    if (!window.confirm('Merriam-Webster API 키를 정말 삭제하시겠습니까?')) return
    await window.nuance.deleteApiKey('mw')
    setMwApiKeyState('')
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

  // provider 를 바꾼 직후에는 setValidation(null) 이 useEffect 에서 한 렌더 늦게 반영돼,
  // 그 사이 잠깐 이전 provider 의 validation(모델 목록 등)이 새 provider 아래 그대로
  // 보이는 깜빡임이 있었다. provider 가 실제로 일치할 때만 신뢰하도록 렌더에서 바로 걸러낸다.
  const currentValidation = validation?.provider === settings.llm ? validation : null

  // 미리보기: 선택 기준 앞/뒤 바이트 범위 + 문장 경계 확장 범위 계산
  const range = computeContextRange(
    PREVIEW_TEXT,
    PREVIEW_SEL_START,
    PREVIEW_SEL_END,
    settings.contextBytesBefore,
    settings.contextBytesAfter,
  )
  return (
    <div className="screen settings-screen">
      <div className="settings-header">
        <button className="icon-btn back" onClick={() => exitSettings(hasSelection)}>
          ←
        </button>
        <h1>설정</h1>
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
                {active && (
                  <span className="check">
                    <CheckIcon />
                  </span>
                )}
                <span className="icon">
                  <ProviderLogo provider={p} />
                </span>
                <span className="label">{info.label}</span>
              </button>
            )
          })}
        </div>

        {settings.llm && (
          <div className="apikey-row">
            <div className="apikey-main">
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
                  {keyVisible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <div className="apikey-actions">
              <EditDeleteGroup
                onEdit={() => setKeyEditing(true)}
                onDelete={() => void deleteKey()}
                deleteTitle="API 키 삭제"
                deleteDisabled={!apiKey}
              />
            </div>
          </div>
        )}

        {settings.llm && !apiKey.trim() && (
          <a
            className="apikey-signup-link"
            href={PROVIDERS[settings.llm].signupUrl}
            target="_blank"
            rel="noreferrer"
          >
            아직 {PROVIDERS[settings.llm].label} 키가 없으신가요? 발급받으러 가기 →
          </a>
        )}

        {/* 키 검증 상태 + 사용 모델 선택 (무과금 GET 기반) */}
        {settings.llm && apiKey.trim() && (
          <div className="provider-status">
            {validating ? (
              <span className="muted">API 키 확인 중…</span>
            ) : currentValidation?.ok ? (
              <>
                <span className="ok">
                  <CheckIcon /> 유효한 키 · 사용 가능 모델 {currentValidation.models.length}개
                </span>
                <label className="model-select">
                  <span>사용 모델</span>
                  <select
                    value={settings.models[settings.llm] ?? ''}
                    disabled={modelTesting}
                    onChange={(e) => void selectModel(e.target.value)}
                  >
                    <option value="">Default ({DEFAULT_MODELS[settings.llm]})</option>
                    {currentValidation.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                {modelTesting && <span className="muted">선택한 모델이 실제로 동작하는지 확인 중…</span>}
                {modelTestError && (
                  <span className="err">
                    <WarnIcon /> {modelTestError}
                  </span>
                )}
              </>
            ) : currentValidation ? (
              <span className="err">
                <WarnIcon /> {validationMessage(currentValidation.error)}
              </span>
            ) : null}
          </div>
        )}

        {!aiReady && (
          <div className="settings-warning">
            <WarnIcon />{' '}
            {settings.llm
              ? 'API 키가 입력되지 않아 AI 관련 기능(발음·사전·통합 질문)을 사용할 수 없습니다.'
              : '사용할 LLM을 선택하고 API 키를 입력해야 AI 관련 기능을 사용할 수 있습니다.'}
          </div>
        )}

        <div className="settings-note">
          <LockIcon /> API 키는 안전하게 암호화되어 저장되며, 외부로 전송되지 않습니다.
        </div>
      </section>

      {/* 사전 API 키 (Merriam-Webster) — LLM 과 별개 섹션 (PLAN.md §6) */}
      <section className="settings-section">
        <h2>Merriam-Webster 사전 API 키</h2>
        <p className="desc">
          영어 사전 검색에 Merriam-Webster를 사용하려면 API 키를 입력하세요. 반드시{' '}
          <b>Collegiate(Dictionary) 사전</b>으로 발급받은 키여야 합니다(Learner&apos;s 등 다른
          사전 키는 동작하지 않습니다). 무료 키는 <b>키 1개당 하루 1,000회</b>까지 조회할 수
          있습니다. 입력하지 않아도 다른 사전(Open English WordNet 등)으로 자동 대체되어 사전 기능은
          계속 사용할 수 있습니다.
        </p>

        <div className="apikey-row">
          <div className="apikey-main">
            <div className="apikey-field">
              <input
                type={mwKeyVisible ? 'text' : 'password'}
                value={mwApiKey}
                disabled={!mwKeyEditing}
                placeholder="API 키를 입력하세요"
                onChange={(e) => setMwApiKeyState(e.target.value)}
                onBlur={() => mwKeyEditing && void saveMwKey()}
                onKeyDown={(e) => e.key === 'Enter' && void saveMwKey()}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setMwKeyVisible((v) => !v)}
                title={mwKeyVisible ? '숨기기' : '보기'}
              >
                {mwKeyVisible ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <div className="apikey-actions">
            <EditDeleteGroup
              onEdit={() => setMwKeyEditing(true)}
              onDelete={() => void deleteMwKey()}
              deleteTitle="API 키 삭제"
              deleteDisabled={!mwApiKey}
            />
          </div>
        </div>

        {!mwApiKey.trim() && (
          <a
            className="apikey-signup-link"
            href={MW_DICTIONARY_SIGNUP_URL}
            target="_blank"
            rel="noreferrer"
          >
            아직 Merriam-Webster 키가 없으신가요? 발급받으러 가기 →
          </a>
        )}
      </section>

      {/* 단축키 설정 */}
      <section className="settings-section">
        <h2>단축키</h2>
        <p className="desc">연필 아이콘을 눌러 원하는 키 조합으로 다시 등록할 수 있습니다.</p>
        <div className="shortcut-row">
          <span className="label">모드 전환 (일반 ↔ 선택)</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'modeShortcut' ? ' recording' : ''}`}>
              {recordingField === 'modeShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.modeShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('modeShortcut')}
              onDelete={() => void patch({ modeShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.modeShortcut}
            />
          </div>
        </div>
        <div className="shortcut-row">
          <span className="label">창 선택 / 전환</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'windowSelectShortcut' ? ' recording' : ''}`}>
              {recordingField === 'windowSelectShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.windowSelectShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('windowSelectShortcut')}
              onDelete={() => void patch({ windowSelectShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.windowSelectShortcut}
            />
          </div>
        </div>
        <div className="shortcut-row">
          <span className="label">창 선택 해제</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'windowDeselectShortcut' ? ' recording' : ''}`}>
              {recordingField === 'windowDeselectShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.windowDeselectShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('windowDeselectShortcut')}
              onDelete={() => void patch({ windowDeselectShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.windowDeselectShortcut}
            />
          </div>
        </div>
        <div className="shortcut-row">
          <span className="label">영역 수동 선택</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'manualRegionShortcut' ? ' recording' : ''}`}>
              {recordingField === 'manualRegionShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.manualRegionShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('manualRegionShortcut')}
              onDelete={() => void patch({ manualRegionShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.manualRegionShortcut}
            />
          </div>
        </div>
        <div className="shortcut-row">
          <span className="label">OCR로 전환</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'forceOcrShortcut' ? ' recording' : ''}`}>
              {recordingField === 'forceOcrShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.forceOcrShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('forceOcrShortcut')}
              onDelete={() => void patch({ forceOcrShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.forceOcrShortcut}
            />
          </div>
        </div>
        <div className="shortcut-row">
          <span className="label">설정 화면 열기</span>
          <div className="shortcut-control">
            <span className={`shortcut-keys${recordingField === 'settingsShortcut' ? ' recording' : ''}`}>
              {recordingField === 'settingsShortcut'
                ? '수식키+키 입력 (Esc 취소)'
                : formatAccelerator(settings.settingsShortcut)}
            </span>
            <EditDeleteGroup
              onEdit={() => setRecordingField('settingsShortcut')}
              onDelete={() => void patch({ settingsShortcut: '' })}
              deleteTitle="단축키 해제"
              deleteDisabled={!settings.settingsShortcut}
            />
          </div>
        </div>
      </section>

      {/* 문맥 범위(Byte) */}
      <section className="settings-section">
        <h2>문맥 범위 (Byte)</h2>
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
            <span className="swatch range" /> 바이트 범위
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
          <InfoIcon /> 범위를 넓게 잡을수록 AI가 문맥을 더 잘 이해하지만, 전달 텍스트가 늘어 요청
          비용도 증가합니다.
        </div>
      </section>

      {/* 텍스트 영역 자동 탐지 */}
      <section className="settings-section">
        <h2>텍스트 영역 자동 탐지</h2>
        <p className="desc">
          활성화 시 선택 모드로 전환을 하거나 선택 모드 내에서 창의 크기가 변할 때 자동으로
          텍스트 영역을 탐지합니다. 탐지된 영역은 모드 전환 단축키로 확인할 수 있으며,
          페이지 구조에 따라 본문이 아닌 영역(헤더·사이드바 등)이 노이즈로 함께 잡힐 수
          있습니다. 원하는 결과가 아니라면 선택 모드에서 트레이 메뉴의 &quot;영역 수동
          선택&quot;으로 직접 지정할 수 있습니다.
        </p>
        <label className="byte-link-toggle">
          <input
            type="checkbox"
            checked={settings.autoDetectRegion}
            onChange={(e) => void patch({ autoDetectRegion: e.target.checked })}
          />
          활성화
        </label>
      </section>

      {/* 언어 선택 */}
      <section className="settings-section">
        <h2>언어 선택</h2>
        <p className="desc">
          자동: 자막/화면 텍스트로 언어를 매번 자동 판별합니다. 대부분의 경우 정확하지만,
          라틴·키릴·아랍·데바나가리 문자를 공유하는 언어(예: 프랑스어/독일어/스페인어 등)가
          섞인 콘텐츠에서는 판별이 흔들릴 수 있습니다. 특정 언어를 선택하면 이 판별 자체를
          건너뛰고 항상 해당 언어로 확정합니다 — 자동 판별이 계속 틀리는 콘텐츠를 볼 때
          유용합니다.
        </p>
        <p className="desc">
          지원 범위는 3단계입니다 — <strong>1단계</strong>(영어·일본어·중국어): 언어 특화
          OCR · 사전 검색 · 특화된 발음 표기(히라가나/한어병음 등 그 언어 학습에 맞는 표기) · 형태소 분석기까지
          전부 지원합니다. <strong>2단계</strong>: 범용 OCR과 IPA 발음, 구글 발음 검색은 되지만
          사전 검색 기능은 없습니다 — 그중 네이버 사전 연결까지 되는 언어가{' '}
          <strong>2단계(A)</strong>, 안 되는 언어가 <strong>2단계(B)</strong>입니다(아래
          목록에서 구분).
        </p>
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
              <div className="desc">자막/화면 텍스트로 언어를 매번 자동으로 판별합니다.</div>
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
              <div className="title">사용자 지정</div>
              <div className="desc">
                자동 판별을 끄고 항상 선택한 언어 하나로 고정합니다.
              </div>
            </div>
            <div className="lang-select">
              <select
                value={settings.language === 'auto' ? LANGUAGE_ORDER[0] : settings.language}
                disabled={settings.language === 'auto'}
                onChange={(e) => void patch({ language: e.target.value as AnyLanguage })}
              >
                <optgroup label="1단계 — 특화 OCR · 사전 · 특화된 발음 · 형태소 분석기 전부 지원">
                  {TIER1_CODES_SORTED.map((code) => (
                    <option key={code} value={code}>
                      {languageLabel(code)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="2단계(A) — 네이버 사전 지원, 범용 OCR · 발음(IPA) · 구글">
                  {TIER2_A_CODES.map((code) => (
                    <option key={code} value={code}>
                      {languageLabel(code)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="2단계(B) — 네이버 사전 미지원, 범용 OCR · 발음(IPA) · 구글">
                  {TIER2_B_CODES.map((code) => (
                    <option key={code} value={code}>
                      {languageLabel(code)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          </label>
        </div>
      </section>
    </div>
  )
}
