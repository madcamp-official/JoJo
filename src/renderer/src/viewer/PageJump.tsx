import { useEffect, useState } from 'react'
import type { PageState } from './pager'

// PDF 전용 — 쪽 번호를 직접 입력해 그 장으로 이동한다. 문서를 아직 다 못 읽어 총 쪽수를
// 모르면(total 0) 아무것도 띄우지 않는다.
export function PageJump({ state, onJump }: { state: PageState; onJump: (page: number) => void }) {
  const [draft, setDraft] = useState('')

  // 스크롤·화살표로 페이지가 바뀌면 입력칸도 따라간다 — 단, 사용자가 입력 중일 때는
  // 건드리지 않는다(타이핑하는 글자가 밀려나면 안 되므로 포커스 여부로 가른다).
  useEffect(() => {
    setDraft(String(state.current))
  }, [state.current])

  if (state.total <= 0) return null

  const commit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n) && n >= 1 && n <= state.total) onJump(n)
    else setDraft(String(state.current)) // 범위 밖 입력은 되돌린다
  }

  return (
    <span className="page-jump">
      <input
        value={draft}
        inputMode="numeric"
        aria-label="쪽 번호"
        // 누르면 기존 번호가 전체 선택돼 바로 새 번호만 치면 된다(지우고 시작할 필요 없음).
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
            commit()
          }
        }}
        onBlur={commit}
      />
      <span className="page-jump-total">/ {state.total}</span>
    </span>
  )
}
