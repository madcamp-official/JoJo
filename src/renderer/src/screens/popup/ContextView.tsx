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
    <div
      className={dragging ? 'ctx-text dragging' : 'ctx-text'}
      onMouseLeave={() => setDragging(false)}
    >
      {segments.map((seg, i) => {
        if (seg.atomIndex === null) {
          // gap: 양옆 atom 이 모두 선택 범위 안이면 연결부(하이픈 등)도 하이라이트
          const prev = segments[i - 1]?.atomIndex
          const next = segments[i + 1]?.atomIndex
          const inside =
            prev != null && next != null && prev >= lo && prev <= hi && next >= lo && next <= hi
          return (
            <span
              key={i}
              className={inside ? 'gap sel' : 'gap'}
              onMouseDown={(e) => {
                // 좌클릭으로 공백/문장부호에서 드래그가 시작되는 것만 막는다(atom 과 동일
                // 이유). CSS user-select: none 은 안 쓴다 — 우클릭 메뉴용 선택 텍스트에서
                // 이 부분이 통째로 빠져 단어들이 붙어버리는 부작용이 있었다.
                if (e.button === 2) return
                e.preventDefault()
                // 단어 사이(공백·문장부호)에서 시작한 드래그도 단어 위 드래그와 동일하게
                // 동작하도록, 이 gap 뒤쪽 단어(없으면 앞쪽 단어)를 기준(anchor)으로 잡는다.
                const idx = next ?? prev
                if (idx == null) return
                anchorRef.current = idx
                setDragging(true)
                onChange(idx, idx)
              }}
              onMouseEnter={() => {
                if (!dragging) return
                // 드래그 도중 이 gap 을 지나갈 때, 방향(anchor 대비 진행 쪽)에 맞는
                // 인접 단어까지 선택을 확장한다.
                const forward = anchorRef.current <= (prev ?? next ?? anchorRef.current)
                const idx = (forward ? next : prev) ?? next ?? prev
                if (idx != null) onChange(anchorRef.current, idx)
              }}
            >
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
              if (e.button === 2) {
                // 우클릭 — 커스텀 드래그 선택(preventDefault)을 시작하지 않는다. preventDefault
                // 를 부르면 Electron 이 contextmenu 를 정상 처리하지 못해 Inspect Element 만
                // 뜨는 문제가 있었다. 지금 범위 밖의 단어를 우클릭했으면 그 단어 하나로 네이티브
                // 선택을 맞춰서(mousedown 은 contextmenu 보다 먼저 발생 — 타이밍 보장) 우클릭
                // 메뉴가 그 단어를 대상으로 복사/찾아보기를 보여주게 한다.
                if (idx < lo || idx > hi) {
                  anchorRef.current = idx
                  onChange(idx, idx)
                  syncNativeSelection(idx, idx)
                }
                return
              }
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
