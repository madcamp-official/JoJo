import { useState } from 'react'
import { EditDeleteGroup } from '../EditDeleteGroup'

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
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

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

  function reorder(from: number, to: number) {
    if (from === to) return
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
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
            <li
              key={i}
              className={`freq-item ${dragIndex === i ? 'dragging' : ''} ${overIndex === i ? 'drag-over' : ''}`}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragIndex !== null && dragIndex !== i) setOverIndex(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex !== null) reorder(dragIndex, i)
                setDragIndex(null)
                setOverIndex(null)
              }}
              onDragEnd={() => {
                setDragIndex(null)
                setOverIndex(null)
              }}
            >
              <span className="drag-handle" title="드래그해서 순서 변경">
                ⠿
              </span>
              <button className="freq-ask" disabled={disabled} onClick={() => onAsk(q)} title={q}>
                {q}
              </button>
              <EditDeleteGroup
                onEdit={() => {
                  setEditing(i)
                  setAdding(false)
                  setDraft(q)
                }}
                onDelete={() => remove(i)}
                disabled={disabled}
              />
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
