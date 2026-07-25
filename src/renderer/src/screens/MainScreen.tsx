import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'

// 메인 화면 (PLAN.md §3 화면 구성) — 중앙 [창 선택] + 우상단 설정 아이콘.
// [담당 A] 창 선택 버튼 → 별도 모달 OS 창(WindowPickerScreen)에서 선택 완료 시 통지받는다.
export function MainScreen() {
  const [selected, setSelected] = useState<CaptureSource | null>(null)

  useEffect(() => window.nuance.onWindowSelected(setSelected), [])

  return (
    <div className="screen main-screen">
      <button
        className="icon-btn settings"
        title="설정"
        onClick={() => (window.location.hash = '#/settings')}
      >
        ⚙️
      </button>
      <div className="center">
        <button className="primary" onClick={() => window.nuance.openWindowPicker()}>
          🗔 창 선택
        </button>
        <p className="hint">
          {selected ? `선택됨: ${selected.name}` : '사용할 창을 선택하세요.'}
        </p>
      </div>
    </div>
  )
}
