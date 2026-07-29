import type { AnyLanguage, Rect, SelectionSource, Word } from '@shared/types'
import { getPhysicalToDipScale, sendDebugBlocks, sendExtractionOcrStarted, sendOverlayWords } from '../windows'
import { getSettings } from '../settingsStore'
import { captureFocusedWindow, getSelectedWindowId } from './capture'
import { detectLanguage } from './langDetect'
import { getLastExtractionBlocks, runOcr } from './ocr'
import { getRegion, getRegionSource } from './regionSelection'

// 담당 A — 선택 창 추출 결과 캐시 (PLAN.md §5.1 / §8)
// 클릭할 때마다 캡처+OCR을 새로 돌리면 매번 1~3초씩 걸린다 — 대신 선택 모드
// 진입 시(shortcut.ts: toggleMode) 미리 한 번 돌려서 캐시해두고, 클릭 시엔 이미
// 준비된 결과를 즉시 쓴다. 선택 모드를 나갔다 다시 들어올 때마다 항상 새로
// 캡처+OCR 한다(재진입 = 최신화) — 그 사이 스크롤 등으로 내용이 바뀌었을 수 있어서.
//
// decideOcr.ts/extractDirect.ts 의 접근성(direct) 추출은 구현은 돼 있지만 여기서는
// 안 쓴다 — "클릭한 단어 기준 앞뒤 범위만 팝업에 표시"하려면 클릭 지점이 어떤 단어인지
// 알아야 하고, 그러려면 화면 좌표(bbox)가 필수인데 direct 추출은 좌표를 못 만든다
// (문자열만 얻음). 좌표 때문에 결국 항상 OCR을 돌려야 해서, 지금 파이프라인에서는
// direct 판정 자체가 의미가 없어졌다 — 항상 OCR만 쓴다.

export interface CachedExtraction {
  text: string
  words: Word[]
  language: AnyLanguage
  source: SelectionSource
  extraction: 'direct' | 'ocr'
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
  // submitRegionFromOverlay 가 변환) 추가 변환 없이 그대로 runOcr 에 넘길 수 있다.
  const region = getRegion() ?? undefined
  // 본문 영역이 정해진 뒤에 그 영역만으로 언어를 감지한다(langDetect.ts) — 영역 밖의
  // 메뉴바 등 다른 언어 UI 텍스트에 안 흔들리도록, 캡처 → 영역 확정 → 언어 감지 →
  // OCR 순서로 실행한다.
  const language = await timed('language detect', () => detectLanguage(image, region))
  // 언어 감지까지 끝났으니 추출 중 배너를 "텍스트 추출" 단계로 넘긴다(사용자 요청,
  // 2026-07-29 — 그 전까지는 "언어 감지 & 텍스트 영역 탐지" 단계로 표시됨).
  sendExtractionOcrStarted()
  const extracted = await timed(`ocr(${language})`, () => runOcr(image, language, region))
  console.log(`[timing] total: ${Date.now() - overallStart}ms`)

  // OCR이 실제로 인식에 넘긴 블록/열 경계를 오버레이에 반투명 사각형으로 보여준다 —
  // 원래 개발 전용 디버그였으나, 텍스트 영역 자동 탐지 설정(autoDetectRegion, 사용자
  // 요청 2026-07-29)의 결과 시각화로 실사용 기능이 됐다. 자동 탐지로 잡힌 영역일 때만
  // 보여준다(설정이 꺼져 있거나 사용자가 "영역 수동 선택"으로 직접 지정했으면 안 보여줌
  // — regionSelection.ts: getRegionSource). 개발 모드에서는 이 조건과 무관하게 항상
  // 보내(디버깅 편의), words 와 같은 좌표 보정(물리 픽셀 → 오버레이 DIP)이 필요해서
  // alignWordsToOverlay 를 그대로 재사용한다(Rect 를 텍스트 없는 가짜 Word 로 감싸서
  // 넘기고 bbox 만 다시 뺌).
  if (import.meta.env.DEV || (getSettings().autoDetectRegion && getRegionSource() === 'auto')) {
    const blocks = getLastExtractionBlocks()
    const aligned = await alignWordsToOverlay(blocks.map((bbox) => ({ text: '', bbox })))
    sendDebugBlocks(aligned.map((w) => w.bbox).filter((b): b is Rect => b !== undefined))
  }

  return {
    text: extracted.text,
    words: await alignWordsToOverlay(extracted.words),
    language: extracted.language,
    source: { kind: 'ocr' },
    extraction: 'ocr',
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
      }
    })
    .catch((err) => {
      console.error('[extractionCache] refresh failed:', err)
      if (inFlight === promise) {
        inFlight = null
        sendOverlayWords([]) // 실패해도 "생성 중" 표시가 안 멈추지 않게 빈 결과로 통지
      }
    })
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
}

/** 직전 회차 추출 결과 조회 — 다음 추출의 문맥 재사용 등에 쓴다. 없으면(첫 회차 등) null. */
export function getPreviousExtraction(): CachedExtraction | null {
  return previousExtraction
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
 */
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
  const anchorLine = text.slice(lineStart, lineEnd)
  if (!anchorLine.trim()) return { text, anchorStart, anchorEnd }

  const prevIdx = prev.text.indexOf(anchorLine)
  if (prevIdx === -1 || prev.text.indexOf(anchorLine, prevIdx + 1) !== -1) {
    return { text, anchorStart, anchorEnd }
  }

  const before = text.slice(0, lineStart)
  const after = text.slice(lineEnd)
  const prevBefore = prev.text.slice(0, prevIdx)
  const prevAfter = prev.text.slice(prevIdx + anchorLine.length)

  const mergedBefore = prevBefore.length > before.length ? prevBefore : before
  const mergedAfter = prevAfter.length > after.length ? prevAfter : after
  if (mergedBefore === before && mergedAfter === after) return { text, anchorStart, anchorEnd }

  return {
    text: mergedBefore + anchorLine + mergedAfter,
    anchorStart: mergedBefore.length + (anchorStart - lineStart),
    anchorEnd: mergedBefore.length + (anchorEnd - lineStart),
  }
}

/** 선택된 창을 전환하거나 선택 해제할 때 호출 — 회차 히스토리를 완전히 비운다
 *  (ipc.ts: SELECT_WINDOW, tray.ts: deselectWindow). invalidateExtractionCache 와 달리
 *  "실제 창이 바뀌는" 지점에서만 불러야 한다 — 리사이즈/영역 재선택처럼 같은 창 안에서
 *  일어나는 재추출까지 여기에 끼워 넣으면 직전 회차 문맥이 매번 날아가 버린다. */
export function clearExtractionHistory(): void {
  previousExtraction = null
}
