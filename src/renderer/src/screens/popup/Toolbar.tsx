import type { DictionarySourceId, DictionarySourceOption } from '@shared/types'

// 담당 B — 팝업 툴바 (PLAN.md §3/§4.2)
// [발음]·[사전] 버튼 — 누르면 즉시 채팅에 질문을 넣고 LLM 요청 · 구글 발음/이미지 버튼.
// 통합 질문 입력은 하단 채팅 입력창.
//
// dictSources/selectedSource/onSelectSource: 사전 어댑터 병렬 구현 디버깅용 임시
// 드롭다운(2026-07-28) — "AI" 배지 옆에 그 언어에 실제로 구현된 소스만 보여주고, 사용자가
// 직접 골라 검색해볼 수 있게 한다. 구현된 소스가 없으면(dictSources 비어있음) 드롭다운
// 자체를 숨긴다.

interface Props {
  onPron: () => void
  onDict: () => void
  onGoogle: (mode: 'pron' | 'image') => void
  onNaverDict: () => void
  disabled?: boolean
  dictSources: DictionarySourceOption[]
  selectedSource: DictionarySourceId | undefined
  onSelectSource: (id: DictionarySourceId) => void
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

function NaverIcon() {
  return (
    <svg className="naver-icon" viewBox="0 0 48 48" width="14" height="14" aria-hidden="true">
      <rect width="48" height="48" rx="8" fill="#03C75A" />
      <path fill="#fff" d="M28.5 26.5 19.6 13H13v22h6.9V21.5L28.4 35H35V13h-6.5z" />
    </svg>
  )
}

export function Toolbar({
  onPron,
  onDict,
  onGoogle,
  onNaverDict,
  disabled,
  dictSources,
  selectedSource,
  onSelectSource,
}: Props) {
  return (
    <div className="toolbar">
      <span className="llm-badge">
        <GoogleIcon />
      </span>
      <button className="tb-btn" onClick={() => onGoogle('pron')}>
        발음
      </button>
      <button className="tb-btn" onClick={() => onGoogle('image')}>
        이미지
      </button>

      <span className="llm-badge">
        <NaverIcon />
      </span>
      <button className="tb-btn" onClick={onNaverDict}>
        사전
      </button>

      <span className="tb-spacer" />

      <span className="llm-badge">
        AI
      </span>

      {/* 임시 디버깅 드롭다운(2026-07-28) — 구현된 사전 소스가 없으면 아예 안 보여준다. */}
      {dictSources.length > 0 && (
        <select
          className="dict-source-select"
          title="사전 검색에 쓸 소스(디버깅용 임시)"
          value={selectedSource ?? ''}
          disabled={disabled}
          onChange={(e) => onSelectSource(e.target.value as DictionarySourceId)}
        >
          {dictSources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      )}

      <button className="tb-btn" disabled={disabled} onClick={onPron}>
        발음
      </button>

      <button className="tb-btn" disabled={disabled} onClick={onDict}>
        사전
      </button>
    </div>
  )
}
