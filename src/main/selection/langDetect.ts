import { nativeImage } from 'electron'
import { createWorker, OEM, type Worker } from 'tesseract.js'
import type { AnyLanguage, Rect } from '@shared/types'
import { detectHanziVariant, detectRawLanguage, HAN_CHAR_RE } from '@shared/languageDetect'
import { getOcrLangCode } from '@shared/languages'
import { getLanguageOverride } from '../settingsStore'
import { TESSDATA_CACHE_PATH } from './tessdataCache'

// 담당 A — 언어 자동 감지 (PLAN.md §5.1 / §6 / §7)
// 파이프라인 순서: 본문 영역 탐지(DocLayout-YOLO) → 언어 감지(여기) → 읽기 순서/OCR.
// 영역이 이미 정해진 뒤에 그 안에서만 감지해야, 메뉴바처럼 본문과 다른 언어인 UI
// 텍스트에 안 흔들린다 — 그래서 region 을 받아 그 부분만 크롭해서 검사한다.
//
// Tesseract 의 OSD(Orientation & Script Detection, `osd.traineddata`)를 그대로
// 쓴다 — 전체 인식을 돌리지 않고 스크립트(문자 체계)만 빠르게 판별해주는 경량
// 기능이라 별도 모델을 새로 붙일 필요가 없다. 문제는 OSD가 "문자 체계"까지만
// 알려주고 "어느 언어"인지는 모른다는 것 — 스크립트 하나에 언어가 딱 하나면
// 문제없지만(태국어=Thai 스크립트, 히브리어=Hebrew 스크립트 등), 라틴/키릴/아랍/
// 데바나가리 문자는 tier2 확장(2026-07-30) 이후 여러 언어가 같은 스크립트를 공유한다
// (예: 라틴 문자만 en/프랑스어/독일어/스페인어 등 20개 이상). 이 경우
// resolveAmbiguousScript() 가 그 스크립트의 "대표 언어팩"으로 러프하게 한 번 OCR을
// 미리 돌려 텍스트를 뽑은 뒤, eld(자막 판별에 쓰는 것과 동일한 텍스트 기반 판별기)로
// 정확한 언어를 한 번 더 가른다 — zh-Hans/zh-Hant를 표본 문자로 가르던 것과 같은
// "1차 대충 인식 → 텍스트로 재판별" 패턴을 일반화한 것.

let osdWorker: Worker | null = null

async function getOsdWorker(): Promise<Worker> {
  // worker.detect() 는 osd.traineddata 안의 "Legacy" 엔진 모델을 요구한다 — 기본
  // OEM(LSTM_ONLY)로 만들면 "LSTM requested, but not present!!"로 LSTM 을 대신
  // 로드하려다 실패해서 "requires Legacy model, which was not loaded" 에러가 난다.
  if (!osdWorker) osdWorker = await createWorker('osd', OEM.TESSERACT_ONLY, { cachePath: TESSDATA_CACHE_PATH })
  return osdWorker
}

// 스크립트별 표본 추출 워커 재사용 풀 — 언어팩 로드 비용이 커서 매번 새로 만들지 않는다.
const probeWorkers = new Map<string, Worker>()

async function getProbeWorker(ocrLang: string): Promise<Worker> {
  const existing = probeWorkers.get(ocrLang)
  if (existing) return existing
  const worker = await createWorker(ocrLang, undefined, { cachePath: TESSDATA_CACHE_PATH })
  probeWorkers.set(ocrLang, worker)
  return worker
}

/**
 * OSD가 "Han"(간체/번체 구분이 안 되는 한자)으로만 판정했을 때, 실제 스크립트를 표본
 * 문자 카운트(@shared/languageDetect 의 detectHanziVariant, OpenCC 전체 간체/번체
 * 전용 한자 매핑 기반)로 가른다. 인식 실패 시 기본값 zh-Hans 로 폴백한다.
 */
async function detectChineseScript(target: Buffer): Promise<'zh-Hans' | 'zh-Hant'> {
  try {
    const worker = await getProbeWorker('chi_sim')
    const { data } = await worker.recognize(target)
    const variant = detectHanziVariant(data.text)
    console.log(`[langDetect] 간체/번체 판별 결과: ${variant}`)
    return variant
  } catch (err) {
    console.error('[langDetect] 간체/번체 판별 실패 — zh-Hans 로 폴백:', err)
    return 'zh-Hans'
  }
}

// 담당 A — 라틴 계열 오판정에 대한 한자 교차 확인 임계값(2026-07-30, 사용자 제보 —
// 중국어 세로쓰기 화면에 애매한 글자 하나(×/X 등)가 섞여 있으면 OSD가 전체를 Latin
// 스크립트로 오판하고, 그 뒤 대표 언어(영어)로 대충 인식해봐도 실제 텍스트가 거의 없어
// eld 재판별도 엉뚱한 결과를 내거나 실패해 결국 영어로 폴백됐다). 대표 언어 확률용 rough
// 인식 결과에 한자가 이 비율 이상 섞여 있으면(원래 한자 위주 화면인데 애매한 글자 하나에
// OSD 가 낚인 경우) 라틴 계열이 아니라 중국어로 재분류한다 — 과반(0.5)으로 잡아서, 진짜
// 라틴 문자권 텍스트에 어쩌다 한자 하나가 섞인 정상적인 경우까지 오검출하지 않게 한다.
const HAN_CROSSCHECK_RATIO = 0.5

// 담당 A — 비라틴 스크립트 오판정에 대한 라틴 교차 확인(2026-07-30, 사용자 제보 — 크고
// 선명한 영어 문단도 기울임(oblique/italic) 폰트면 OSD가 Arabic 스크립트로 오판하는 사례.
// 아랍 문자는 획이 기울고 이어지는 특성이 있어, 기울임 라틴 문자와 획 방향 통계가 비슷하게
// 잡히는 것이 Tesseract OSD의 알려진 약점이다). HAN_CROSSCHECK_RATIO 와 대칭인 안전망:
// Arabic/Cyrillic/Devanagari 후보군에서 eld 재판별이 실패하면 영어 언어팩으로 한 번 더
// 러프 인식해보고, 결과가 대부분 ASCII 라틴 문자이면서 eld 가 라틴 후보 중 하나로
// 판별되면 OSD 스크립트 판정 자체가 틀렸다고 보고 그쪽으로 재분류한다. 비율을 한자
// 교차 확인(0.5)보다 높게 잡은 이유: 진짜 아랍/키릴 텍스트를 영어 모델로 인식해도 깨진
// 라틴 문자가 어느 정도 나오므로, "거의 전부 라틴 글자"일 때만 뒤집게 보수적으로 둔다.
const LATIN_CROSSCHECK_RATIO = 0.7
const LATIN_CHAR_RE = /[A-Za-z]/

// Latin 스크립트 공유 후보 목록 — SCRIPT_TO_LANGUAGE.Latin 과 라틴 교차 확인이 공유한다.
// 대표(폴백)를 맨 앞에 — 라틴 문자는 영어를 기본값으로 유지(tier1 우선순위 존중).
// 'is'(아이슬란드어)는 2026-07-30 tier2 도입 때 이 배열에서 누락돼 항상 en으로 오판되던
// 버그를 전수조사로 발견해 추가함 — eld/Tesseract 둘 다 라틴 문자 기준으로 일치해 정상 동작.
// 'ku'(쿠르드어)는 의도적으로 여기 없음: eld의 ku 모델은 소라니(아랍 문자)라 이 배열(라틴)에
// 넣어도 eld가 절대 'ku'를 반환하지 않는다 — tier3로 되돌림(languages.ts 참고).
const LATIN_CANDIDATES: AnyLanguage[] = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'vi', 'ro', 'cs', 'hu', 'sv', 'da', 'no', 'fi', 'hr', 'sq', 'tl', 'az', 'ca', 'et', 'eu', 'is', 'lt', 'lv', 'ms', 'sk', 'sl']

/** 비라틴 후보군에서 재판별이 실패했을 때, 실은 라틴 스크립트였는지 영어 언어팩으로
 *  교차 확인한다. 라틴이 맞으면 그 언어를, 아니면 null 을 반환한다. */
async function crosscheckLatin(target: Buffer): Promise<AnyLanguage | null> {
  try {
    const worker = await getProbeWorker(getOcrLangCode('en'))
    const { data } = await worker.recognize(target)
    const nonSpace = data.text.replace(/\s/g, '')
    const latinCount = [...nonSpace].filter((ch) => LATIN_CHAR_RE.test(ch)).length
    if (nonSpace.length === 0 || latinCount / nonSpace.length < LATIN_CROSSCHECK_RATIO) return null
    const raw = detectRawLanguage(data.text)
    return LATIN_CANDIDATES.find((c) => c === raw) ?? null
  } catch (err) {
    console.error('[langDetect] 라틴 교차 확인 오류 — 건너뜀:', err)
    return null
  }
}

/** 한 스크립트를 공유하는 언어가 여럿일 때(예: 라틴 문자), 첫 번째 후보를 "러프 인식용
 *  대표 언어팩"으로 써서 텍스트를 뽑고, eld로 그 텍스트의 실제 언어를 재판별한다. eld가
 *  이 스크립트 후보 목록 밖의 언어를 감지하거나 실패하면, 그 rough 인식 결과 자체에
 *  한자가 실제로 상당수 섞여 있는지 교차 확인한다(HAN_CROSSCHECK_RATIO) — OSD 의 최초
 *  스크립트 판정 자체가 틀렸을 가능성을 마지막으로 한 번 더 검토하는 안전망. 그것도
 *  아니면 대표 언어(candidates[0])로 폴백한다 — 화면 캡처는 자막보다 텍스트 표본이
 *  훨씬 짧을 수 있어(단어 하나 등) eld 가 실패할 가능성이 자막 경로보다 높다는 점을
 *  감안한 안전망. */
async function resolveAmbiguousScript(target: Buffer, candidates: AnyLanguage[]): Promise<AnyLanguage> {
  const representative = candidates[0]!
  try {
    const worker = await getProbeWorker(getOcrLangCode(representative))
    const { data } = await worker.recognize(target)
    const raw = detectRawLanguage(data.text)
    const resolved = candidates.find((c) => c === raw)
    if (resolved) {
      console.log(`[langDetect] 스크립트 내 언어 재판별: ${raw} → ${resolved}`)
      return resolved
    }
    const nonSpace = data.text.replace(/\s/g, '')
    const hanCount = [...nonSpace].filter((ch) => HAN_CHAR_RE.test(ch)).length
    if (nonSpace.length > 0 && hanCount / nonSpace.length >= HAN_CROSSCHECK_RATIO) {
      const variant = await detectChineseScript(target)
      console.log(
        `[langDetect] 스크립트 내 언어 재판별 실패(raw=${raw ?? 'null'}) + 한자 교차 확인(${hanCount}/${nonSpace.length}) — ${variant} 로 재분류`,
      )
      return variant
    }
    if (!candidates.includes('en')) {
      const latin = await crosscheckLatin(target)
      if (latin) {
        console.log(
          `[langDetect] 스크립트 내 언어 재판별 실패(raw=${raw ?? 'null'}) + 라틴 교차 확인 성공 — OSD 오판으로 보고 ${latin} 로 재분류`,
        )
        return latin
      }
    }
    console.log(`[langDetect] 스크립트 내 언어 재판별 실패(raw=${raw ?? 'null'}) — 대표 언어(${representative})로 폴백`)
    return representative
  } catch (err) {
    console.error('[langDetect] 스크립트 내 언어 재판별 오류 — 대표 언어로 폴백:', err)
    return representative
  }
}

// OSD 스크립트 이름 → 언어 매핑. 값이 배열이면 "이 스크립트를 공유하는 후보들"이라는
// 뜻으로 resolveAmbiguousScript를 태운다(배열의 첫 원소가 그 스크립트의 대표/폴백 언어).
// 'zh'는 detectChineseScript로 별도 처리(간체/번체 세분화)하므로 여기 값에는 없다.
const SCRIPT_TO_LANGUAGE: Record<string, AnyLanguage | 'zh' | AnyLanguage[]> = {
  Japanese: 'ja',
  Hiragana: 'ja',
  Katakana: 'ja',
  Han: 'zh',
  Hangul: 'ko',
  Thai: 'th',
  Lao: 'lo',
  Hebrew: 'he',
  Armenian: 'hy',
  Georgian: 'ka',
  Greek: 'el',
  Bengali: 'bn',
  Gujarati: 'gu',
  Gurmukhi: 'pa',
  Kannada: 'kn',
  Malayalam: 'ml',
  Oriya: 'or',
  Tamil: 'ta',
  Telugu: 'te',
  Ethiopic: 'am',
  Latin: LATIN_CANDIDATES,
  Cyrillic: ['ru', 'uk', 'bg', 'be', 'sr'],
  Arabic: ['ar', 'fa', 'ur'],
  Devanagari: ['hi', 'mr'],
}

/**
 * region 을 주면 그 부분만 크롭해서 검사한다(권장 — 본문 영역이 정해진 뒤 호출).
 * image 가 없으면(아직 캡처 전 등) 감지를 시도하지 않고 기본값 'en' 을 반환한다.
 *
 * 설정에서 특정 언어를 수동 지정했으면(getLanguageOverride) OSD/Tesseract 자체를
 * 아예 안 돌리고 그 값을 바로 돌려준다(2026-07-30) — 라틴/키릴/아랍/데바나가리처럼
 * 여러 언어가 스크립트를 공유해 자동판별(resolveAmbiguousScript)이 흔들릴 수 있는
 * 경우, 사용자가 이렇게 확정해 모호성 자체를 없앨 수 있다. 부수 효과로 OSD+2차 인식
 * 비용도 아낀다.
 *
 * 검증용으로 스크립트/신뢰도를 콘솔에 항상 로그로 남긴다 — 언어별 테스트 콘텐츠로
 * 실제로 잘 잡히는지 눈으로 바로 확인할 수 있게.
 */
export async function detectLanguage(image?: Buffer, region?: Rect): Promise<AnyLanguage> {
  const override = getLanguageOverride()
  if (override) return override
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
    const mapped = SCRIPT_TO_LANGUAGE[data.script]
    if (!mapped) {
      console.warn(`[langDetect] 매핑 안 된 스크립트("${data.script}") — en 으로 폴백(tier3 스크립트, OCR 자체는 시도)`)
      return 'en'
    }
    if (mapped === 'zh') return detectChineseScript(target)
    if (Array.isArray(mapped)) return resolveAmbiguousScript(target, mapped)
    return mapped
  } catch (err) {
    console.error('[langDetect] 감지 실패 — en 으로 폴백:', err)
    return 'en'
  }
}
