import { useEffect, useState } from 'react'
import type { AppMode, Word } from '@shared/types'
import { findWordAtPoint } from '@shared/wordMapping'

// 오버레이 (PLAN.md §4.1) — 담당 A
// 선택된 창과 정확히 같은 자리에 정렬되는 투명·클릭스루 창. 테두리 색으로 현재 모드를
// 보여준다(일반=파랑 / 선택=보라). windows.ts: trackSelectionOverlay 가 위치를 잡아준다.
//
// TODO(담당 A): 아래 MOCK_WORDS 는 자리표시자다 — 실제 텍스트 추출(직접 추출/OCR)이
// 붙기 전까지, "화면 좌표 ↔ 단어 매핑"이 실제 선택된 창 위에서 동작하는 것을 눈으로
// 확인하기 위한 임시 데이터. 추출 파이프라인이 준비되면 IPC 로 실제 Word[] 를 받아
// 이 상수를 대체한다. 좌표는 오버레이 창 자신의 로컬 좌표계(0,0 = 오버레이 좌상단)이고,
// 오버레이는 선택된 창과 bounds 가 정확히 같으므로 곧 대상 창 위의 좌표와 같다.
const MOCK_WORDS: Word[] = [
  { text: 'Hello', bbox: { x: 40, y: 40, width: 70, height: 28 } },
  { text: 'this', bbox: { x: 118, y: 40, width: 50, height: 28 } },
  { text: 'is', bbox: { x: 176, y: 40, width: 36, height: 28 } },
  { text: 'a', bbox: { x: 220, y: 40, width: 26, height: 28 } },
  { text: 'mock', bbox: { x: 40, y: 76, width: 70, height: 28 } },
  { text: 'word', bbox: { x: 118, y: 76, width: 60, height: 28 } },
]

export function Overlay() {
  const [mode, setMode] = useState<AppMode>('normal')
  const [hovered, setHovered] = useState<Word | null>(null)

  useEffect(() => {
    window.nuance.getMode().then(setMode)
    return window.nuance.onModeChanged(setMode)
  }, [])

  // 선택 모드일 때만 단어 위치를 추적한다 — 일반 모드는 PLAN.md 상 "클릭에 개입하지
  // 않음"이 원칙이라 hover 감지도 꺼둔다. setIgnoreMouseEvents(true, {forward:true})
  // (windows.ts) 덕분에 클릭스루 상태에서도 mousemove 는 렌더러까지 전달된다.
  useEffect(() => {
    if (mode !== 'select') {
      setHovered(null)
      return
    }
    function onMouseMove(e: MouseEvent) {
      setHovered(findWordAtPoint(MOCK_WORDS, { x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [mode])

  // 단어 위에 있는 동안만 클릭스루를 잠깐 꺼서(windows.ts: setOverlayInteractive) 실제
  // 시스템 커서가 바뀌게 한다 — 클릭스루 상태에선 CSS cursor 를 바꿔도 OS 가 이 창을
  // 입력 대상에서 제외하고 있어서 반영되지 않는다.
  useEffect(() => {
    window.nuance.setOverlayInteractive(hovered !== null)
  }, [hovered])

  return (
    <div className={`overlay-root mode-${mode}${hovered ? ' hovering-word' : ''}`}>
      {mode === 'select' &&
        MOCK_WORDS.map((word) => (
          <div
            key={word.text}
            className={`word-box${hovered === word ? ' hovered' : ''}`}
            style={{
              left: word.bbox!.x,
              top: word.bbox!.y,
              width: word.bbox!.width,
              height: word.bbox!.height,
            }}
          />
        ))}
    </div>
  )
}
