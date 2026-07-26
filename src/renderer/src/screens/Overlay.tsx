import { useEffect, useState } from 'react'
import type { AppMode, Word } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'

// 오버레이 (PLAN.md §4.1) — 담당 A
// 선택된 창과 정확히 같은 자리에 정렬되는 투명·클릭스루 창. 테두리 색으로 현재 모드를
// 보여준다(일반=파랑 / 선택=보라). windows.ts: trackSelectionOverlay 가 위치를 잡아준다.
//
// 단어 위치(words)는 선택 모드 진입 시 메인 프로세스가 미리 캡처+추출해 캐시해둔 결과를
// (extractionCache.ts → onExtractionWords) 그대로 받는다 — 클릭 시점에 새로 OCR 을 돌리지
// 않으므로 여기 있는 bbox 는 모드 진입 시점 기준이다.

const WORD_BOX_PADDING = 2 // 박스 테두리가 글자 획과 겹치지 않게 사방으로 두는 여백(px)

export function Overlay() {
  const [mode, setMode] = useState<AppMode>('normal')
  const [words, setWords] = useState<Word[]>([])
  const [hovered, setHovered] = useState<Word | null>(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    window.nuance.getMode().then(setMode)
    return window.nuance.onModeChanged(setMode)
  }, [])

  useEffect(() => window.nuance.onExtractionWords(setWords), [])

  // 모드를 나가면 이전 단어 목록/hover 상태를 비운다 — 다음 선택 모드 진입 시
  // onExtractionWords 로 새 데이터가 올 때까지는 아무 것도 안 보이는 게 맞다.
  useEffect(() => {
    if (mode !== 'select') {
      setWords([])
      setHovered(null)
    }
  }, [mode])

  // 선택 모드일 때만 단어 위치를 추적한다 — 일반 모드는 PLAN.md 상 "클릭에 개입하지
  // 않음"이 원칙이라 hover 감지도 꺼둔다. setIgnoreMouseEvents(true, {forward:true})
  // (windows.ts) 덕분에 클릭스루 상태에서도 mousemove 는 렌더러까지 전달된다.
  useEffect(() => {
    if (mode !== 'select') return
    function onMouseMove(e: MouseEvent) {
      setHovered(findWordAtPoint(words, { x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [mode, words])

  // 실제 단어 bbox 위에 있는 동안만 클릭스루를 꺼서(windows.ts: setOverlayInteractive)
  // 그 자리에서만 클릭이 잡히고 커서 모양도 바뀌게 한다 — 텍스트가 없는 곳은 여전히
  // 클릭스루라 밑 창(대상 앱)이 그대로 조작된다.
  useEffect(() => {
    window.nuance.setOverlayInteractive(hovered !== null)
  }, [hovered])

  async function onOverlayClick(e: React.MouseEvent) {
    if (mode !== 'select' || resolving) return
    setResolving(true)
    try {
      await window.nuance.extractSelection({ x: e.clientX, y: e.clientY })
    } finally {
      setResolving(false)
    }
  }

  return (
    <div
      className={`overlay-root mode-${mode}${hovered ? ' hovering-word' : ''}`}
      onClick={onOverlayClick}
    >
      {hovered?.bbox && (
        <div
          className="word-box"
          style={{
            // hover 판정(findWordAtPoint)은 bbox 원본 그대로 정확하게 쓰고, 화면에
            // 그리는 박스만 왼쪽에 살짝 여백을 둔다 — bbox 왼쪽 경계가 글자 획(특히 L,
            // T, I 처럼 세로획이 왼쪽 끝에 붙은 글자)에 딱 붙어 있어서 그대로 그리면
            // 테두리가 글자와 겹쳐 보인다.
            left: hovered.bbox.x - WORD_BOX_PADDING,
            top: hovered.bbox.y,
            width: hovered.bbox.width + WORD_BOX_PADDING,
            height: hovered.bbox.height,
          }}
        />
      )}
      {resolving && <div className="overlay-resolving">텍스트 인식 중…</div>}
    </div>
  )
}
