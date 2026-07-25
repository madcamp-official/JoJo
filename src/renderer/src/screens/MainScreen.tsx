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
        onClick={() => window.nuance.openSettings()}
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
        {/* 데모 트리거(담당 B) — 담당 A 선택 파이프라인 통합 전, 호빗 "well-to-do" 팝업 미리보기.
            통합 후엔 선택 확정 시 자동으로 팝업이 뜨므로 이 버튼은 제거 예정. */}
        <button className="link-btn demo" onClick={() => window.nuance.openPopup()}>
          🔍 팝업 미리보기 (데모: well-to-do)
        </button>
      </div>
    </div>
  )
}
