// 담당 B — 팝업 툴바 (PLAN.md §3/§4.2)
// [발음]·[사전] 버튼 — 누르면 즉시 채팅에 질문을 넣고 LLM 요청 · 구글 발음/이미지 버튼.
// 통합 질문 입력은 하단 채팅 입력창.

interface Props {
  onPron: () => void
  onDict: () => void
  onGoogle: (mode: 'pron' | 'image') => void
  disabled?: boolean
}

function GoogleIcon() {
  return (
    <svg className="google-icon" viewBox="0 0 48 48" width="14" height="14" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.4 0 10.3-2 14-5.4l-6.5-5.5C29.4 34.9 26.8 36 24 36c-5.3 0-9.6-3.3-11.3-8l-6.6 5.1C9.6 39.6 16.3 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.5 5.5C40.9 36.6 44 30.9 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  )
}

export function Toolbar({ onPron, onDict, onGoogle, disabled }: Props) {
  return (
    <div className="toolbar">
      <span className="llm-badge">
        <GoogleIcon />
      </span>
      <button className="tb-btn" title="구글 발음 검색" onClick={() => onGoogle('pron')}>
        발음
      </button>
      <button className="tb-btn" title="구글 이미지 검색" onClick={() => onGoogle('image')}>
        이미지
      </button>

      <span className="tb-spacer" />

      <span className="llm-badge" title="사용 중인 AI 모델은 설정에서 선택합니다">
        AI
      </span>

      <button className="tb-btn" disabled={disabled} onClick={onPron}>
        발음
      </button>

      <button className="tb-btn" disabled={disabled} onClick={onDict}>
        사전
      </button>
    </div>
  )
}
