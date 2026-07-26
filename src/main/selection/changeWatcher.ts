import { nativeImage } from 'electron'
import { sendExtractionStarted, sendOverlayWords } from '../windows'
import { captureFocusedWindow } from './capture'
import { refreshExtractionCache } from './extractionCache'
import { getRegion } from './regionSelection'

// 담당 A — 선택 모드에서 OCR 대상 영역의 화면 내용 변화를 감지해 조용히 재추출한다.
// 창 크기 변경은 shortcut.ts(onWindowResized)가 별도로 처리하므로 여기서는 다루지
// 않는다 — 이 워처는 "크기는 그대로인데 영역 안 내용만 바뀐" 경우(스크롤, 텍스트
// 갱신 등)만 대상으로 한다.

const POLL_INTERVAL_MS = 500
const SETTLE_DELAY_MS = 800
// 픽셀 바이트 중 이 비율 이상이 달라야 "변화"로 본다 — 커서 깜빡임, 안티에일리어싱
// 등 미세한 렌더링 노이즈로 매 폴링마다 재추출이 걸리지 않도록 하는 임계값.
const DIFF_RATIO_THRESHOLD = 0.02

let running = false
let pollTimer: NodeJS.Timeout | null = null
let settleTimer: NodeJS.Timeout | null = null
let lastBitmap: Buffer | null = null

function bitmapsDiffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return true
  let sampled = 0
  let diff = 0
  // RGBA 4바이트당 1채널(R)만 비교 — 픽셀 전체를 다 볼 필요 없이 변화 여부만 판단.
  for (let i = 0; i < a.length; i += 4) {
    sampled++
    if (a[i] !== b[i]) diff++
  }
  return sampled > 0 && diff / sampled > DIFF_RATIO_THRESHOLD
}

async function captureRegionBitmap(): Promise<Buffer | null> {
  const region = getRegion()
  if (!region) return null
  try {
    const png = await captureFocusedWindow()
    const image = nativeImage.createFromBuffer(png)
    const size = image.getSize()
    const x = Math.max(0, Math.round(region.x))
    const y = Math.max(0, Math.round(region.y))
    const width = Math.min(Math.round(region.width), size.width - x)
    const height = Math.min(Math.round(region.height), size.height - y)
    if (width <= 0 || height <= 0) return null
    return image.crop({ x, y, width, height }).toBitmap()
  } catch (err) {
    console.error('[changeWatcher] region capture failed:', err)
    return null
  }
}

async function poll(): Promise<void> {
  if (!running) return
  const bitmap = await captureRegionBitmap()
  if (bitmap) {
    if (lastBitmap && bitmapsDiffer(lastBitmap, bitmap)) {
      // 변화가 인식된 순간부터 새 OCR 결과가 올 때까지 기존 단어 박스는 더 이상 화면
      // 내용과 안 맞으므로 바로 지운다(재추출이 끝나면 refreshExtractionCache 가
      // sendOverlayWords 로 새 박스를 채워 넣는다). 스크롤처럼 계속 바뀌는 동안엔 매
      // 폴링마다 다시 호출되지만 이미 빈 상태라 실질적으로는 무해하다.
      sendOverlayWords([])
      // 계속 바뀌는 동안(스크롤 등)은 대기 타이머를 매번 리셋해서, 변화가 완전히
      // 멈춘 뒤에만 재추출하도록 한다.
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        // refreshExtractionCache 는 자체적으로 inFlight promise 를 최신 호출로 덮어써서,
        // 이 시점에 이전 추출이 진행 중이었더라도 그 결과는 캐시에 반영되지 않고
        // 이번 호출 결과만 반영된다("진행 중인 추출을 취소하고 새로 시작"과 동일한 효과).
        sendExtractionStarted() // 오버레이에 "텍스트 추출 중…" 표시(초기 진입 때와 동일한 배너)
        refreshExtractionCache()
      }, SETTLE_DELAY_MS)
    }
    lastBitmap = bitmap
  }
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
}

/** 영역이 확정된 선택 모드에 진입/유지될 때 호출 — 이미 실행 중이면 아무 것도 안 한다. */
export function startChangeWatcher(): void {
  if (running) return
  running = true
  lastBitmap = null
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
}

/** 선택 모드를 나가거나, 영역이 무효화되거나(리사이즈), 창을 재선택할 때 호출. */
export function stopChangeWatcher(): void {
  running = false
  if (pollTimer) clearTimeout(pollTimer)
  if (settleTimer) clearTimeout(settleTimer)
  pollTimer = null
  settleTimer = null
  lastBitmap = null
}
