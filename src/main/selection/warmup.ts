import { warmUp as warmUpLayout } from './layoutDetect'
import { warmUp as warmUpNdlocr } from './ocrNdlocr'
import { warmUpLanguage as warmUpPaddleLanguage } from './ocrPaddle'
import { warmUp as warmUpYomitoku } from './ocrYomitoku'

// 담당 A — 예열 시점/방식 재설계(2026-07-31, 사용자 요청 — "엔진 예열 시점 및 방식
// 수정"). 예전엔 DocLayout-YOLO/PaddleOCR/NDLOCR-lite/Yomitoku 를 전부 한 덩어리로 묶어
// 앱 시작 시 예열하고, 다 끝날 때까지 창 선택 버튼 자체를 막아뒀다 — 이제 두 그룹으로
// 나눈다:
//  1) 범용 엔진(DocLayout-YOLO) — 언어와 무관하게 항상 필요하다(resolveLayout 이 runOcr
//     진입 전에 항상 먼저 돈다, ocr.ts/extractionCache.ts). 앱 실행 시 무조건 예열을
//     시작하고, 끝나기를 기다리지 않고 창 선택을 곧바로 허용한다 — 아직 예열 중일 때
//     선택 모드에 들어가면 extractionCache.ts 가 그 대기 시간만큼 "엔진 예열 중..."
//     알림을 띄운다.
//  2) CJK 전용 엔진(PaddleOCR 인식/NDLOCR-lite/Yomitoku, ja/zh-Hans/zh-Hant) — 그 언어가
//     실제로 필요해지는 시점(설정에서 수동 고정, 앱 시작 시 이미 고정돼 있던 경우, 선택
//     모드에서 최종 언어가 그걸로 판별된 시점)에만 예열을 시작한다. 언어별로 독립된
//     Promise 를 메모이즈해 여러 지점에서 중복 호출돼도 실제 예열은 한 번만 돈다.

let generalPromise: Promise<void> | null = null
let generalReady = false

/** main/index.ts 가 앱 시작 시 한 번 호출한다 — 완료를 기다리지 않고 반환값은 무시해도
 * 된다(fire-and-forget). 진행 상태 확인은 isGeneralEngineWarm(). */
export function startGeneralWarmUp(): Promise<void> {
  if (!generalPromise) {
    generalPromise = warmUpLayout().then(() => {
      generalReady = true
    })
  }
  return generalPromise
}

export function isGeneralEngineWarm(): boolean {
  return generalReady
}

type CjkLanguage = 'ja' | 'zh-Hans' | 'zh-Hant'

const cjkPromises = new Map<CjkLanguage, Promise<void>>()
const cjkReady = new Set<CjkLanguage>()

/** 설정 수동 고정(ipc.ts: SETTINGS_SET) / 앱 시작 시 이미 고정된 경우(main/index.ts) /
 * 선택 모드에서 최종 언어가 판별된 시점(extractionCache.ts) — 세 지점 모두 이 함수를
 * 호출한다. 이미 예열 중이거나 끝났으면 그 Promise 를 그대로 재사용해 중복 예열을
 * 막는다. 일본어는 PaddleOCR 외에 NDLOCR-lite/Yomitoku 도 같이 예열한다(ocr.ts:
 * runVerticalOcr/runNonTesseractOcr 가 ja 경로에서 실제로 이 셋을 쓴다). */
export function ensureCjkEngineWarm(language: CjkLanguage): Promise<void> {
  let promise = cjkPromises.get(language)
  if (!promise) {
    const tasks = [warmUpPaddleLanguage(language)]
    if (language === 'ja') tasks.push(warmUpNdlocr(), warmUpYomitoku())
    promise = Promise.all(tasks).then(() => {
      cjkReady.add(language)
    })
    cjkPromises.set(language, promise)
  }
  return promise
}

export function isCjkEngineWarm(language: CjkLanguage): boolean {
  return cjkReady.has(language)
}
