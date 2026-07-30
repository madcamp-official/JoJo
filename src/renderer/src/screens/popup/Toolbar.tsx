import type { DictionarySourceId, DictionarySourceOption } from '@shared/types'

// 담당 B — 팝업 툴바 (PLAN.md §4/§5.2)
// [발음]·[사전] 버튼 — 누르면 즉시 채팅에 질문을 넣고 LLM 요청 · 구글 발음/이미지 버튼.
// 통합 질문 입력은 하단 채팅 입력창.
//
// dictSources/selectedSource/onSelectSource: 사전 소스 직접 선택 드롭다운(정식 기능,
// 2026-07-30 격상) — "AI" 배지 옆에 그 언어에 실제로 구현된 소스만 보여주고, 사용자가
// 직접 골라 검색해볼 수 있게 한다. 구현된 소스가 없으면(dictSources 비어있음) 드롭다운
// 자체를 숨긴다.
//
// forceSource/onToggleForceSource: "직접 선택" 토글 — 기본값은 꺼짐(정식 폴백 체인,
// dictionary.ts FALLBACK_CHAINS), 켜면 아래 드롭다운에서 고른 소스를 강제 호출한다.
// 드롭다운 자체는 항상 보여주되(토글과 무관하게 다음 소스 목록 확인용), 토글이 꺼져
// 있을 땐 disabled 로 "지금은 이 선택이 반영 안 됨"을 시각적으로 알린다.
//
// "문자 단위" 선택 토글은 여기 없다 — PopupScreen.tsx의 "범위 지정" 헤더(.ctx-head)로
// 이동함(2026-07-30, 사용자 요청) — 그 범위 지정 영역에 적용되는 옵션이라 툴바보다
// 거기 붙어있는 게 더 자연스럽다는 판단.
//
// showNaverDict/showAiDictionary: 언어 tier(2026-07-30 도입)별 기능 게이팅 — 계산은
// PopupScreen.tsx가 하고(shared/languages.ts hasNaverDict/isFullLanguage) 여기는 그
// 결과만 받아 렌더링만 결정한다.
//   tier1(완전지원): 전부 true.
//   tier2-A(구글+네이버): showNaverDict=true, showAiDictionary=false — "AI 사전"은
//     언어별 사전 API 소스(FALLBACK_CHAINS)가 있어야 하는데 tier2는 없음. "AI 발음"은
//     LLM 프롬프트만으로 되는 기능이라(IPA로 통일) tier1/tier2 구분 없이 항상 보여준다.
//   tier2-B(구글만): showNaverDict=false, showAiDictionary=false.

interface Props {
  onPron: () => void
  onDict: () => void
  onGoogle: (mode: 'pron' | 'image') => void
  onNaverDict: () => void
  disabled?: boolean
  /** 지금 실제로 호출되는 모델명 — provider 를 아직 안 골랐으면(설정 미완료) null,
   *  이때는 배지에 "AI"만 보여주고 괄호를 생략한다. */
  currentModel: string | null
  showNaverDict: boolean
  showAiDictionary: boolean
  dictSources: DictionarySourceOption[]
  selectedSource: DictionarySourceId | undefined
  onSelectSource: (id: DictionarySourceId) => void
  forceSource: boolean
  onToggleForceSource: (value: boolean) => void
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
  currentModel,
  showNaverDict,
  showAiDictionary,
  dictSources,
  selectedSource,
  onSelectSource,
  forceSource,
  onToggleForceSource,
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

      {showNaverDict && (
        <>
          <span className="llm-badge">
            <NaverIcon />
          </span>
          <button className="tb-btn" onClick={onNaverDict}>
            사전
          </button>
        </>
      )}

      <span className="tb-spacer" />

      <span className="llm-badge">
        AI{currentModel ? `(${currentModel})` : ''}
      </span>

      <button className="tb-btn" disabled={disabled} onClick={onPron}>
        발음
      </button>

      {showAiDictionary && (
        <>
          <button className="tb-btn" disabled={disabled} onClick={onDict}>
            사전
          </button>

          {/* 사전 소스 직접 선택(정식 기능) — 구현된 사전 소스가 없으면 아예 안 보여준다.
              토글이 꺼져 있으면(기본값) 정식 폴백 체인을 쓰고, 켜면 드롭다운에서 고른 소스를
              강제 호출한다. */}
          {dictSources.length > 0 && (
            <>
              <select
                className="dict-source-select"
                title="직접 조회할 소스(오른쪽 토글이 켜져 있을 때만 적용)"
                value={selectedSource ?? ''}
                disabled={disabled || !forceSource}
                onChange={(e) => onSelectSource(e.target.value as DictionarySourceId)}
              >
                {dictSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <label className="dict-force-toggle" title="켜면 정식 폴백 체인 대신 왼쪽 드롭다운에서 고른 소스만 조회">
                <input
                  type="checkbox"
                  checked={forceSource}
                  disabled={disabled}
                  onChange={(e) => onToggleForceSource(e.target.checked)}
                />
                직접 선택
              </label>
            </>
          )}
        </>
      )}
    </div>
  )
}
