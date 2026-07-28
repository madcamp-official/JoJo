import { warmUp as warmUpLayout } from './layoutDetect'
import { warmUp as warmUpPaddle } from './ocrPaddle'
import { warmUp as warmUpYomitoku } from './ocrYomitoku'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). Python 엔진(DocLayout-YOLO/
// PaddleOCR) 예열의 전체 완료 시점을 추적한다 — 렌더러(MainScreen)가 이걸 보고 창 선택
// 버튼을 막을지 정한다. 실측: Python 환경/모델 캐시가 이미 있으면 병렬로 진행돼 총 9초
// 정도 걸린다(가장 늦게 끝나는 게 병목) — 처음(캐시 없음)엔 모델 다운로드 시간이 더
// 붙는다. Python 환경 자체가 없으면(venv 미설치) 각 warmUp() 이 스폰 실패를 바로 잡아서
// 거의 즉시 끝나므로, 이 실험 기능이 없는 개발 환경에서도 버튼이 무기한 막히지 않는다.
//
// manga-ocr(ocrManga.ts)은 더 이상 기본 경로에서 안 쓴다(ocr.ts — 세로쓰기도 PaddleOCR
// 로 처리하는 게 실측상 4.6배 빠르고 정확해서 전환함) — 그래서 여기서도 예열을 안 한다.
// 풀 3개(~2.4GB) 를 아무도 안 쓰는데 미리 띄워두는 건 낭비라서. manga-ocr 모듈 자체는
// 지워지지 않고 남아있으니(망가 특화 재활용 등 옵션으로), 나중에 다시 연결하게 되면
// 이 예열도 다시 추가하면 된다.

let ready = false
let readyPromise: Promise<void> | null = null

/** main/index.ts 가 앱 시작 시 한 번 호출한다. */
export function startWarmUp(): Promise<void> {
  if (!readyPromise) {
    readyPromise = Promise.all([warmUpLayout(), warmUpPaddle(), warmUpYomitoku()]).then(() => {
      ready = true
    })
  }
  return readyPromise
}

export function isWarmedUp(): boolean {
  return ready
}
