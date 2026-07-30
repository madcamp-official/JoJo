import type { CaptureSource } from '@shared/types'
import { goto } from '../navigate'
import { BookIcon, FolderIcon, GearIcon, HelpIcon } from './icons'

// 메인 화면 (PLAN.md §4 화면 구성) — 제목 + 두 진입점(창 선택 / 자체 문서 뷰어) +
// 사용 설명서 링크, 우상단 설정 아이콘.
// [담당 A] 창 선택 → 같은 창 안에서 피커 화면으로 전환(goto), 선택 완료 시 App 이 통지받는다.
//
// 담당 A — 엔진 예열 대기로 인한 창 선택 버튼 비활성화 제거(2026-07-31, 사용자 요청 —
// "엔진 예열 시점 및 방식 수정"). 예전엔 DocLayout/PaddleOCR 예열이 끝날 때까지 이 버튼을
// 막아뒀는데, 이제 예열은 병렬로 백그라운드에서 계속 진행되고 선택 모드 진입은 항상 바로
// 허용한다 — 아직 예열 중일 때 선택 모드에 들어가면 그 대기 시간만큼 오버레이에 "엔진
// 예열 중..." 알림이 뜬다(extractionCache.ts, Overlay.tsx).
export function MainScreen({ selected }: { selected: CaptureSource | null }) {
  return (
    <div className="screen main-screen">
      <button className="icon-btn settings" title="설정" onClick={() => goto('settings')}>
        <GearIcon size={22} />
      </button>

      <div className="center">
        <h1 className="brand">Nuance</h1>

        <div className="main-actions">
          <button className="action primary" onClick={() => goto('picker')}>
            <FolderIcon />
            창 선택
          </button>
          {/* 자체 문서 뷰어 — 외부 뷰어와 달리 텍스트·좌표를 우리가 직접 계산하므로
              OCR 없이 바로 호버박스가 뜬다(OCR 예열과 무관해 항상 활성). */}
          <button className="action secondary" onClick={() => void window.nuance.openDocumentFile()}>
            <BookIcon />
            PDF / EPUB / TXT 뷰어
          </button>
        </div>

        {selected && <p className="hint">선택됨: {selected.name}</p>}

        {/* TODO: 사용 설명서 링크 연결(지금은 UI 만) */}
        <button className="manual-link" type="button">
          <HelpIcon />
          사용 설명서 보기
        </button>
      </div>
    </div>
  )
}
