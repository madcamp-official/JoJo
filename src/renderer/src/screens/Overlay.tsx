import { useEffect, useRef, useState } from 'react'
import type { AppMode, Rect, Word } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'

// 오버레이 (PLAN.md §4.1) — 담당 A
// 선택된 창과 정확히 같은 자리에 정렬되는 투명·클릭스루 창. 테두리 색으로 현재 모드를
// 보여준다(일반=파랑 / 선택=보라). windows.ts: trackSelectionOverlay 가 위치를 잡아준다.
//
// 단어 위치(words)는 선택 모드 진입 시 메인 프로세스가 미리 캡처+추출해 캐시해둔 결과를
// (extractionCache.ts → onExtractionWords) 그대로 받는다 — 클릭 시점에 새로 OCR 을 돌리지
// 않으므로 여기 있는 bbox 는 모드 진입 시점 기준이다.
//
// OCR 은 창 전체가 아니라 사용자가 지정한 영역(regionSelection.ts)에만 적용된다 — 영역이
// 없으면(처음 선택한 창, 또는 리사이즈로 무효화된 뒤) 메인이 REGION_SELECTION_NEEDED 를
// 보내고, 여기서 드래그로 사각형을 그려 SUBMIT_REGION 으로 돌려준다.

const WORD_BOX_PADDING = 2 // 박스 테두리가 글자 획과 겹치지 않게 사방으로 두는 여백(px)
const NOTICE_DURATION_MS = 4000
const MIN_REGION_SIZE = 8 // 이보다 작은 드래그는 실수 클릭으로 보고 무시

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

export function Overlay() {
  const [mode, setMode] = useState<AppMode>('normal')
  const [words, setWords] = useState<Word[]>([])
  const [hovered, setHovered] = useState<Word | null>(null)
  const [resolving, setResolving] = useState(false)
  // 선택 모드 진입 시 메인이 백그라운드로 캡처+OCR 을 시작한다(extractionCache.ts:
  // refreshExtractionCache, shortcut.ts 가 모드 전환 즉시 호출) — 그 사이(1~3초) 동안
  // 아무 표시도 없으면 멈춘 것처럼 보여서, 모드 진입 즉시 켜고 onExtractionWords 로
  // 결과(성공/실패 모두 빈 배열이라도)가 오면 끈다.
  const [extracting, setExtracting] = useState(false)
  const [needsRegion, setNeedsRegion] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null)
  // 드래그로 영역을 막 확정한 직후, 같은 mouseup 뒤에 브라우저가 자동으로 발생시키는
  // click 이벤트를 "단어 클릭"으로 오인해 팝업이 뜨는 걸 막는다(state 는 비동기라 타이밍이
  // 애매해서 ref 로 동기적으로 체크). onOverlayClick 맨 앞에서 한 번만 소비한다.
  const justSubmittedRegionRef = useRef(false)

  useEffect(() => {
    window.nuance.getMode().then(setMode)
    return window.nuance.onModeChanged(setMode)
  }, [])

  useEffect(
    () =>
      window.nuance.onExtractionWords((w) => {
        setWords(w)
        setExtracting(false)
      }),
    [],
  )

  useEffect(
    () =>
      window.nuance.onRegionSelectionNeeded(() => {
        // 모드 진입과 동시에(캐시된 영역이 없어서) 오거나, 리사이즈 감지로 모드 중간에
        // 올 수도 있다 — 두 경우 다 이전 단어/hover 를 비우고 드래그 대기 상태로 전환한다.
        setNeedsRegion(true)
        setExtracting(false)
        setWords([])
        setHovered(null)
        setDragStart(null)
        setDragCurrent(null)
      }),
    [],
  )

  useEffect(() => window.nuance.onOverlayNotice(setNotice), [])

  // 안내 배너는 잠깐 떴다가 자동으로 사라진다.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // 모드를 나가면 이전 단어 목록/hover/영역 선택 상태를 비운다.
  useEffect(() => {
    if (mode === 'select') {
      setExtracting(true) // onRegionSelectionNeeded 가 뒤이어 오면 바로 false 로 정정됨
    } else {
      setWords([])
      setHovered(null)
      setExtracting(false)
      setNeedsRegion(false)
      setDragStart(null)
      setDragCurrent(null)
    }
  }, [mode])

  // 선택 모드일 때만 단어 위치를 추적한다 — 일반 모드는 PLAN.md 상 "클릭에 개입하지
  // 않음"이 원칙이라 hover 감지도 꺼둔다. setIgnoreMouseEvents(true, {forward:true})
  // (windows.ts) 덕분에 클릭스루 상태에서도 mousemove 는 렌더러까지 전달된다.
  useEffect(() => {
    if (mode !== 'select' || needsRegion) return
    function onMouseMove(e: MouseEvent) {
      setHovered(findWordAtPoint(words, { x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [mode, words, needsRegion])

  // 실제 단어 bbox 위에 있는 동안만, 또는 영역을 드래그로 그리는 동안은 통째로
  // 클릭스루를 꺼서(windows.ts: setOverlayInteractive) 오버레이가 입력을 받게 한다.
  useEffect(() => {
    window.nuance.setOverlayInteractive(needsRegion || hovered !== null)
  }, [needsRegion, hovered])

  async function onOverlayClick(e: React.MouseEvent) {
    if (justSubmittedRegionRef.current) {
      justSubmittedRegionRef.current = false
      return
    }
    if (mode !== 'select' || needsRegion || resolving) return
    setResolving(true)
    try {
      await window.nuance.extractSelection({ x: e.clientX, y: e.clientY })
    } finally {
      setResolving(false)
    }
  }

  function onRootMouseDown(e: React.MouseEvent) {
    if (!needsRegion) return
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragCurrent({ x: e.clientX, y: e.clientY })
  }

  function onRootMouseMove(e: React.MouseEvent) {
    if (!needsRegion || !dragStart) return
    setDragCurrent({ x: e.clientX, y: e.clientY })
  }

  async function onRootMouseUp(e: React.MouseEvent) {
    if (!needsRegion || !dragStart) return
    const rect = normalizeRect(dragStart, { x: e.clientX, y: e.clientY })
    setDragStart(null)
    setDragCurrent(null)
    if (rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) return // 실수 클릭 무시

    justSubmittedRegionRef.current = true
    setNeedsRegion(false)
    setExtracting(true)
    await window.nuance.submitRegion(rect)
  }

  const dragRect = dragStart && dragCurrent ? normalizeRect(dragStart, dragCurrent) : null

  return (
    <div
      className={`overlay-root mode-${mode}${hovered ? ' hovering-word' : ''}`}
      onClick={onOverlayClick}
      onMouseDown={onRootMouseDown}
      onMouseMove={onRootMouseMove}
      onMouseUp={onRootMouseUp}
    >
      {hovered?.bbox && (
        <div
          className="word-box"
          style={{
            // hover 판정(findWordAtPoint)은 bbox 원본 그대로 정확하게 쓰고, 화면에
            // 그리는 박스만 좌우에 살짝 여백을 둔다 — bbox 좌우 경계가 글자 획(왼쪽:
            // L/T/I 처럼 세로획이 끝에 붙은 글자, 오른쪽: 문장부호를 제외하고 나면
            // 마지막 글자의 잉크 픽셀 끝에 딱 붙음, ocr.ts: splitWordBySymbols)에
            // 딱 붙어 있어서 그대로 그리면 테두리가 글자와 겹쳐 보인다.
            left: hovered.bbox.x - WORD_BOX_PADDING,
            top: hovered.bbox.y,
            width: hovered.bbox.width + WORD_BOX_PADDING * 2,
            height: hovered.bbox.height,
          }}
        />
      )}
      {needsRegion && (
        <>
          {/* 캡처 도구처럼 전체를 어둡게 하고, 드래그 중인 사각형만 원래 밝기로 "구멍"을
              낸다(사각형 자신에 거대한 box-shadow 를 씌우는 트릭 — 사각형이 없으면 0
              크기라 화면 전체가 균일하게 어두워짐). */}
          <div className="region-dim-clip">
            <div
              className="region-dim"
              style={{
                left: dragRect?.x ?? 0,
                top: dragRect?.y ?? 0,
                width: dragRect?.width ?? 0,
                height: dragRect?.height ?? 0,
              }}
            />
          </div>
          {/* 어두운 레이어가 부모(overlay-root)의 outline 테두리 위를 덮어버려서, 같은
              색으로 한 번 더 그린 테두리를 DOM 순서상 맨 뒤(= 항상 맨 위에 그려짐)에
              둔다 — 여기선 정확한 위치를 맞출 필요 없이 그냥 항상 위에 덮어씌운다. */}
          <div className="region-border-topcoat" />
        </>
      )}
      {notice ? (
        <div className="overlay-resolving">{notice}</div>
      ) : needsRegion ? (
        <div className="overlay-resolving">텍스트를 추출할 영역을 드래그해서 선택하세요</div>
      ) : (
        (extracting || resolving) && (
          <div className="overlay-resolving">
            <span className="overlay-spinner" />
            텍스트 추출 중…
          </div>
        )
      )}
    </div>
  )
}
