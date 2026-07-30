import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { goto } from '../navigate'
import { BookIcon, FolderIcon, GearIcon, HelpIcon } from './icons'

// 메인 화면 (PLAN.md §4 화면 구성) — 제목 + 두 진입점(창 선택 / 자체 문서 뷰어) +
// 사용 설명서 링크, 우상단 설정 아이콘.
// [담당 A] 창 선택 → 같은 창 안에서 피커 화면으로 전환(goto), 선택 완료 시 App 이 통지받는다.
export function MainScreen({ selected }: { selected: CaptureSource | null }) {
  // 실험용 브랜치(experiment/doclayout-yolo) — DocLayout/PaddleOCR 예열이
  // 안 끝난 상태에서 창을 고르면, 선택 모드 진입 시 그 예열 대기(첫 호출 8~20초+)를
  // 그대로 겪게 된다 — 그래서 예열 중엔 버튼을 막고 안내를 보여준다. 마운트 시 현재
  // 상태를 조회하고, 이미 끝나있으면(대부분의 경우 — 예열이 앱 시작과 거의 동시에
  // 시작되고 창 선택까지는 보통 몇 초 이상 걸림) 바로 버튼이 활성화된다.
  const [warmedUp, setWarmedUp] = useState(false)
  useEffect(() => {
    window.nuance.getWarmupStatus().then(setWarmedUp)
    return window.nuance.onWarmupReady(() => setWarmedUp(true))
  }, [])

  return (
    <div className="screen main-screen">
      <button className="icon-btn settings" title="설정" onClick={() => goto('settings')}>
        <GearIcon size={22} />
      </button>

      <div className="center">
        <h1 className="brand">Nuance</h1>

        <div className="main-actions">
          <button className="action primary" disabled={!warmedUp} onClick={() => goto('picker')}>
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

        {!warmedUp && <p className="hint">텍스트 인식 엔진을 준비하는 중이에요...</p>}
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
