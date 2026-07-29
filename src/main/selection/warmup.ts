import { warmUp as warmUpLayout } from './layoutDetect'
import { warmUp as warmUpNdlocr } from './ocrNdlocr'
import { warmUp as warmUpPaddle } from './ocrPaddle'
import { warmUp as warmUpYomitoku } from './ocrYomitoku'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). Python 엔진(DocLayout-YOLO/
// PaddleOCR) 예열의 전체 완료 시점을 추적한다 — 렌더러(MainScreen)가 이걸 보고 창 선택
// 버튼을 막을지 정한다. 실측: Python 환경/모델 캐시가 이미 있으면 병렬로 진행돼 총 9초
// 정도 걸린다(가장 늦게 끝나는 게 병목) — 처음(캐시 없음)엔 모델 다운로드 시간이 더
// 붙는다. Python 환경 자체가 없으면(venv 미설치) 각 warmUp() 이 스폰 실패를 바로 잡아서
// 거의 즉시 끝나므로, 이 실험 기능이 없는 개발 환경에서도 버튼이 무기한 막히지 않는다.

let ready = false
let readyPromise: Promise<void> | null = null

/** main/index.ts 가 앱 시작 시 한 번 호출한다. */
export function startWarmUp(): Promise<void> {
  if (!readyPromise) {
    readyPromise = Promise.all([warmUpLayout(), warmUpPaddle(), warmUpNdlocr(), warmUpYomitoku()]).then(() => {
      ready = true
    })
  }
  return readyPromise
}

export function isWarmedUp(): boolean {
  return ready
}
