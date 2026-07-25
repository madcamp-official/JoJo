import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'

// 창 선택 화면 (PLAN.md §3) — 별도 모달 OS 창으로 뜬다 (windows.ts: showWindowPicker).
// [담당 A] desktopCapturer/win32Capture 창 목록(썸네일)을 보여주고 선택.
export function WindowPickerScreen() {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.nuance.listWindows().then((list) => {
      if (!cancelled) setSources(list)
      setLoading(false)
    })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') window.nuance.closeWindowPicker()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div className="picker-screen">
      <div className="picker-header">
        <h2>창 선택</h2>
        {loading && <span className="hint">창 목록을 불러오는 중...</span>}
        <button className="icon-btn close" onClick={() => window.nuance.closeWindowPicker()}>
          ✕
        </button>
      </div>
      {!loading && sources.length === 0 && <p className="hint">캡처 가능한 창이 없습니다.</p>}
      <div className="window-grid">
        {sources.map((s) => (
          <button key={s.id} className="window-tile" onClick={() => window.nuance.selectWindow(s)}>
            <div className="thumb">
              <img src={s.thumbnail} alt={s.name} />
            </div>
            <span>{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
