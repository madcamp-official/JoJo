import { useEffect, useRef, useState } from 'react'
import type { PopupSelectionModel } from './selection'

// 담당 B — 원문 문맥 표시 + 드래그 범위 재지정 (PLAN.md §4.1)
// atom(단어 조각) 위에서 클릭=단어 하나, 드래그=범위. 하이픈 단어도 조각별 선택 가능.

interface Props {
  model: PopupSelectionModel
  from: number
  to: number
  onChange: (from: number, to: number) => void
}

interface Segment {
  text: string
  atomIndex: number | null // atom 이면 인덱스, 아니면 gap(공백·문장부호·하이픈)
}

// displayText 를 atom / gap 세그먼트 순서대로 분해
function toSegments(model: PopupSelectionModel): Segment[] {
  const segs: Segment[] = []
  let cursor = 0
  model.atoms.forEach((a, i) => {
    if (a.start > cursor) segs.push({ text: model.displayText.slice(cursor, a.start), atomIndex: null })
    segs.push({ text: model.displayText.slice(a.start, a.end), atomIndex: i })
    cursor = a.end
  })
  if (cursor < model.displayText.length) {
    segs.push({ text: model.displayText.slice(cursor), atomIndex: null })
  }
  return segs
}

export function ContextView({ model, from, to, onChange }: Props) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const [dragging, setDragging] = useState(false)
  const anchorRef = useRef(from)

  // 드래그 중 창 어디서 손을 떼도 종료되도록 전역 mouseup 구독
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging])

  const segments = toSegments(model)

  return (
    <div className="ctx-text" onMouseLeave={() => setDragging(false)}>
      {segments.map((seg, i) => {
        if (seg.atomIndex === null) {
          // gap: 양옆 atom 이 모두 선택 범위 안이면 연결부(하이픈 등)도 하이라이트
          const prev = segments[i - 1]?.atomIndex
          const next = segments[i + 1]?.atomIndex
          const inside =
            prev != null && next != null && prev >= lo && prev <= hi && next >= lo && next <= hi
          return (
            <span key={i} className={inside ? 'gap sel' : 'gap'}>
              {seg.text}
            </span>
          )
        }
        const idx = seg.atomIndex
        const selected = idx >= lo && idx <= hi
        return (
          <span
            key={i}
            className={selected ? 'atom sel' : 'atom'}
            onMouseDown={(e) => {
              e.preventDefault()
              anchorRef.current = idx
              setDragging(true)
              onChange(idx, idx)
            }}
            onMouseEnter={() => {
              if (dragging) onChange(anchorRef.current, idx)
            }}
          >
            {seg.text}
          </span>
        )
      })}
    </div>
  )
}
