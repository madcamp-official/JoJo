import type { AnyLanguage, Rect, SelectionSource, Word } from '@shared/types'
import { getLanguageName } from '@shared/languages'
import { getPhysicalToDipScale, sendDetectedBlocks, sendExtractionPhase, sendOverlayWords, sendRegionInfo } from '../windows'
import { captureFocusedWindow, getSelectedWindowId } from './capture'
import { detectLanguage } from './langDetect'
import { getLastExtractionBlocks, resolveLayout, runOcr } from './ocr'
import { getRegion } from './regionSelection'
import { ensureCjkEngineWarm, isCjkEngineWarm, isGeneralEngineWarm, startGeneralWarmUp } from './warmup'

// 담당 A — 선택 창 추출 결과 캐시 (PLAN.md §5.1 / §8)
// 클릭할 때마다 캡처+OCR을 새로 돌리면 매번 1~3초씩 걸린다 — 대신 선택 모드
// 진입 시(shortcut.ts: toggleMode) 미리 한 번 돌려서 캐시해두고, 클릭 시엔 이미
// 준비된 결과를 즉시 쓴다. 선택 모드를 나갔다 다시 들어올 때마다 항상 새로
// 캡처+OCR 한다(재진입 = 최신화) — 그 사이 스크롤 등으로 내용이 바뀌었을 수 있어서.
//
// 접근성 API(WM_GETTEXT 등)로 표준 텍스트 컨트롤의 내용을 직접 읽는 "direct" 추출은
// 시도해봤지만 쓰지 않기로 했다(2026-07-30 정리, 관련 코드 제거) — "클릭한 단어 기준
// 앞뒤 범위만 팝업에 표시"하려면 클릭 지점이 어떤 단어인지 알아야 하고, 그러려면 화면
// 좌표(bbox)가 필수인데 direct 추출은 좌표를 못 만든다(문자열만 얻음). 좌표 때문에 결국
// 항상 OCR을 돌려야 해서, 지금 파이프라인에서는 direct 판정 자체가 의미가 없다 — 항상
// OCR만 쓴다.

export interface CachedExtraction {
  text: string
  words: Word[]
  language: AnyLanguage
  source: SelectionSource
  extraction: 'direct' | 'ocr'
  /** OCR이 실제로 텍스트를 찾아낸 영역 시각화용(오버레이 DIP 정렬 완료, 노란 점선
   *  사각형으로 3초간 표시) — 항상 채워진다(2026-07-31, 설정/개발 모드 조건 제거).
   *  담당 A(2026-07-30): 예전엔 runExtraction 안에서 바로 sendDetectedBlocks 했는데,
   *  그러면 폐기된(abandonInFlightExtraction) 추출도 커밋 가드와 무관하게 오염된 화면
   *  기준 블록을 오버레이에 쏴버렸다 — 결과에 담아 커밋 시점(가드 안)에만 보내고, 캐시
   *  복원(changeWatcher 복귀 판정) 때도 같이 복원할 수 있게 한다. */
  detectedBlocks: Rect[]
}

let cached: CachedExtraction | null = null
let inFlight: Promise<CachedExtraction> | null = null

// 직전 회차 추출 결과 — 다음 추출의 문맥으로 재사용하기 위한 히스토리(요청, 2026-07-29).
// 항상 "바로 직전 1회차"만 보관한다: 3번째 추출이 끝나면 1번째 기록은 버려지고 2번째
// 기록으로 교체된다(refreshExtractionCache 참고, cached → previousExtraction 으로 밀어냄
// 뒤 새 결과를 cached 에 넣는 순서). 형식은 팝업 본문에 실제로 쓰이는 것과 동일한
// CachedExtraction.text(=extracted.text, words 결합 원문)를 그대로 저장한다 — 별도
// 가공/재포맷 없음. 선택된 창을 전환/해제하면 clearExtractionHistory() 로 비운다.
let previousExtraction: CachedExtraction | null = null

// 단계별 소요 시간 확인용(임시 계측) — 어느 단계가 병목인지 실사용 로그로 바로 보려고
// 붙였다. 콘솔에 [timing] 접두어로 남는다.
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    console.log(`[timing] ${label}: ${Date.now() - start}ms`)
  }
}

async function runExtraction(): Promise<CachedExtraction> {
  const overallStart = Date.now()
  const image = await timed('capture', () => captureFocusedWindow())
  // getRegion() 은 이미 캡처 좌표계(물리 픽셀)로 저장돼 있어(regionSelection.ts:
  // submitRegionFromOverlay 가 변환) 추가 변환 없이 그대로 resolveLayout/runOcr 에 넘길 수 있다.
  const region = getRegion() ?? undefined

  // 담당 A — 추출 파이프라인 5단계 알림 재설계(2026-07-31, 사용자 요청). 범용 엔진
  // (DocLayout-YOLO)은 앱 시작 시 백그라운드로 예열이 시작되지만(main/index.ts), 그
  // 예열이 아직 안 끝난 채로 선택 모드에 들어오면 여기서 그 대기를 그대로 겪는다 —
  // 예열 중일 때만 "엔진 예열 중..." 을 띄운다(이미 끝났으면 조용히 넘어간다).
  if (!isGeneralEngineWarm()) {
    sendExtractionPhase('엔진 예열 중...')
    await startGeneralWarmUp()
  }
  // "DocLayout 을 한 다음에 언어 탐지가 일어나게" — 레이아웃(영역) 탐지를 언어 감지보다
  // 먼저 실행한다. region 은 이미 확정돼 있으므로(위 getRegion()) 이 순서 변경이 언어
  // 감지의 정확도(영역 밖 다른 언어 UI 텍스트에 안 흔들림)에는 영향이 없다.
  sendExtractionPhase('영역 탐지 중...')
  const layout = await timed('layout detect', () => resolveLayout(image, region))

  sendExtractionPhase('언어 감지 중...')
  const language = await timed('language detect', () => detectLanguage(image, region))

  // CJK 전용 엔진(PaddleOCR 인식/NDLOCR-lite/Yomitoku)은 최종 언어가 실제로 ja/zh 로
  // 판별된 이 시점에야 필요해진다 — 설정에서 이미 수동 고정돼 있었거나(main/index.ts,
  // ipc.ts) 직전 선택 모드에서 같은 언어를 이미 썼다면 대부분 여기서 곧바로 통과한다.
  if ((language === 'ja' || language === 'zh-Hans' || language === 'zh-Hant') && !isCjkEngineWarm(language)) {
    sendExtractionPhase(`${getLanguageName(language)} 인식 엔진 준비 중...`)
    await ensureCjkEngineWarm(language)
  }

  sendExtractionPhase('텍스트 추출 중...')
  const extracted = await timed(`ocr(${language})`, () => runOcr(image, language, layout, region))
  console.log(`[timing] total: ${Date.now() - overallStart}ms`)

  // OCR이 실제로 텍스트를 찾아낸 영역(열/블록 단위)을 오버레이에 노란 점선 사각형으로
  // 매 추출마다 3초간 보여준다(2026-07-31 재설계, 사용자 요청) — 설정/개발 모드 여부와
  // 무관하게 항상 계산해서 보낸다. words 와 같은 좌표 보정(물리 픽셀 → 오버레이 DIP)이
  // 필요해서 alignWordsToOverlay 를 그대로 재사용한다(Rect 를 텍스트 없는 가짜 Word 로
  // 감싸서 넘기고 bbox 만 다시 뺌).
  const rawDetectedBlocks = getLastExtractionBlocks()
  const alignedDetected = await alignWordsToOverlay(rawDetectedBlocks.map((bbox) => ({ text: '', bbox })))
  const detectedBlocks = alignedDetected.map((w) => w.bbox).filter((b): b is Rect => b !== undefined)

  const alignedWords = await alignWordsToOverlay(extracted.words)
  // 담당 A — 클릭 매핑 어긋남 진단용(2026-07-30, 사용자 제보). 물리 픽셀→DIP 보정
  // (alignWordsToOverlay) 전후 bbox 를 나란히 남겨, 이 변환 자체가 어긋남을 만드는지
  // 확인한다.
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `align-${Date.now()}.json`),
      JSON.stringify(
        extracted.words.map((w, i) => ({ text: w.text, raw: w.bbox ?? null, aligned: alignedWords[i]?.bbox ?? null })),
        null,
        2,
      ),
    )
  }

  return {
    text: extracted.text,
    words: alignedWords,
    language: extracted.language,
    source: { kind: 'ocr' },
    extraction: 'ocr',
    detectedBlocks,
  }
}

/**
 * OCR bbox(캡처 이미지 기준, 물리 픽셀)를 오버레이 렌더링 기준(DIP)으로 맞춘다. 두 가지
 * 보정이 필요하다:
 *  1) 원점 보정 — 캡처(PrintWindow)는 `GetWindowRect` 좌표계(안 보이는 리사이즈 테두리
 *     포함)로 그려지는데, 오버레이는 `getWindowScreenRect`(DWM 확장 프레임 = 실제 보이는
 *     경계) 기준으로 배치돼서 두 원점이 몇 px 어긋난다(getCaptureOriginOffset).
 *  2) 배율 보정 — 캡처·OCR 은 물리 픽셀인데 오버레이는 DIP 기준이라, 디스플레이 배율이
 *     100%가 아니면 그대로 쓰면 어긋난다(getPhysicalToDipScale).
 * 원점 보정을 물리 픽셀 단위에서 먼저 적용한 뒤 배율로 나눈다(순서 중요).
 */
async function alignWordsToOverlay(words: Word[]): Promise<Word[]> {
  // macOS: screencapture 는 물리 픽셀(Retina 2x 등)로 캡처하고, 오버레이는 창의 DIP bounds 에
  // 정렬돼 있다(macWindow: CGWindow bounds = 포인트). 원점은 창 좌상단으로 동일하므로 배율만
  // 보정한다(물리 px → DIP: scaleFactor 로 나눔). win32 처럼 프레임 원점 오프셋은 없다.
  if (process.platform === 'darwin') {
    const id = getSelectedWindowId()
    const wid = Number(/^window:(\d+)/.exec(id ?? '')?.[1])
    if (!Number.isFinite(wid)) return words
    const { getMacWindowBounds } = await import('./macWindow')
    const bounds = getMacWindowBounds(wid)
    if (!bounds) return words
    const { screen } = await import('electron')
    const scale =
      screen.getDisplayMatching({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      }).scaleFactor || 1
    if (scale === 1) return words
    return words.map((w) =>
      w.bbox
        ? {
            ...w,
            bbox: {
              x: w.bbox.x / scale,
              y: w.bbox.y / scale,
              width: w.bbox.width / scale,
              height: w.bbox.height / scale,
            },
          }
        : w,
    )
  }
  if (process.platform !== 'win32') return words
  const id = getSelectedWindowId()
  if (!id) return words
  const hwnd = BigInt(id)

  const { getCaptureOriginOffset, getWindowScreenRect } = await import('./win32Capture')
  const rect = getWindowScreenRect(hwnd)
  if (!rect) return words

  const offset = getCaptureOriginOffset(hwnd)
  const scale = getPhysicalToDipScale(rect)
  if (offset.x === 0 && offset.y === 0 && scale === 1) return words

  return words.map((word) =>
    word.bbox
      ? {
          ...word,
          bbox: {
            x: (word.bbox.x - offset.x) / scale,
            y: (word.bbox.y - offset.y) / scale,
            width: word.bbox.width / scale,
            height: word.bbox.height / scale,
          },
        }
      : word,
  )
}

/** 사각형 하나만 오버레이 좌표로 정렬할 때 쓰는 얇은 래퍼 — alignWordsToOverlay 를
 *  텍스트 없는 가짜 Word 배열 하나로 감싸 재사용한다. ipc.ts(수동 영역 제출 직후)와
 *  shortcut.ts(캐시된 수동 영역으로 선택 모드 재진입)가 영역 밖 반투명 회색 표시용
 *  좌표 변환에 쓴다(2026-07-31, 사용자 요청). */
export async function alignRectToOverlay(rect: Rect): Promise<Rect | undefined> {
  const [aligned] = await alignWordsToOverlay([{ text: '', bbox: rect }])
  return aligned?.bbox
}

/**
 * 선택 모드 진입 시 호출 — 백그라운드로 캡처+추출을 시작해 캐시를 채운다(기본적으로
 * 대기 안 하고 호출부는 반환값을 무시해도 됨). 완료(성공/실패 무관) 시점을 알아야 하는
 * 호출부(changeWatcher.ts — 겹쳐서 또 시작하지 않게 잠금 해제 타이밍을 잡는 데 씀)를
 * 위해 Promise 를 반환한다.
 */
export function refreshExtractionCache(): Promise<void> {
  const promise = runExtraction()
  inFlight = promise
  return promise
    .then((result) => {
      if (inFlight === promise) {
        previousExtraction = cached // 새 결과로 덮어쓰기 전에 직전 회차로 한 칸 밀어둔다
        cached = result
        inFlight = null
        sendOverlayWords(result.words) // 오버레이가 실제 단어 bbox 로 hover/클릭 판정하게 통지
        sendDetectedBlocks(result.detectedBlocks) // 노란 탐지 영역 플래시도 커밋 가드 안에서만(CachedExtraction.detectedBlocks 주석)
      }
    })
    .catch((err) => {
      console.error('[extractionCache] refresh failed:', err)
      if (inFlight === promise) {
        inFlight = null
        sendOverlayWords([]) // 실패해도 "생성 중" 표시가 안 멈추지 않게 빈 결과로 통지
        sendDetectedBlocks([]) // 실패한 회차의 옛 탐지 영역 표시가 화면에 남아있지 않게
      }
    })
}

/**
 * 캡처+OCR 을 거치지 않고 이미 완성된 추출 결과를 캐시에 넣는다 — macOS 미리보기의
 * 접근성(AX) 직접 추출(pdfAxSource.ts) 처럼 텍스트와 좌표를 자기가 다 만들어오는 경로용.
 * runExtraction 이 하던 뒷정리(회차 히스토리 밀기, 오버레이 통지)를 동일하게 수행해서,
 * 이후 클릭/팝업 흐름이 OCR 경로와 완전히 같아지게 한다.
 *
 * bbox 는 이미 오버레이 기준(창 좌상단 DIP)으로 들어온다 — alignWordsToOverlay 를 태우지
 * 않는다. OCR 은 캡처 이미지(물리 픽셀) 기준이라 배율 보정이 필요하지만, AX 는 처음부터
 * 포인트 단위 화면 좌표를 주기 때문에 보정하면 오히려 어긋난다.
 */
export function commitDirectExtraction(result: CachedExtraction): void {
  inFlight = null // 진행 중이던 OCR 이 있으면 커밋 가드에 걸려 스스로 폐기된다
  previousExtraction = cached
  cached = result
  sendOverlayWords(result.words)
  sendDetectedBlocks([])
  sendRegionInfo(null) // direct 추출은 OCR 영역 개념이 없다 — 이전 OCR 영역의 회색 표시가 남지 않게
}

/**
 * 클릭 시 호출 — 준비된 캐시가 있으면 즉시, 진행 중인 refresh 가 있으면 그걸 기다려서,
 * 둘 다 없으면(정상적으론 안 일어나야 함 — 방어용) 그 자리에서 새로 추출해서 반환한다.
 */
export async function getExtraction(): Promise<CachedExtraction> {
  if (inFlight) return inFlight
  if (cached) return cached
  refreshExtractionCache()
  return inFlight!
}

/** 창 재선택/선택 해제 시 호출 — 이전 창의 캐시가 다음 선택 모드 진입까지 남아있지 않게.
 *  리사이즈·영역 재선택(shortcut.ts) 등 "같은 창 안에서"도 호출되는 함수라, 회차
 *  히스토리(previousExtraction)는 건드리지 않는다 — 그건 clearExtractionHistory() 가
 *  실제 창 전환/해제 지점(ipc.ts, tray.ts)에서만 별도로 비운다. */
export function invalidateExtractionCache(): void {
  cached = null
  inFlight = null
  sendOverlayWords([]) // 이전 창의 단어 박스가 오버레이에 남아있지 않게
  sendDetectedBlocks([]) // 이전 창의 노란 탐지 영역 표시도 같이
  sendRegionInfo(null) // 이전 영역의 회색 표시도 같이
}

/** 직전 회차 추출 결과 조회 — 다음 추출의 문맥 재사용 등에 쓴다. 없으면(첫 회차 등) null. */
export function getPreviousExtraction(): CachedExtraction | null {
  return previousExtraction
}

/** 담당 A — 현재 캐시를 부작용 없이 들여다본다(2026-07-30). getExtraction() 과 달리
 *  cached/inFlight 가 둘 다 없어도 새 추출을 트리거하지 않는다 — changeWatcher.ts 가
 *  "재추출 없이 캐시 복원만" 하려는 지점에서 getExtraction() 을 썼다가, 아직 캐시가
 *  없는 타이밍에 걸리면 changeWatcher 의 regionRefreshInFlight 잠금과 무관하게 별도
 *  추출이 하나 더 시작돼 워커 풀에 요청이 겹치는(실측: 정상 대비 몇 배 느려짐) 문제가
 *  있었다. */
export function peekCachedExtraction(): CachedExtraction | null {
  return cached
}

/** 담당 A — 진행 중인 추출을 "폐기" 처리한다(2026-07-30, 사용자 제보 — 드래그 하이라이트가
 *  덮인 화면으로 시작된 추출이, 드래그 취소로 화면이 원상복구된 뒤에도 계속 돌아서 (a)
 *  그 사이 클릭하면 getExtraction() 이 이 진행 중 Promise 를 반환해 팝업이 최대 1분씩
 *  대기했고 (b) 완료되면 오염된(하이라이트가 텍스트를 가린) 결과가 멀쩡한 캐시와
 *  오버레이를 덮어썼다). 이미 시작된 비동기 작업 자체는 끊을 수 없지만, inFlight 참조만
 *  비우면 refreshExtractionCache 의 커밋 가드(`if (inFlight === promise)`)가 결과를
 *  버린다 — "더 새 호출로 덮어써서 이전 결과를 무시"하는 기존 메커니즘과 동일한 원리로,
 *  새 추출 없이 폐기만 하는 버전. 기존 cached 는 그대로 남아 클릭이 즉시 처리된다. */
export function abandonInFlightExtraction(): void {
  inFlight = null
}

/**
 * 클릭 지점이 속한 줄(anchorLine)을 기준으로 현재 추출 텍스트에 직전 회차 캐시의 문맥을
 * 병합한다(요청, 2026-07-29 — 클릭 시 설정된 범위(팝업 표시 줄 수 / LLM 문맥 바이트) 안에
 * 이전 회차에서 봤던 내용이 있다면 포함). 팝업 표시(buildDisplayText)와 LLM 문맥
 * (buildContextBlock) 모두 결국 ExtractedSelection.text/anchor 에서 앞뒤로 잘라 쓰므로,
 * 이 함수 하나로 병합해두면 둘 다 자동으로 혜택을 본다.
 *
 * anchorLine 이 직전 회차 텍스트에 정확히 한 번만 나타날 때만 그 지점을 정렬 기준으로
 * 삼는다 — 못 찾거나(내용이 완전히 바뀜) 두 번 이상 나오면(어느 쪽인지 모호함) 오정렬로
 * 문맥이 뒤섞이는 것보다 "이전 문맥 없음"이 안전하므로 병합을 포기하고 원본을 그대로
 * 돌려준다. 찾으면 앞/뒤 각각 이전 회차 쪽이 더 길 때만(스크롤 등으로 지금은 안 보이지만
 * 이전엔 보였던 부분이 있을 때만) 그쪽 텍스트로 교체한다 — 현재가 더 길면 그대로 둔다.
 *
 * 담당 A(2026-07-31) — 위 "정확히 한 번만 나타남" 정렬은 스크롤처럼 두 캡처 사이에
 * 실제로 겹치는 내용이 있을 때만 통한다. 겹치는 내용이 아예 없는 "완전히 다음 페이지로
 * 넘어감"은 못 찾는 게 정상인데, 그 경우에도 클릭 지점이 지금 텍스트 맨 앞부분이면
 * 직전 회차 전체를 정렬 없이 그대로 앞에 붙인다(PAGE_TURN_NEAR_START_THRESHOLD, 사용자
 * 결정 — 겹치는 부분이 없어도 무조건 이어붙임).
 */
// 담당 A — 상한 추가(2026-07-31, 사용자 제보 — "재추출 시 이전 문맥 병합이 잘 안 되는
// 것 같다"). 이 상수 미만이면 기존처럼 '\n' 경계로 확장한 줄을 정렬 기준으로 쓴다(영어
// 처럼 anchor가 단어 하나뿐인 소스는 그 단어가 이전 텍스트에 여러 번 나타날 수 있어
// 정렬 기준으로 못 쓰므로 이 확장이 필요) — 아래 함수 본문 주석 참고.
const MAX_ANCHOR_LINE_LENGTH = 300

// 담당 milleion — 하한 추가(2026-07-31, 실사용 제보 — "클릭하면 이상한 위치 텍스트가
// 뜬다"). 위 상한(useRawAnchor)이 발동하면 정렬 기준이 findLineSpan 이 준 anchor 그대로가
// 되는데, **lineId 가 없는 직접 추출 경로(mac AX PDF 등)는 그 anchor 가 클릭한 단어
// 하나뿐이다**(selection/index.ts: findLineSpan 폴백). "comfortable" 같은 단어 하나는
// 직전 회차 텍스트에 우연히 딱 한 번만 나오면 유일성 검사를 통과해버리고, 그 지점이
// 클릭 위치와 무관해도 병합이 실행돼 스크롤 전 화면의 텍스트가 현재 문맥을 통째로
// 덮어썼다. 정렬 기준으로 삼기엔 너무 짧은 anchor 면 병합을 포기한다 — 오정렬로 문맥이
// 뒤섞이는 것보다 "이전 문맥 없음"이 안전하다(위 함수 주석의 원칙과 동일).
const MIN_ANCHOR_LENGTH_FOR_MERGE = 20

// 담당 A — 페이지 전환 폴백 추가(2026-07-31, 사용자 제보 — "다음 페이지 첫 부분을
// 클릭했는데 이전 페이지 내용을 모른다"). 위 두 상수는 전부 "지금 텍스트와 직전 회차
// 텍스트가 실제로 겹치는 부분이 있다"(스크롤 등)는 걸 전제로 그 겹치는 지점을 문자
// 그대로 찾는(prev.text.indexOf) 방식이다 — 책/문서의 "다음 페이지로 넘어감"은 겹치는
// 내용이 아예 없는 게 정상이라(이전 페이지 끝과 새 페이지 시작이 이어지는 문장이 아닌 한)
// 이 방식으로는 원리적으로 못 찾는다. 정렬 기준을 못 찾았을 때, 클릭 지점이 지금 텍스트의
// 맨 앞부분(=페이지를 열자마자 보이는 부분)이면 "직전 페이지에서 이어지는 중"으로 보고
// 정렬 없이 직전 회차 텍스트 전체를 그대로 앞에 이어붙인다(사용자 결정 — 겹치는 내용이
// 전혀 없어도 무조건 붙임). 뒤로 얼마나 보여줄지는 항상 그렇듯 팝업 표시(줄 수)/LLM
// 문맥(바이트) 쪽이 anchor 기준으로 알아서 자른다 — 여기선 자르지 않고 전체를 붙여도 된다.
const PAGE_TURN_NEAR_START_THRESHOLD = 100

// 담당 A — 페이지 전환 이어붙이기 구분자(2026-07-31, 사용자 요청 — "앞에 이어붙일 때
// 언어 특성을 고려해서 띄어쓰기 한 칸 추가"). 공백으로 단어를 구분하는 언어(영어 등)는
// 이전 페이지 끝과 새 페이지 시작 사이에 공백이 없으면 두 단어가 그대로 붙어버린다 —
// ocr.ts 가 "띄어쓰기 없는 문자 체계"로 보고 단어 사이를 공백 없이 이어붙이는 언어와
// 정확히 같은 기준(ja/zh-Hans/zh-Hant/th/lo)으로, 이 언어들만 구분자를 안 넣는다.
const SPACELESS_LANGUAGES: ReadonlySet<AnyLanguage> = new Set(['ja', 'zh-Hans', 'zh-Hant', 'th', 'lo'])

export function mergeWithPreviousContext(
  text: string,
  anchorStart: number,
  anchorEnd: number,
): { text: string; anchorStart: number; anchorEnd: number } {
  const prev = previousExtraction
  if (!prev) return { text, anchorStart, anchorEnd }

  const lineStart = text.lastIndexOf('\n', anchorStart - 1) + 1
  const nextBreak = text.indexOf('\n', anchorEnd)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  // 담당 A — 문단 단위로만 '\n'이 들어가는 CJK 경로(alignColumnStarts/detectRowParagraphStarts,
  // 2026-07-30~31 도입) 이후로, 이 '\n' 경계 확장이 이제 "한 줄"이 아니라 "문단 전체"
  // (수백 자)를 가리킬 수 있게 됐다 — 그렇게 긴 문자열은 직전 회차 텍스트와 한 글자만
  // 달라져도(재추출마다 OCR 결과가 살짝 다를 수 있음, 흔함) 정확 일치 검색이 실패해서
  // 병합이 거의 항상 조용히 비활성화된다(실사용 제보로 발견). 확장 결과가 비정상적으로
  // 크면 문단 단위로 걸린 것으로 보고, 대신 원래 넘겨받은 anchor(클릭된 줄, findLineSpan
  // 이 이미 lineId 기준으로 정확한 단위를 계산해둔 값) 그대로를 정렬 기준으로 쓴다.
  const useRawAnchor = lineEnd - lineStart > MAX_ANCHOR_LINE_LENGTH
  const effStart = useRawAnchor ? anchorStart : lineStart
  const effEnd = useRawAnchor ? anchorEnd : lineEnd
  const anchorLine = text.slice(effStart, effEnd)
  if (!anchorLine.trim() || anchorLine.length < MIN_ANCHOR_LENGTH_FOR_MERGE) {
    return { text, anchorStart, anchorEnd }
  }

  const prevIdx = prev.text.indexOf(anchorLine)
  if (prevIdx === -1 || prev.text.indexOf(anchorLine, prevIdx + 1) !== -1) {
    // 겹치는 지점을 못 찾았다 — 완전히 새 페이지로 넘어갔을 가능성. 클릭 지점이 지금
    // 텍스트 맨 앞부분이면 정렬 없이 직전 회차 전체를 그대로 앞에 붙인다(위
    // PAGE_TURN_NEAR_START_THRESHOLD 주석 참고).
    if (lineStart <= PAGE_TURN_NEAR_START_THRESHOLD) {
      const separator = SPACELESS_LANGUAGES.has(prev.language) ? '' : ' '
      return {
        text: prev.text + separator + text,
        anchorStart: prev.text.length + separator.length + anchorStart,
        anchorEnd: prev.text.length + separator.length + anchorEnd,
      }
    }
    return { text, anchorStart, anchorEnd }
  }

  const before = text.slice(0, effStart)
  const after = text.slice(effEnd)
  const prevBefore = prev.text.slice(0, prevIdx)
  const prevAfter = prev.text.slice(prevIdx + anchorLine.length)

  const mergedBefore = prevBefore.length > before.length ? prevBefore : before
  const mergedAfter = prevAfter.length > after.length ? prevAfter : after
  if (mergedBefore === before && mergedAfter === after) return { text, anchorStart, anchorEnd }

  return {
    text: mergedBefore + anchorLine + mergedAfter,
    anchorStart: mergedBefore.length + (anchorStart - effStart),
    anchorEnd: mergedBefore.length + (anchorEnd - effStart),
  }
}

/** 선택된 창을 전환하거나 선택 해제할 때 호출 — 회차 히스토리를 완전히 비운다
 *  (ipc.ts: SELECT_WINDOW, tray.ts: deselectWindow). invalidateExtractionCache 와 달리
 *  "실제 창이 바뀌는" 지점에서만 불러야 한다 — 리사이즈/영역 재선택처럼 같은 창 안에서
 *  일어나는 재추출까지 여기에 끼워 넣으면 직전 회차 문맥이 매번 날아가 버린다. */
export function clearExtractionHistory(): void {
  previousExtraction = null
}
