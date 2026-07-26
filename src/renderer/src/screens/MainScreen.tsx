import type { CaptureSource } from '@shared/types'
import { goto } from '../navigate'

// 메인 화면 (PLAN.md §3 화면 구성) — 중앙 [창 선택] + 우상단 설정 아이콘.
// [담당 A] 창 선택 버튼 → 같은 창 안에서 피커 화면으로 전환(goto), 선택 완료 시 App 이 통지받는다.
export function MainScreen({ selected }: { selected: CaptureSource | null }) {
  return (
    <div className="screen main-screen">
      <button className="icon-btn settings" title="설정" onClick={() => goto('settings')}>
        ⚙️
      </button>
      <div className="center">
        <button className="primary" onClick={() => goto('picker')}>
          창 선택
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
