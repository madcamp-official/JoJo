import { useEffect, useRef } from 'react'
import { AlignJustify, AlignLeft, AlignRight } from 'lucide-react'
import type { PageTransition, ViewerMode } from './pager'

// 읽기 스타일 설정 패널 — 툴바에 슬라이더를 늘어놓으면 메뉴바가 금방 지저분해져서
// (글자 크기/자간/줄 간격/여백/넘김 효과) 버튼 하나 뒤로 접어두고, 누를 때만 카드로 띄운다.

export type TextAlign = 'left' | 'justify' | 'right'

export interface ViewerStyle {
  fontSize: number
  letterSpacing: number
  lineHeight: number
  margin: number
  textAlign: TextAlign
}

export const STYLE_LIMITS = {
  fontSize: { min: 12, max: 32, step: 1, unit: 'px' },
  letterSpacing: { min: -1, max: 4, step: 0.1, unit: 'px' },
  lineHeight: { min: 1.2, max: 2.6, step: 0.05, unit: '' },
  margin: { min: 0, max: 320, step: 8, unit: 'px' },
} as const

export const DEFAULT_STYLE: ViewerStyle = {
  fontSize: 18,
  letterSpacing: 0,
  lineHeight: 1.8,
  margin: 72,
  textAlign: 'left',
}

// 마지막으로 쓴 보기 설정을 기억한다 — 문서를 열 때마다 다시 맞추게 하지 않으려는 것.
// 뷰어 창의 렌더러 localStorage 에 둔다(userData 폴더에 붙어 있어 앱을 껐다 켜도 남는다).
// 앱 전역 설정(settingsStore)에 넣지 않은 이유: 이건 순수 화면 취향이라 다른 기능과
// 공유할 일이 없고, 메인 프로세스를 오갈 이유도 없다.
const STORE_KEY = 'nuance.viewer.prefs.v1'

export interface ViewerPrefs {
  style: ViewerStyle
  mode: ViewerMode
  transition: PageTransition
  dark: boolean
}

export const DEFAULT_PREFS: ViewerPrefs = {
  style: DEFAULT_STYLE,
  mode: 'scroll',
  transition: 'slide',
  dark: false,
}

export function loadViewerPrefs(): ViewerPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_PREFS
    const saved = JSON.parse(raw) as Partial<ViewerPrefs>
    // 저장된 값이 낡았거나 일부만 있어도 기본값으로 메운다(항목이 늘어날 수 있으므로).
    return {
      ...DEFAULT_PREFS,
      ...saved,
      style: { ...DEFAULT_STYLE, ...(saved.style ?? {}) },
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function saveViewerPrefs(prefs: ViewerPrefs): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs))
  } catch {
    // 저장 실패는 기능을 막을 이유가 아니다(용량 초과 등) — 이번 세션만 기억 못 할 뿐.
  }
}

// 정렬 — 아이콘만으로 충분히 읽히는 선택지라 라벨 없이 아이콘 버튼 세 개로 둔다.
const ALIGNS: { value: TextAlign; label: string; Icon: typeof AlignLeft }[] = [
  { value: 'left', label: '왼쪽 정렬', Icon: AlignLeft },
  { value: 'justify', label: '양쪽 정렬', Icon: AlignJustify },
  { value: 'right', label: '오른쪽 정렬', Icon: AlignRight },
]

/** 슬라이더로 다루는 항목만 — 정렬은 값이 숫자가 아니라 위 ALIGNS 로 따로 그린다. */
type SliderKey = 'fontSize' | 'letterSpacing' | 'lineHeight' | 'margin'

const ROWS: { key: SliderKey; label: string; digits: number }[] = [
  { key: 'fontSize', label: '글자 크기', digits: 0 },
  { key: 'letterSpacing', label: '자간', digits: 1 },
  { key: 'lineHeight', label: '행간', digits: 2 },
  { key: 'margin', label: '여백', digits: 0 },
]

export function ViewerSettings({
  open,
  onClose,
  style,
  onChange,
  /** 리플로우 가능한 포맷(txt/epub)에서만 글자 관련 항목을 보여준다 — PDF 는 원본 레이아웃 유지. */
  showTextStyle,
  showTransition,
  transition,
  onTransitionChange,
  mode,
  onModeChange,
  showTheme,
  dark,
  onDarkChange,
}: {
  open: boolean
  onClose: () => void
  style: ViewerStyle
  onChange: (next: ViewerStyle) => void
  showTextStyle: boolean
  showTransition: boolean
  transition: PageTransition
  onTransitionChange: (t: PageTransition) => void
  mode: ViewerMode
  onModeChange: (m: ViewerMode) => void
  /** 다크 모드는 리플로우 포맷에서만 — PDF 는 원본 레이아웃을 그대로 보여준다. */
  showTheme: boolean
  dark: boolean
  onDarkChange: (v: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // 바깥을 누르거나 Esc 로 닫는다 — 패널이 본문을 가리므로 쉽게 치울 수 있어야 한다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node
      // 패널 자신과 여는 버튼 위 클릭은 "바깥"이 아니다(버튼은 토글이라 여기서 닫으면
      // 곧바로 다시 열려 깜빡인다).
      if (ref.current?.contains(el)) return
      if ((el as HTMLElement).closest?.('.viewer-style-btn')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)

    // epub 본문은 iframe 안에 있어서 거기서 누른 mousedown 은 부모 창까지 오지 않는다 —
    // 본문을 클릭해도 패널이 안 닫히던 이유다(2026-07-31 실측 재현). 지금 떠 있는 뷰어
    // iframe 문서에도 같은 리스너를 달아준다. 클릭 위치는 어차피 패널 밖이므로 바로 닫는다.
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('.viewer-body iframe'))
    const innerDocs = frames.map((f) => f.contentDocument).filter((d): d is Document => !!d)
    const onInnerDown = (): void => onClose()
    for (const d of innerDocs) d.addEventListener('mousedown', onInnerDown)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      for (const d of innerDocs) d.removeEventListener('mousedown', onInnerDown)
    }
  }, [open, onClose])

  if (!open) return null

  const rows = showTextStyle ? ROWS : ROWS.filter((r) => r.key === 'margin')

  return (
    <div className="viewer-style-panel" ref={ref}>
      <div className="style-row">
        <span className="style-label">읽기 방식</span>
        <div className="style-toggle">
          <button className={mode === 'scroll' ? 'on' : ''} onClick={() => onModeChange('scroll')}>
            스크롤
          </button>
          <button className={mode === 'page' ? 'on' : ''} onClick={() => onModeChange('page')}>
            페이지
          </button>
        </div>
      </div>

      {showTransition && (
        <div className="style-row">
          <span className="style-label">넘김 효과</span>
          {/* 선택지가 둘뿐이라 드롭다운 대신 좌우로 붙은 토글이 더 빠르고 깔끔하다. */}
          <div className="style-toggle">
            <button className={transition === 'none' ? 'on' : ''} onClick={() => onTransitionChange('none')}>
              없음
            </button>
            <button className={transition === 'slide' ? 'on' : ''} onClick={() => onTransitionChange('slide')}>
              슬라이딩
            </button>
          </div>
        </div>
      )}

      {showTheme && (
        <div className="style-row">
          <span className="style-label">테마</span>
          <div className="style-toggle">
            <button className={!dark ? 'on' : ''} onClick={() => onDarkChange(false)}>
              라이트
            </button>
            <button className={dark ? 'on' : ''} onClick={() => onDarkChange(true)}>
              다크
            </button>
          </div>
        </div>
      )}

      {(showTextStyle || showTransition) && <div className="style-divider" />}

      {showTextStyle &&
        rows.map((row) => {
          const lim = STYLE_LIMITS[row.key]
          return (
            <label className="style-row" key={row.key}>
              <span className="style-label">{row.label}</span>
              <input
                type="range"
                min={lim.min}
                max={lim.max}
                step={lim.step}
                value={style[row.key]}
                onChange={(e) => onChange({ ...style, [row.key]: Number(e.target.value) })}
              />
              <span className="style-value">
                {style[row.key].toFixed(row.digits)}
                {lim.unit}
              </span>
            </label>
          )
        })}

      {showTextStyle && (
        <div className="style-row">
          <span className="style-label">정렬</span>
          <div className="style-toggle align">
            {ALIGNS.map(({ value, label, Icon }) => (
              <button
                key={value}
                className={style.textAlign === value ? 'on' : ''}
                title={label}
                aria-label={label}
                onClick={() => onChange({ ...style, textAlign: value })}
              >
                <Icon size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
