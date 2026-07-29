import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { PopupSelectionModel } from './selection'

// 담당 B — 원문 문맥 표시 + 드래그 범위 재지정 (PLAN.md §4.1)
// atom(단어 조각) 위에서 클릭=단어 하나, 드래그=범위. 하이픈 단어도 조각별 선택 가능.

interface Props {
  model: PopupSelectionModel
  from: number
  to: number
  onChange: (from: number, to: number) => void
  /** ja/zh "글자 단위" 토글이 켜졌을 때(2026-07-28) — 글자 하나하나가 다 atom 이 되면서
   *  .atom 의 좌우 padding(1px)이 매 글자마다 누적돼 자간이 늘어난 것처럼 보이는 문제가
   *  있어, 이 모드에선 CSS 로 그 padding 을 없앤다(styles.css `.ctx-text.char-level .atom`). */
  charLevel?: boolean
  /** 언어별 전용 스타일(예: 일본어 전용 폰트, styles.css: .ctx-text.lang-ja) 훅. */
  className?: string
  /** 아랍어/페르시아어/히브리어/우르두어(RTL) 팝업일 때 'rtl' — 기본 텍스트 방향만
   *  바꾼다(2026-07-30). 드래그 선택 자체는 이 값과 무관하게 이미 정확하다(위 atomIndexAtPoint
   *  주석 참고 — document.caretRangeFromPoint가 bidi를 이미 인식하고, atom index/lo/hi
   *  비교가 전부 논리 순서 기준이라 시각적 방향이 뒤집혀도 실제 선택 범위는 안 흔들림). */
  dir?: 'ltr' | 'rtl'
  /** PopupScreen 이 실제 렌더링 너비/폰트로 "화면상 줄" 경계를 측정할 때 씀
   *  (popup/measureLines.ts) — 이 루트 엘리먼트의 className/clientWidth를 그대로
   *  복제해 오프스크린에서 측정한다. */
  rootRef?: Ref<HTMLDivElement>
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

// 점(x, y)에서 가장 가까운 atom 을 찾는다 — "박스 안 텍스트 옆 여백에서 드래그 시작"·
// "드래그 중 커서가 박스 밖으로 나가도 계속 이어짐"을 모두 이 하나의 함수로 처리한다.
// 각 atom 의 bounding rect 까지의 최단 거리(rect 안이면 0)를 계산해 가장 가까운 것을
// 고른다 — 커서가 박스 밖 어디에 있든(위/아래/옆) 항상 정의되는 값이라 별도의 예외
// 처리(위로 나가면 첫 atom, 등) 없이 자연스럽게 동작한다.
//
// 다만 이 거리 기반 방식은 "글의 흐름(읽는 순서)"을 전혀 모른다 — 마지막 줄 아래(더 이상
// 글자가 없는 빈 공간)로 드래그하면, 다음 문장이 없으니 "가장 가까운" atom이 오히려 같은
// 줄의 앞쪽(이미 지나온) 단어로 잡히는 경우가 실측으로 확인됐다(예: 마지막 줄 오른쪽 끝
// 단어에서 시작해 곧장 아래로 드래그하면 그 자리에서 못 벗어나거나 뒤로 튐). atomIndexAtPoint
// 가 이 함수보다 항상 먼저 시도되고, 이 함수는 그게 실패했을 때만 쓰는 fallback 이다.
function nearestAtomIndex(atomEls: Map<number, HTMLSpanElement>, x: number, y: number): number | null {
  let best: number | null = null
  let bestDist = Infinity
  for (const [idx, el] of atomEls) {
    const r = el.getBoundingClientRect()
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = idx
    }
  }
  return best
}

/** gapEl(공백·문장부호 span) 기준으로 가장 가까운 atom(다음 우선, 없으면 이전)을 찾는다. */
function adjacentAtomIndex(gapEl: Element): number | null {
  for (let sib = gapEl.nextElementSibling; sib; sib = sib.nextElementSibling) {
    const attr = sib.getAttribute('data-atom-index')
    if (attr != null) return Number(attr)
  }
  for (let sib = gapEl.previousElementSibling; sib; sib = sib.previousElementSibling) {
    const attr = sib.getAttribute('data-atom-index')
    if (attr != null) return Number(attr)
  }
  return null
}

/**
 * 점(x, y)에 해당하는 atom 을 "글의 흐름" 기준으로 찾는다 — Chromium 의
 * document.caretRangeFromPoint 는 화면 좌표를 실제 텍스트 상의 가장 가까운 문자 위치로
 * 변환해준다(줄바꿈·문단 끝을 이미 인지함: 마지막 줄 아래를 가리키면 그 줄의 끝으로,
 * 줄 사이 여백을 가리키면 그 줄의 알맞은 위치로 자연스럽게 clamp됨) — 그래서 nearestAtomIndex
 * 의 "거리만 보고 뒤로 튀는" 문제가 없다. 이 API 가 없거나 실패하면(이론상 대비) 기존
 * 거리 기반 로직으로 폴백한다.
 */
function atomIndexAtPoint(atomEls: Map<number, HTMLSpanElement>, x: number, y: number): number | null {
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y)
    let el: Element | null =
      range?.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : (range?.startContainer as Element | null)
    while (el) {
      if (el.classList?.contains('gap')) return adjacentAtomIndex(el)
      const attr = el.getAttribute?.('data-atom-index')
      if (attr != null) return Number(attr)
      el = el.parentElement
    }
  }
  return nearestAtomIndex(atomEls, x, y)
}

export function ContextView({ model, from, to, onChange, charLevel, className, rootRef, dir }: Props) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const [dragging, setDragging] = useState(false)
  const anchorRef = useRef(from)
  const atomElsRef = useRef(new Map<number, HTMLSpanElement>())
  // onChange 는 매 렌더마다 새로 만들어질 수 있어 ref 로 최신 값만 참조 —
  // 아래 mousemove 구독 effect 를 dragging 변화에만 반응하도록 유지하기 위함.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 드래그 중 창 어디서 손을 떼도 종료되도록 전역 mouseup 구독
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging])

  // 드래그 중엔 커서 위치를 전역으로 추적해 가장 가까운 atom 까지 선택을 확장한다.
  // 개별 세그먼트의 onMouseEnter 대신 이 방식을 쓰는 이유: 커서가 박스 경계를 벗어나도
  // (위/아래/옆 어디든) window 기준 mousemove 는 계속 들어오고, nearestAtomIndex 가
  // 항상 "가장 가까운 atom"을 돌려주므로 드래그가 끊기지 않고 자연스럽게 이어진다.
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => {
      const idx = atomIndexAtPoint(atomElsRef.current, e.clientX, e.clientY)
      if (idx != null) onChangeRef.current(anchorRef.current, idx)
    }
    window.addEventListener('mousemove', move)
    return () => window.removeEventListener('mousemove', move)
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

  // 선택된 세그먼트(atom.sel/gap.sel)들이 각자 따로 테두리 박스로 보이지 않고 한 덩어리
  // (통짜)로 이어져 보이게 하려고, 맨 앞·맨 뒤 세그먼트만 구분해 둥근 모서리+양끝 마감을
  // 준다(styles.css `.sel-start`/`.sel-end`) — 중간 세그먼트들은 위아래 선만 그어 같은
  // 줄에서는 이어진 하나의 띠처럼, 줄이 바뀌면 자연스럽게 다음 줄로 이어지게 한다
  // (사용자 피드백, 2026-07-29 — 여러 단어를 선택하면 단어마다 따로 박스로 분절돼 보임).
  function isSegSelected(i: number): boolean {
    const seg = segments[i]!
    if (seg.atomIndex === null) {
      const prev = segments[i - 1]?.atomIndex
      const next = segments[i + 1]?.atomIndex
      return prev != null && next != null && prev >= lo && prev <= hi && next >= lo && next <= hi
    }
    return seg.atomIndex >= lo && seg.atomIndex <= hi
  }
  const selStartIdx = segments.findIndex((_, i) => isSegSelected(i))
  let selEndIdx = -1
  for (let i = segments.length - 1; i >= 0; i--) {
    if (isSegSelected(i)) {
      selEndIdx = i
      break
    }
  }

  return (
    <div
      ref={rootRef}
      dir={dir}
      className={['ctx-text', dragging && 'dragging', charLevel && 'char-level', className]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={(e) => {
        // 세그먼트(atom/gap) 바깥, 박스 자체의 여백(padding)을 직접 눌렀을 때만 처리 —
        // 세그먼트 위에서 눌렀으면 그쪽 onMouseDown 이 이미 처리했고(버블링으로 여기까지
        // 올라옴), e.target !== e.currentTarget 로 걸러 중복 처리를 막는다.
        if (e.button === 2 || e.target !== e.currentTarget) return
        e.preventDefault()
        const idx = atomIndexAtPoint(atomElsRef.current, e.clientX, e.clientY)
        if (idx == null) return
        anchorRef.current = idx
        setDragging(true)
        onChange(idx, idx)
      }}
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
              className={[
                'gap',
                inside && 'sel',
                inside && i === selStartIdx && 'sel-start',
                inside && i === selEndIdx && 'sel-end',
              ]
                .filter(Boolean)
                .join(' ')}
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
            data-atom-index={idx}
            className={[
              'atom',
              selected && 'sel',
              selected && i === selStartIdx && 'sel-start',
              selected && i === selEndIdx && 'sel-end',
            ]
              .filter(Boolean)
              .join(' ')}
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
          >
            {seg.text}
          </span>
        )
      })}
    </div>
  )
}
