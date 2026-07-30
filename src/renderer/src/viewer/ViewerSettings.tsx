import { useEffect, useRef } from 'react'
import type { PageTransition } from './pager'

// 읽기 스타일 설정 패널 — 툴바에 슬라이더를 늘어놓으면 메뉴바가 금방 지저분해져서
// (글자 크기/자간/줄 간격/여백/넘김 효과) 버튼 하나 뒤로 접어두고, 누를 때만 카드로 띄운다.

export interface ViewerStyle {
  fontSize: number
  letterSpacing: number
  lineHeight: number
  margin: number
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
}

const ROWS: { key: keyof ViewerStyle; label: string; digits: number }[] = [
  { key: 'fontSize', label: '글자 크기', digits: 0 },
  { key: 'letterSpacing', label: '자간', digits: 1 },
  { key: 'lineHeight', label: '줄 간격', digits: 2 },
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
}: {
  open: boolean
  onClose: () => void
  style: ViewerStyle
  onChange: (next: ViewerStyle) => void
  showTextStyle: boolean
  showTransition: boolean
  transition: PageTransition
  onTransitionChange: (t: PageTransition) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // 바깥을 누르거나 Esc 로 닫는다 — 패널이 본문을 가리므로 쉽게 치울 수 있어야 한다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node
      if (ref.current && !ref.current.contains(el) && !(el as HTMLElement).closest?.('.viewer-style-btn')) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const rows = showTextStyle ? ROWS : ROWS.filter((r) => r.key === 'margin')

  return (
    <div className="viewer-style-panel" ref={ref}>
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

      {!showTextStyle && (
        <p className="style-note">PDF는 원본 레이아웃을 그대로 보여줘서 글자 설정이 없어요.</p>
      )}

      {showTransition && (
        <>
          <div className="style-divider" />
          <div className="style-row">
            <span className="style-label">넘김 효과</span>
            {/* 선택지가 둘뿐이라 드롭다운 대신 좌우로 붙은 토글이 더 빠르고 깔끔하다. */}
            <div className="style-toggle">
              <button
                className={transition === 'none' ? 'on' : ''}
                onClick={() => onTransitionChange('none')}
              >
                없음
              </button>
              <button
                className={transition === 'slide' ? 'on' : ''}
                onClick={() => onTransitionChange('slide')}
              >
                슬라이딩
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
