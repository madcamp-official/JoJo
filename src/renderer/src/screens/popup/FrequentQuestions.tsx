import { useEffect, useRef, useState } from 'react'
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
  // "원본 배열(items) 기준으로 이 인덱스의 항목 앞에 꽂힌다"를 뜻한다. items.length 면 맨 뒤
  // (모든 항목 뒤)를 뜻하며, 이 경우 특정 li 가 아니라 마지막 항목의 아래쪽 테두리로 표시한다.
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

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

  /**
   * from(드래그한 항목의 원래 인덱스) 항목을, beforeOriginalIndex 였던 항목의 새 앞자리로
   * 옮긴다(null 이면 맨 뒤). from 을 먼저 제거한 뒤 삽입 위치를 계산해야 한다 — 제거로
   * from 뒤쪽 항목들은 인덱스가 한 칸씩 당겨지므로, beforeOriginalIndex 가 from 보다 크면
   * 실제 삽입 위치는 beforeOriginalIndex - 1 이다(그대로 쓰면 항상 목표보다 한 칸 뒤에
   * 꽂히는 오프바이원 버그가 생긴다 — 특히 아래로 드래그할 때 두드러졌다).
   */
  function reorder(from: number, beforeOriginalIndex: number | null) {
    const moved = items[from]!
    const rest = items.filter((_, idx) => idx !== from)
    const to =
      beforeOriginalIndex === null
        ? rest.length
        : beforeOriginalIndex < from
          ? beforeOriginalIndex
          : beforeOriginalIndex - 1
    if (to === from) return // 원래 자리와 같으면 변경 없음
    const next = rest.slice()
    next.splice(to, 0, moved)
    onChange(next)
  }

  /**
   * 커서 Y좌표를 목록 항목 중앙점들과 비교해 "이 항목(원본 인덱스) 앞에 꽂힌다"를 계산한다.
   * 커서가 마지막 항목의 중앙보다 아래(리스트 바깥으로 한참 벗어나도 포함)면 null(맨 뒤)을
   * 반환한다 — 아래 window dragover/drop 리스너와 함께 써서 li 영역 밖으로 드래그해도 순서
   * 변경이 되게 한다. 드래그 중인 항목 자신은 계산에서 제외한다(자기 앞/뒤는 의미 없는 목표).
   */
  function calcDropBeforeIndex(clientY: number): number | null {
    const els = listRef.current?.querySelectorAll<HTMLLIElement>('li[data-index]')
    if (!els) return null
    for (const el of els) {
      const idx = Number(el.dataset.index)
      if (idx === dragIndex) continue
      const rect = el.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return idx
    }
    return null
  }

  // 드래그 중엔 window 전체에서 dragover/drop 을 받는다 — li 하나하나에만 걸어두면
  // 목록 영역 위/아래로 한참 벗어났을 때 어떤 li 도 이벤트를 못 받아 순서 변경이 안 됐다.
  useEffect(() => {
    if (dragIndex === null) return
    function onDragOver(e: DragEvent) {
      e.preventDefault()
      setOverIndex(calcDropBeforeIndex(e.clientY) ?? items.length)
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      const before = calcDropBeforeIndex(e.clientY)
      reorder(dragIndex!, before)
      setDragIndex(null)
      setOverIndex(null)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIndex, items])

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

      <ul className="freq-list" ref={listRef}>
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
              data-index={i}
              className={[
                'freq-item',
                dragIndex === i ? 'dragging' : '',
                overIndex === i ? 'drag-over' : '',
                // 맨 뒤로 보내려는 중이면(overIndex === items.length) 마지막 항목의 아래쪽에
                // 표시한다 — 그 뒤에 별도로 표시할 li 가 없기 때문.
                overIndex === items.length && i === items.length - 1 ? 'drag-over-end' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              draggable
              onDragStart={() => setDragIndex(i)}
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
