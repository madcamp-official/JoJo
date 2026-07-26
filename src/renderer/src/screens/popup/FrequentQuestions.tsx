import { useState } from 'react'

// 담당 B — 자주 쓰는 질문 목록 (등록·수정·삭제 + 클릭 시 질문 실행) — PLAN.md §3/§4.2-3

interface Props {
  items: string[]
  onAsk: (text: string) => void
  onChange: (items: string[]) => void
  disabled?: boolean
}

export function FrequentQuestions({ items, onAsk, onChange, disabled }: Props) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  function commitEdit(i: number) {
    const v = draft.trim()
    if (v) {
      const next = items.slice()
      next[i] = v
      onChange(next)
    }
    setEditing(null)
    setDraft('')
  }

  function commitAdd() {
    const v = draft.trim()
    if (v) onChange([...items, v])
    setAdding(false)
    setDraft('')
  }

  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i))
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="frequent">
      <div className="frequent-head">
        <span>자주 쓰는 질문</span>
        <button
          className="link-btn"
          onClick={() => {
            setAdding(true)
            setEditing(null)
            setDraft('')
          }}
        >
          + 추가
        </button>
      </div>

      <ul className="freq-list">
        {items.map((q, i) =>
          editing === i ? (
            <li key={i} className="freq-item editing">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit(i)
                  if (e.key === 'Escape') {
                    setEditing(null)
                    setDraft('')
                  }
                }}
              />
              <button className="link-btn" onClick={() => commitEdit(i)}>
                저장
              </button>
            </li>
          ) : (
            <li key={i} className="freq-item">
              <button
                className="icon-mini"
                title="위로 이동"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ▲
              </button>
              <button
                className="icon-mini"
                title="아래로 이동"
                disabled={i === items.length - 1}
                onClick={() => move(i, 1)}
              >
                ▼
              </button>
              <button className="freq-ask" disabled={disabled} onClick={() => onAsk(q)} title={q}>
                {q}
              </button>
              <button
                className="icon-mini"
                title="수정"
                onClick={() => {
                  setEditing(i)
                  setAdding(false)
                  setDraft(q)
                }}
              >
                ✎
              </button>
              <button className="icon-mini" title="삭제" onClick={() => remove(i)}>
                🗑
              </button>
            </li>
          ),
        )}

        {adding && (
          <li className="freq-item editing">
            <input
              autoFocus
              placeholder="새 질문 입력"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitAdd()
                if (e.key === 'Escape') {
                  setAdding(false)
                  setDraft('')
                }
              }}
            />
            <button className="link-btn" onClick={commitAdd}>
              저장
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
