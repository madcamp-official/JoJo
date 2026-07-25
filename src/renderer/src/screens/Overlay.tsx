import { useEffect, useState } from 'react'
import type { AppMode } from '@shared/types'

// 오버레이 (PLAN.md §4.1) — 담당 A
// 선택된 창 바로 바깥에 정렬되는 투명·클릭스루 창. 테두리 색으로 현재 모드를 보여준다
// (일반=파랑 / 선택=보라). windows.ts: showSelectionOverlay 가 위치를 잡아준다.
// TODO(담당 A): 단어 bbox 를 받아 hover/select 렌더, setIgnoreMouseEvents 토글.
export function Overlay() {
  const [mode, setMode] = useState<AppMode>('normal')

  useEffect(() => {
    window.nuance.getMode().then(setMode)
    return window.nuance.onModeChanged(setMode)
  }, [])

  return <div className={`overlay-root mode-${mode}`} />
}
