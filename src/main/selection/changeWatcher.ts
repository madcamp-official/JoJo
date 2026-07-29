import { nativeImage } from 'electron'
import { sendExtractionStarted, sendOverlayWords } from '../windows'
import { getSettings } from '../settingsStore'
import { captureFocusedWindow } from './capture'
import { refreshExtractionCache } from './extractionCache'
import { autoDetectRegion, getRegion, setRegion } from './regionSelection'

// 담당 A — 선택 모드에서 OCR 대상 영역의 화면 내용 변화를 감지해 조용히 재추출한다.
// 창 크기 변경은 shortcut.ts(onWindowResized)가 별도로 처리하므로 여기서는 다루지
// 않는다 — 이 워처는 "크기는 그대로인데 영역 안 내용만 바뀐" 경우(스크롤, 텍스트
// 갱신 등)만 대상으로 한다.

const POLL_INTERVAL_MS = 500
const SETTLE_DELAY_MS = 800
// 픽셀 바이트 중 이 비율 이상이 달라야 "변화"로 본다 — 커서 깜빡임, 안티에일리어싱
// 등 미세한 렌더링 노이즈로 매 폴링마다 재추출이 걸리지 않도록 하는 임계값.
const DIFF_RATIO_THRESHOLD = 0.02

// 실측 확인(사용자 보고): 브라우저 같은 화면은 hover 로 생기는 밑줄/툴팁 등 작은
// 시각 변화가 잦아서, 픽셀 diff 만으로 재추출을 걸면 스크롤/클릭/키 입력과 무관한
// 변화에도 너무 민감하게 반응했다. inputHook.ts(win32 저수준 후크)/macInput.ts(mac
// CGEventSourceSecondsSinceLastEventType 폴링)가 알려주는 "마지막 스크롤/클릭/키보드
// 입력 시각"이 이 시간(ms) 이내여야만 diff 를 진짜 변화로 인정한다 — 폴링 주기(500ms)+
// 처리 지연을 감안한 여유치.
const INPUT_FRESHNESS_MS = 1500

/**
 * 마지막으로 "진짜 사용자 입력"(스크롤/클릭/키보드)이 있었던 시각을 얻는다. win32 는
 * 저수준 후크(inputHook.ts), mac 은 권한이 필요 없는 `CGEventSourceSecondsSinceLastEventType`
 * 폴링(macInput.ts, 2026-07-29 추가 — win32/mac 격차 감사로 발견된 gap 을 메움)으로
 * 각각 구현한다. 그 외 플랫폼(미지원)에서는 이 게이트 자체를 항상 통과시킨다(현재 시각을
 * 반환) — 새 필터링 기능이 없을 뿐 기존 동작(픽셀 diff 만으로 판단)은 그대로 유지된다.
 */
async function getLastInputTime(): Promise<number> {
  if (process.platform === 'win32') {
    const { getLastQualifyingInputTime } = await import('./inputHook')
    return getLastQualifyingInputTime()
  }
  if (process.platform === 'darwin') {
    const { getMacLastQualifyingInputTime } = await import('./macInput')
    return getMacLastQualifyingInputTime()
  }
  return Date.now()
}

let running = false
let pollTimer: NodeJS.Timeout | null = null
let settleTimer: NodeJS.Timeout | null = null
let lastBitmap: Buffer | null = null
// autoDetectRegion(DocLayout 재실행, 몇 초 걸림) + refreshExtractionCache 가 진행 중인
// 동안 새 settle 사이클이 또 시작되지 않게 막는 잠금 — 실사용 중 확인: 페이지 넘김
// 애니메이션처럼 짧은 시간에 "내용 변화"가 여러 번 감지되면(각 감지마다 대기 타이머가
// 리셋되긴 하지만, 타이머가 "발화"된 뒤 그 비동기 체인이 끝나기 전에 다음 감지가 또
// 발화될 수 있음) autoDetectRegion + refreshExtractionCache 호출이 여러 번 겹쳐서 동시
// 실행됐다. refreshExtractionCache 자체는 inFlight promise 를 최신 호출로 덮어써서
// "결과"는 최신 것만 반영되지만, 그 전 단계인 PaddleOCR/Yomitoku 워커 풀에는 여러
// 요청이 동시에 몰려 각 요청이 정상보다 몇 배 느려지고(실측: 열 하나에 40~60초, 정상
// 15~20초) 결과 순서도 뒤섞였다. 겹치지 않게 한 사이클씩만 처리한다.
let regionRefreshInFlight = false

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
  // stopChangeWatcher() 가 위 await 도중(캡처 중) 호출됐을 수 있다 — 이 경우 아래에서
  // 진단/재추출을 진행하지도, 맨 끝에서 다음 폴링을 재예약하지도 않아야 한다. 이 체크가
  // 없으면 "멈췄다고 생각한" 워처가 진행 중이던 이번 사이클 하나 때문에 스스로 다시
  // 타이머를 걸어 계속 살아있는 버그가 있었다(실사용 중 확인 — 자막 모드로 전환된 뒤에도
  // OCR 이 끝없이 재실행됨).
  if (!running) return
  if (bitmap) {
    if (lastBitmap && bitmapsDiffer(lastBitmap, bitmap)) {
      const lastInput = await getLastInputTime()
      // 스크롤/클릭/키보드 입력이 최근에 없었으면(hover 로 생긴 밑줄/툴팁, 배너 애니
      // 메이션 등) 픽셀은 달라졌어도 재추출을 걸지 않는다 — lastBitmap 은 아래에서
      // 어차피 갱신되므로 다음 폴링부터는 이 상태를 기준으로 다시 비교한다.
      if (Date.now() - lastInput > INPUT_FRESHNESS_MS) {
        lastBitmap = bitmap
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }
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
        if (regionRefreshInFlight) {
          // 이전 사이클이 아직 진행 중 — 겹쳐서 시작하지 않는다. 내용이 계속 바뀌는
          // 중이면(페이지 전환 애니메이션 등) 다음 폴링에서 다시 변화가 감지돼 새
          // 사이클이 걸리므로, 이번 트리거를 하나 건너뛰어도 결국 최신 내용으로 수렴한다.
          return
        }
        regionRefreshInFlight = true
        if (getSettings().autoDetectRegion) {
          // 내용이 바뀌었으니(스크롤, 페이지 넘김 등) 영역을 처음 모드 진입할 때처럼
          // 다시 감지한다(autoDetectRegion, DocLayout 재실행) — 예전엔 캐시만 비우고
          // region(위치/크기) 자체는 그대로 뒀는데, 페이지 넘김처럼 내용뿐 아니라 본문이
          // 차지하는 영역 자체가 페이지마다 달라지는 경우(실사용 중 확인: 1페이지엔
          // 비어있던 자리에 2페이지엔 본문이 생김) 옛 영역 밖으로 벗어난 본문은 크롭에
          // 아예 안 들어가 인식이 안 됐다. autoDetectRegion 이 내부적으로 새 블록/줄
          // 검출 결과를 캐시에 채워주므로 별도로 캐시를 비울 필요는 없다 — 실패하면
          // (Python 환경 없음 등) 기존 region 을 그대로 유지한다(완전히 못 쓰게 되는
          // 것보다 예전 영역으로라도 계속 동작하는 쪽이 안전).
          void autoDetectRegion()
            .then((detected) => {
              if (detected) {
                setRegion(detected, 'auto')
                // 영역 크기가 바뀌었을 수 있어 이전 비트맵과 비교하면 크기 불일치로 항상
                // "달라짐"이 떠서 이 갱신 직후 또 한 번 불필요한 재추출 사이클이 돈다 —
                // 다음 폴링에서 새 영역 기준으로 조용히 새로 잡게 비워둔다.
                lastBitmap = null
              }
              // refreshExtractionCache 는 자체적으로 inFlight promise 를 최신 호출로
              // 덮어써서, 이 시점에 이전 추출이 진행 중이었더라도 그 결과는 캐시에
              // 반영되지 않고 이번 호출 결과만 반영된다("진행 중인 추출을 취소하고 새로
              // 시작"과 동일한 효과). 이 사이클(autoDetectRegion+refreshExtractionCache)
              // 이 끝날 때까지 잠금을 들고 있다가 완료되면(성공/실패 무관, finally) 풀어서
              // 다음 settle 사이클이 겹치지 않게 한다.
              sendExtractionStarted() // 오버레이에 "텍스트 추출 중…" 표시(초기 진입 때와 동일한 배너)
              return refreshExtractionCache()
            })
            .catch((err) => {
              console.error('[changeWatcher] 영역 재감지/재추출 실패:', err)
            })
            .finally(() => {
              regionRefreshInFlight = false
            })
        } else {
          // 자동 탐지가 꺼져 있으면(사용자 요청, 2026-07-29) 영역 자체는 처음 지정한
          // 그대로 두고, 그 안의 내용만 다시 인식한다 — 사용자가 직접 고른 영역을
          // 화면 변화 때마다 임의로 다시 잡으면 안 된다는 명시적 요구.
          sendExtractionStarted()
          void refreshExtractionCache()
            .catch((err) => {
              console.error('[changeWatcher] 재추출 실패:', err)
            })
            .finally(() => {
              regionRefreshInFlight = false
            })
        }
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
  // 진행 중이던 autoDetectRegion/refreshExtractionCache 사이클의 완료를 기다리지 않고
  // 그냥 잠금을 푼다 — 이미 시작된 비동기 작업 자체를 취소할 방법은 없지만(Promise 는
  // 중간에 못 끊음), 모드를 나갔다 다시 들어왔을 때 이 잠금이 계속 걸려 있어 새
  // 워처가 영영 재감지를 못 하는 상황은 막아야 한다.
  regionRefreshInFlight = false
}
