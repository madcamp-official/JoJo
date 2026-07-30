import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { goto } from '../navigate'

// 창 선택 화면 (PLAN.md §4) — 메인 창 안에서 리사이즈로 전환된다(windows.ts: setMainWindowRoute).
// [담당 A] desktopCapturer/win32Capture 창 목록(썸네일)을 보여주고 선택.
export function WindowPickerScreen() {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.nuance.listWindows().then((list) => {
      if (!cancelled) setSources(list)
      setLoading(false)
    })
    window.nuance.getSelectedWindowId().then((id) => {
      if (!cancelled) setSelectedId(id)
    })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // 이미 선택된 창이 있는 상태에서 (재선택 없이) 나가는 거라면 메인 화면을 띄우지
      // 않고 그냥 숨긴다 — 원래 창 선택 중엔 메인 창이 숨어 있던 상태였으므로 그대로 복귀.
      if (selectedId != null) void window.nuance.hideMainWindow()
      else goto('main')
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [selectedId])

  async function pick(source: CaptureSource) {
    await window.nuance.selectWindow(source)
    goto('main')
  }

  return (
    <div className="picker-screen">
      <div className="picker-header">
        <button className="icon-btn back" onClick={() => goto('main')}>
          ←
        </button>
        <h2>창 선택</h2>
        {loading && <span className="hint">창 목록을 불러오는 중...</span>}
      </div>
      {!loading && sources.length === 0 && <p className="hint">캡처 가능한 창이 없습니다.</p>}
      <div className="window-grid">
        {sources.map((s) => (
          <button
            key={s.id}
            className={`window-tile${s.id === selectedId ? ' selected' : ''}`}
            onClick={() => void pick(s)}
          >
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
