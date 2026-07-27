import { nativeImage } from 'electron'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import type { Language, Rect } from '@shared/types'

// 담당 A — 언어 자동 감지 (PLAN.md §4.1 / §5)
// 파이프라인 순서: 본문 영역 탐지(DocLayout-YOLO) → 언어 감지(여기) → 읽기 순서/OCR.
// 영역이 이미 정해진 뒤에 그 안에서만 감지해야, 메뉴바처럼 본문과 다른 언어인 UI
// 텍스트에 안 흔들린다 — 그래서 region 을 받아 그 부분만 크롭해서 검사한다.
//
// Tesseract 의 OSD(Orientation & Script Detection, `osd.traineddata`)를 그대로
// 쓴다 — 전체 인식을 돌리지 않고 스크립트(문자 체계)만 빠르게 판별해주는 경량
// 기능이라 별도 모델을 새로 붙일 필요가 없다. 스크립트 → 우리 Language 타입(en/ja/zh)
// 매핑은 근사치다: 일본어는 히라가나/가타카나가 섞이면 "Japanese"로 뚜렷이 나오지만,
// 한자만 있는 텍스트는 중국어와 구분이 안 돼 "Han"으로 나온다(이 경우 zh 로 취급).
// 한글(Korean)은 Language 타입에 아직 자리가 없어 감지는 로그로 남기되 en 폴백.

let osdWorker: Worker | null = null

async function getOsdWorker(): Promise<Worker> {
  // worker.detect() 는 osd.traineddata 안의 "Legacy" 엔진 모델을 요구한다 — 기본
  // OEM(LSTM_ONLY)로 만들면 "LSTM requested, but not present!!"로 LSTM 을 대신
  // 로드하려다 실패해서 "requires Legacy model, which was not loaded" 에러가 난다.
  if (!osdWorker) osdWorker = await createWorker('osd', OEM.TESSERACT_ONLY)
  return osdWorker
}

const SCRIPT_TO_LANGUAGE: Record<string, Language> = {
  Japanese: 'ja',
  Hiragana: 'ja',
  Katakana: 'ja',
  Han: 'zh',
  Latin: 'en',
}

/**
 * region 을 주면 그 부분만 크롭해서 검사한다(권장 — 본문 영역이 정해진 뒤 호출).
 * image 가 없으면(아직 캡처 전 등) 감지를 시도하지 않고 기본값 'en' 을 반환한다.
 *
 * 검증용으로 스크립트/신뢰도를 콘솔에 항상 로그로 남긴다 — 언어별 테스트 콘텐츠로
 * 실제로 잘 잡히는지 눈으로 바로 확인할 수 있게.
 */
export async function detectLanguage(image?: Buffer, region?: Rect): Promise<Language> {
  if (!image) return 'en'
  try {
    const worker = await getOsdWorker()
    const target = region
      ? nativeImage
          .createFromBuffer(image)
          .crop({
            x: Math.max(0, Math.round(region.x)),
            y: Math.max(0, Math.round(region.y)),
            width: Math.max(1, Math.round(region.width)),
            height: Math.max(1, Math.round(region.height)),
          })
          .toPNG()
      : image

    const { data } = await worker.detect(target)
    console.log('[langDetect] OSD 결과:', {
      script: data.script,
      scriptConfidence: data.script_confidence,
      orientationDegrees: data.orientation_degrees,
      orientationConfidence: data.orientation_confidence,
    })

    if (!data.script) {
      console.warn('[langDetect] 스크립트를 못 잡음 — en 으로 폴백')
      return 'en'
    }
    const lang = SCRIPT_TO_LANGUAGE[data.script]
    if (!lang) {
      console.warn(`[langDetect] 매핑 안 된 스크립트("${data.script}") — en 으로 폴백`)
      return 'en'
    }
    return lang
  } catch (err) {
    console.error('[langDetect] 감지 실패 — en 으로 폴백:', err)
    return 'en'
  }
}
