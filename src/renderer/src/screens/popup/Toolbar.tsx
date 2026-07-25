import type { Language } from '@shared/types'

// 담당 B — 팝업 툴바 (PLAN.md §3/§4.2)
// [발음]·[사전] 체크박스 토글 · 구글 발음/이미지 버튼. 통합 질문 입력은 하단 채팅 입력창.

interface Props {
  language: Language
  pron: boolean
  dict: boolean
  onTogglePron: () => void
  onToggleDict: () => void
  onGoogle: (mode: 'pron' | 'image') => void
  disabled?: boolean
}

export function Toolbar({ language, pron, dict, onTogglePron, onToggleDict, onGoogle, disabled }: Props) {
  return (
    <div className="toolbar">
      <span className="llm-badge" title="사용 중인 AI 모델은 설정에서 선택합니다">
        ✨ AI
      </span>

      <label className={`chk ${pron ? 'on' : ''}`}>
        <input type="checkbox" checked={pron} disabled={disabled} onChange={onTogglePron} />
        발음
      </label>

      <label className={`chk ${dict ? 'on' : ''}`}>
        <input type="checkbox" checked={dict} disabled={disabled} onChange={onToggleDict} />
        사전
      </label>

      <span className="tb-spacer" />

      <button className="tb-btn" title="구글 발음 검색" onClick={() => onGoogle('pron')}>
        🔊 발음
      </button>
      <button className="tb-btn" title="구글 이미지 검색" onClick={() => onGoogle('image')}>
        🖼 이미지
      </button>
      <span className="lang-tag">{language.toUpperCase()}</span>
    </div>
  )
}
