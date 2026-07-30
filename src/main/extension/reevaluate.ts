import { EventEmitter } from 'node:events'
import { activeTabTracker } from './activeTab'
import { decideExtraction, type ExtractionDecision } from '../selection/decideOcr'
import { currentMode } from '../selection/shortcut'

// 담당 B — 선택 모드 중 탭/URL 변화 시 추출 방식 재판정.
// 사용자 요구: 브라우저 창을 선택하고 선택 모드에 들어갔을 때, 그리고 선택 모드를 유지한
// 채로 탭이 바뀌어 접속 사이트가 달라질 때마다 유튜브/넷플릭스 자막 vs OCR 을 다시 정한다.
// 실제 파이프라인 전환(자막 추출 시작/중단)은 후속 작업에서 이 emitter 를 구독해 붙인다.

type Events = {
  decision: [ExtractionDecision]
}

class Reevaluator extends EventEmitter<Events> {
  private registered = false

  register(): void {
    if (this.registered) return
    this.registered = true
    activeTabTracker.on('change', () => {
      // 선택 모드일 때만 재판정한다(일반 모드에선 오버레이가 없어 의미 없음).
      if (currentMode() !== 'select') return
      void this.reevaluate()
    })
  }

  async reevaluate(): Promise<ExtractionDecision> {
    const decision = await decideExtraction()
    this.emit('decision', decision)
    return decision
  }
}

export const reevaluator = new Reevaluator()

export function registerRejudgeOnTabChange(): void {
  reevaluator.register()
}
