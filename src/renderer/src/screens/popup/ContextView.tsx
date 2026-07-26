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
  const atomElsRef = useRef(new Map<number, HTMLSpanElement>())

  // 드래그 중 창 어디서 손을 떼도 종료되도록 전역 mouseup 구독
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging])

  // 클릭/드래그로 고른 범위(atom 단위, AI 문맥용 커스텀 선택)를 실제 브라우저 텍스트
  // 선택(Selection/Range)에도 반영한다. 이걸 해줘야 그 범위 위에서 우클릭했을 때
  // Electron 의 기본 우클릭 메뉴(복사·찾아보기 등)가 "선택된 텍스트"를 인식해 동작한다
  // (그냥 커서로 클릭만 해서는 브라우저 선택이 안 생겨서 우클릭 메뉴에 아무것도 안 뜬다).
  function syncNativeSelection(loIdx: number, hiIdx: number) {
    const startEl = atomElsRef.current.get(loIdx)
    const endEl = atomElsRef.current.get(hiIdx)
    const sel = window.getSelection()
    if (!startEl || !endEl || !sel) return
    const range = document.createRange()
    range.setStartBefore(startEl)
    range.setEndAfter(endEl)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  useEffect(() => {
    syncNativeSelection(lo, hi)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi, model])

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
            ref={(el) => {
              if (el) atomElsRef.current.set(idx, el)
              else atomElsRef.current.delete(idx)
            }}
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
            onContextMenu={() => {
              // 지금 선택 범위 밖의 단어를 우클릭하면, 그 단어 하나만 먼저 선택해서
              // (커밋 후 useEffect 를 기다리면 한 프레임 늦어 메뉴가 이전 선택을 보고 뜨므로)
              // 네이티브 선택도 여기서 바로 맞춰야 우클릭 메뉴가 그 단어를 대상으로 뜬다.
              if (idx < lo || idx > hi) {
                anchorRef.current = idx
                onChange(idx, idx)
                syncNativeSelection(idx, idx)
              }
            }}
          >
            {seg.text}
          </span>
        )
      })}
    </div>
  )
}
