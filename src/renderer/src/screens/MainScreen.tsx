import { useEffect, useState } from 'react'
import type { CaptureSource } from '@shared/types'
import { goto } from '../navigate'
import { GearIcon } from './icons'

// 메인 화면 (PLAN.md §4 화면 구성) — 중앙 [창 선택] + 우상단 설정 아이콘.
// [담당 A] 창 선택 버튼 → 같은 창 안에서 피커 화면으로 전환(goto), 선택 완료 시 App 이 통지받는다.
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
        <button className="primary" disabled={!warmedUp} onClick={() => goto('picker')}>
          창 선택
        </button>
        {!warmedUp && <p className="hint">텍스트 인식 엔진을 준비하는 중이에요…</p>}
        {selected && <p className="hint">선택됨: {selected.name}</p>}
        {/* 데모 트리거(담당 B) — 담당 A 선택 파이프라인 통합 전, 언어별 팝업 미리보기.
            통합 후엔 선택 확정 시 자동으로 팝업이 뜨므로 이 버튼들은 제거 예정. */}
        <button className="link-btn demo" onClick={() => window.nuance.openPopup('hobbit')}>
          🔍 팝업 미리보기 (영어: well-to-do)
        </button>
        <button className="link-btn demo" onClick={() => window.nuance.openPopup('en-bank')}>
          🔍 팝업 미리보기 (영어 동음이의어: bank)
        </button>
        <button className="link-btn demo" onClick={() => window.nuance.openPopup('ja')}>
          🔍 팝업 미리보기 (일본어: 新大橋)
        </button>
        <button className="link-btn demo" onClick={() => window.nuance.openPopup('zh-Hans')}>
          🔍 팝업 미리보기 (중국어(간체): 天线)
        </button>
        <button className="link-btn demo" onClick={() => window.nuance.openPopup('zh-Hant')}>
          🔍 팝업 미리보기 (중국어(번체): 行)
        </button>
      </div>
    </div>
  )
}
