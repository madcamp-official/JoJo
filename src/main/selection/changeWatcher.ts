import { nativeImage } from 'electron'
import { sendDebugBlocks, sendExtractionStarted, sendOverlayWords } from '../windows'
import { getSettings } from '../settingsStore'
import { captureFocusedWindow } from './capture'
import { abandonInFlightExtraction, peekCachedExtraction, refreshExtractionCache } from './extractionCache'
import { autoDetectRegion, getRegion, getRegionSource, setRegion } from './regionSelection'
import type { Rect } from '@shared/types'

// 담당 A — 선택 모드에서 OCR 대상 영역의 화면 내용 변화를 감지해 조용히 재추출한다.
// 창 크기 변경은 shortcut.ts(onWindowResized)가 별도로 처리하므로 여기서는 다루지
// 않는다 — 이 워처는 "크기는 그대로인데 영역 안 내용만 바뀐" 경우(스크롤, 텍스트
// 갱신 등)만 대상으로 한다.

const POLL_INTERVAL_MS = 1000
const SETTLE_DELAY_MS = 1000
// 픽셀 바이트 중 이 비율 이상이 달라야 "변화"로 본다 — 커서 깜빡임, 안티에일리어싱
// 등 미세한 렌더링 노이즈로 매 폴링마다 재추출이 걸리지 않도록 하는 임계값.
const DIFF_RATIO_THRESHOLD = 0.02

// 실측 확인(사용자 보고): 브라우저 같은 화면은 hover 로 생기는 밑줄/툴팁 등 작은
// 시각 변화가 잦아서, 픽셀 diff 만으로 재추출을 걸면 스크롤/클릭/키 입력과 무관한
// 변화에도 너무 민감하게 반응했다. inputHook.ts(win32 저수준 후크)/macInput.ts(mac
// CGEventSourceSecondsSinceLastEventType 폴링)가 알려주는 "마지막 스크롤/클릭/키보드
// 입력 시각"이 이 시간(ms) 이내여야만 diff 를 진짜 변화로 인정한다 — 폴링 주기(1000ms)+
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

/**
 * 담당 A — 대상 창이 지금 실제로 포커스돼(전경) 있는지(2026-07-31, 사용자 제보 —
 * "모니터의 Kindle 에서 추출 완료 후 페이지를 넘기고, 노트북 화면(다른 창)을 클릭했더니
 * 재추출이 시작됨"). `captureFocusedWindow`(이름과 달리 처음 선택한 HWND를 고정 캡처)
 * 자체는 포커스와 무관하지만, 대상 창이 포커스를 잃으면 비활성 상태로 살짝 다르게
 * 렌더링되는 경우가 있다(선택 하이라이트 색 변화, 커서 깜빡임 정지, 툴바 자동 숨김 등)
 * — 그 정도 변화만으로도 DIFF_RATIO_THRESHOLD 를 넘을 수 있다. 게다가 "노트북 화면을
 * 클릭"하는 행위 자체가 저수준 입력 후크엔 시스템 전역 "최근 입력"으로 잡혀서, 그 diff가
 * 대상 창과 무관한 오탐이어도 INPUT_FRESHNESS_MS 게이트를 그냥 통과해버린다 — 대상 창이
 * 지금 전경인지까지 같이 확인해야 진짜 걸러진다. win32 만 지원(다른 플랫폼은 게이트 없이
 * 항상 통과 — 기존 동작 유지, mac 은 대응하는 API 확인 후 추가 필요).
 */
async function isTargetWindowForeground(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  const { getSelectedWindowId } = await import('./capture')
  const { isWindowForeground } = await import('./win32Capture')
  const id = getSelectedWindowId()
  if (!id) return true // 선택된 창을 모르면(이론상 도달 안 함) 게이트 없이 통과
  return isWindowForeground(BigInt(id))
}

/**
 * 담당 A — 왼쪽 마우스 버튼이 지금 눌려 있는지(드래그 진행 중, 2026-07-30). 드래그를
 * 잡고 있는 동안은 화면이 1초 이상 "안정"돼 보여도(선택 하이라이트가 정지 상태) 손을
 * 떼는 순간 다시 바뀔 가능성이 높다 — 실사용 확인: 드래그 중의 일시적 화면으로 추출이
 * 시작돼(언어 탐지 ~6초 + OCR 15~20초), 취소로 원상복구된 뒤 그 낭비된 추출이 끝나기를
 * 기다렸다가 또 한 번 전체 재추출이 돌았다. win32 는 inputHook(저수준 후크의
 * WM_LBUTTONDOWN/UP 추적), mac 은 macInput(CGEventSourceButtonState 질의, 권한 불필요).
 * 그 외 플랫폼은 게이트 없이 항상 false(기존 동작 유지).
 */
async function isPointerButtonDown(): Promise<boolean> {
  if (process.platform === 'win32') {
    const { isPrimaryButtonDown } = await import('./inputHook')
    return isPrimaryButtonDown()
  }
  if (process.platform === 'darwin') {
    const { isMacPrimaryButtonDown } = await import('./macInput')
    return isMacPrimaryButtonDown()
  }
  return false
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
// 담당 A — 추출 도중에도 화면이 또 바뀌면(2026-07-30, 사용자 제보 — 화면 전환 애니메이션
// 도중 캡처된 화면을 DocLayout 이 잘못 인식해 한 열이 둘로 쪼개짐) 그 사실을 기억해뒀다가,
// 지금 진행 중인 추출이 끝나는 즉시 새로 한 사이클을 돈다 — 안 그러면 그 변화가 딱 한
// 번만 있고 그 뒤로 화면이 잠잠해지면(전환이 끝나서 더 이상 diff 가 안 남) 아무도 재추출을
// 다시 트리거하지 않아, 전환 도중의 불완전한 화면으로 뽑은 결과가 그대로 굳어버린다.
let pendingRetrigger = false
// 담당 A — 진행 중인 추출 사이클이 "폐기"됐는지(2026-07-30). 드래그 취소로 화면이
// 마지막 추출 상태 그대로 복귀하면 onSettled 가 진행 중이던(오염된 화면 기준) 추출을
// abandonInFlightExtraction() 으로 폐기하는데, 그 사이클의 onCycleDone 이 평소처럼
// lastExtractedBitmap 을 자기 시작 시점 비트맵(오염된 화면)으로 갱신해버리면 "현재
// 캐시가 어떤 화면의 것인지"라는 이 변수의 의미가 깨진다 — 폐기된 사이클은 캐시에
// 아무것도 남기지 않았으므로 갱신도 재트리거도 하지 않고 조용히 끝나야 한다.
let cycleAbandoned = false
// 담당 A — 마지막으로 커밋된 추출 당시의 영역(2026-07-30). 자동 영역 감지가 켜져 있으면
// 재추출 사이클이 setRegion 을 추출 완료 전에 미리 실행하는데, 그 사이클이 나중에
// 폐기되면(복귀 판정) 오염된 화면 기준으로 좁게 잡힌 영역만 남는다 — 실사용 확인:
// 캐시 복원으로 단어 박스는 돌아왔는데 영역이 좁아진 채라 표시가 잘려 보임. 복귀
// 시점에 이 값으로 영역도 되돌린다.
let lastExtractedRegion: { rect: Rect; source: 'auto' | 'manual' } | null = null
// 담당 A — 마지막으로 "실제 추출"에 쓰인 비트맵(2026-07-30, 사용자 제보 — 영역 안에서
// 드래그하다 취소하는 등, 화면이 바뀌었다가 결국 원래 상태로 되돌아온 경우). lastBitmap
// 은 "직전 폴링 대비 안정됐는지"만 보여줘서, 드래그 시작으로 diff 가 잡히고 settle
// 대기 중 취소로 원상복구돼도 "결국 안정된 새 화면"으로만 취급해 불필요하게 재추출을
// 걸었다(OCR 이 정상적으로도 15~20초라 체감 지연이 컸다). onSettled 에서 최종 안정된
// 화면을 이것과 비교해, 마지막 추출 당시와 동일하면(순변화 없음) 재추출을 건너뛴다.
let lastExtractedBitmap: Buffer | null = null

// 담당 A — 진단용 임시 로깅(2026-07-30, "드래그 취소해도 재추출이 계속 도는" 원인 조사).
// 실제 diff 비율을 눈으로 봐야 임계값 때문에 "복귀 판정"이 실패하는 건지, 다른
// 원인인지 구분할 수 있다.
function diffRatio(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 1
  let sampled = 0
  let diff = 0
  // RGBA 4바이트당 1채널(R)만 비교 — 픽셀 전체를 다 볼 필요 없이 변화 여부만 판단.
  for (let i = 0; i < a.length; i += 4) {
    sampled++
    if (a[i] !== b[i]) diff++
  }
  return sampled > 0 ? diff / sampled : 0
}

function bitmapsDiffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return true
  return diffRatio(a, b) > DIFF_RATIO_THRESHOLD
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

function scheduleSettle(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    void onSettled()
  }, SETTLE_DELAY_MS)
}

/** autoDetectRegion(옵션)+refreshExtractionCache 한 사이클을 실제로 돌린다 — 잠금을 쥐고
 *  있다가 끝나면(성공/실패 무관) 풀고, 그 사이 pendingRetrigger 가 서 있었으면 곧바로
 *  새 settle 대기를 한 번 더 건다(즉시 재추출하지 않는 이유는 onSettled 참고). */
function runExtractionCycle(bitmap: Buffer | null): void {
  regionRefreshInFlight = true
  const onCycleDone = () => {
    regionRefreshInFlight = false
    console.log(
      `[changeWatcher] runExtractionCycle 완료 (pendingRetrigger=${pendingRetrigger}, abandoned=${cycleAbandoned})`,
    )
    // 폐기된 사이클(cycleAbandoned 주석 참고)은 캐시에 아무것도 안 남겼다 — 기준 비트맵
    // 갱신도 재트리거도 없이 조용히 끝낸다.
    if (cycleAbandoned) {
      cycleAbandoned = false
      pendingRetrigger = false
      return
    }
    // 이번에 추출을 시도한 화면으로 갱신 — 다음 onSettled 가 "결국 원래대로 돌아온 변화"를
    // 판단하는 기준이 된다. 영역도 같이 기록해, 다음 사이클이 폐기되면 되돌릴 수 있게 한다.
    if (bitmap) lastExtractedBitmap = bitmap
    const region = getRegion()
    const source = getRegionSource()
    if (region && source) lastExtractedRegion = { rect: region, source }
    if (pendingRetrigger) {
      pendingRetrigger = false
      if (running) scheduleSettle()
    }
  }
  console.log('[changeWatcher] runExtractionCycle 시작')
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
        // 이 사이클이 영역 재감지 단계 도중에 폐기됐으면(onSettled 의 복귀 판정) 여기서
        // 멈춘다 — 계속 진행하면 refreshExtractionCache 가 새 inFlight 로 다시 시작돼
        // 폐기(abandonInFlightExtraction)를 우회해버린다.
        if (cycleAbandoned) return
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
      .finally(onCycleDone)
  } else {
    // 자동 탐지가 꺼져 있으면(사용자 요청, 2026-07-29) 영역 자체는 처음 지정한
    // 그대로 두고, 그 안의 내용만 다시 인식한다 — 사용자가 직접 고른 영역을
    // 화면 변화 때마다 임의로 다시 잡으면 안 된다는 명시적 요구.
    sendExtractionStarted()
    void refreshExtractionCache()
      .catch((err) => {
        console.error('[changeWatcher] 재추출 실패:', err)
      })
      .finally(onCycleDone)
  }
}

/** settle 대기(SETTLE_DELAY_MS)가 끝난 뒤 실제로 호출된다. */
async function onSettled(): Promise<void> {
  settleTimer = null
  if (!running) return
  // 담당 A — 드래그를 잡고 있는 동안은 추출을 시작하지 않는다(2026-07-30, isPointerButtonDown
  // 주석 참고). 화면이 안정돼 보여도 일시적 상태(선택 하이라이트 등)일 가능성이 높다 —
  // 손을 뗄 때까지 settle 대기만 계속 미룬다.
  if (await isPointerButtonDown()) {
    console.log('[changeWatcher] onSettled: 드래그 진행 중 — 추출 보류, settle 재대기')
    scheduleSettle()
    return
  }
  // 담당 A — settle 판정 직전 재확인(2026-07-30, 사용자 제보 — 화면 전환 애니메이션
  // 도중 캡처된 화면을 DocLayout 이 잘못 인식해 한 열이 둘로 쪼개짐). 폴링 주기(1000ms)
  // 사이사이의 변화는 diff 임계값(2%)을 개별적으론 안 넘겨도 누적되면 전환이 아직 안
  // 끝났을 수 있다 — 실제로 추출을 시작하기 직전에 한 번 더 캡처해서 비교하고, 그
  // 사이에도 바뀌었으면 이번엔 건너뛰고 settle 대기를 다시 건다. 다음 정기 poll() 이
  // 알아서 다시 잡아줄 거라 기대하지 않는다 — 딱 이 순간 이후로 화면이 잠잠해지면
  // poll() 은 diff 자체를 못 잡아서 재시도가 영영 안 걸릴 수 있다.
  const freshBitmap = await captureRegionBitmap()
  if (!running) return
  const stillChangingRatio = freshBitmap && lastBitmap ? diffRatio(lastBitmap, freshBitmap) : null
  console.log(
    `[changeWatcher] onSettled: 재확인 diff=${stillChangingRatio ?? 'n/a'} inFlight=${regionRefreshInFlight}`,
  )
  if (freshBitmap && lastBitmap && bitmapsDiffer(lastBitmap, freshBitmap)) {
    lastBitmap = freshBitmap
    sendOverlayWords([])
    sendDebugBlocks([]) // 자동 탐지 블록도 같이 비워야 새 화면 위에 옛 영역 표시가 안 남는다
    scheduleSettle()
    return
  }
  // 담당 A — 드래그 후 취소처럼, 결국 마지막으로 실제 추출했던 화면과 동일한 상태로
  // 되돌아왔으면(순변화 없음) 재추출은 낭비다 — 건너뛰고 diff 감지 시점에
  // sendOverlayWords([]) 로 비웠던 오버레이만 캐시된 결과로 복원한다. peekCachedExtraction()
  // 은 getExtraction() 과 달리 캐시가 비어 있어도 새 추출을 트리거하지 않는다 — 여기서
  // 트리거해버리면 changeWatcher 의 regionRefreshInFlight 잠금과 무관하게 별도 추출이
  // 하나 더 시작돼 겹친다. 캐시가 아직 없으면(이 영역에서 changeWatcher 로는 아직 한
  // 번도 추출한 적 없는 경우) 건너뛸 게 없으니 그냥 아래로 내려가 정상적으로 재추출한다.
  const cachedNow = peekCachedExtraction()
  const revertRatio = freshBitmap && lastExtractedBitmap ? diffRatio(lastExtractedBitmap, freshBitmap) : null
  console.log(
    `[changeWatcher] onSettled: 복귀 판정 diff=${revertRatio ?? 'n/a'}(lastExtractedBitmap ${lastExtractedBitmap ? '있음' : '없음'}) cached=${cachedNow ? '있음' : '없음'}`,
  )
  if (freshBitmap && lastExtractedBitmap && cachedNow && !bitmapsDiffer(lastExtractedBitmap, freshBitmap)) {
    console.log('[changeWatcher] onSettled: 원래 상태로 복귀 판정 — 재추출 건너뛰고 캐시 복원')
    // 담당 A — 일시적 화면(PDF 클릭 시 나타나는 드래그형 하이라이트 등)으로 이미 추출
    // 사이클이 시작돼 있었으면 폐기한다(2026-07-30, 사용자 제보). 안 그러면 그 오염된
    // 추출이 (a) 완료 시 지금 복원한 멀쩡한 캐시/오버레이를 저품질 결과로 덮어쓰고,
    // (b) 그 사이 클릭한 팝업이 getExtraction() 의 inFlight 대기 때문에 추출이 끝날
    // 때까지(실측 최대 1분) 안 떴다.
    if (regionRefreshInFlight) {
      console.log('[changeWatcher] onSettled: 진행 중이던 오염 추출 폐기(abandon)')
      cycleAbandoned = true
      abandonInFlightExtraction()
      // 폐기된 사이클이 이미 실행해버린 부수효과(setRegion — 오염된 화면 기준으로 좁게
      // 재감지된 영역)를 마지막 커밋 시점의 영역으로 되돌린다. 영역 크기가 바뀌면
      // lastBitmap 크롭 크기도 달라져 다음 폴링이 크기 불일치로 항상 "변화"를 띄우므로
      // 비워서 조용히 새로 잡게 한다(runExtractionCycle 의 setRegion 직후와 동일한 처리).
      if (lastExtractedRegion) {
        setRegion(lastExtractedRegion.rect, lastExtractedRegion.source)
        lastBitmap = null
      }
    }
    sendOverlayWords(cachedNow.words)
    sendDebugBlocks(cachedNow.debugBlocks) // 노란 자동 탐지 블록도 캐시 기준으로 복원
    return
  }
  if (regionRefreshInFlight) {
    // 담당 A — 이전 사이클이 아직 진행 중이면 겹쳐서 시작하지 않되, 화면이 이 사이에도
    // 바뀐 상태(여기까지 온 것 자체가 diff 감지 때문)이므로 그냥 건너뛰지 않고 "이
    // 추출이 끝나면 다시 한 번 돌아라"라고 표시해둔다(runExtractionCycle 의 onCycleDone
    // 참고) — 화면이 딱 이 한 번만 더 바뀌고 그 뒤로 잠잠해지면(예: 전환 끝) 아무도 새
    // diff 를 못 잡아서 재추출이 영영 안 걸리는 문제를 막는다.
    console.log('[changeWatcher] onSettled: 이전 사이클 진행 중 — pendingRetrigger 설정')
    pendingRetrigger = true
    return
  }
  console.log('[changeWatcher] onSettled: 재추출 사이클 시작')
  runExtractionCycle(freshBitmap)
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
      const inputAge = Date.now() - lastInput
      console.log(`[changeWatcher] poll: diff=${diffRatio(lastBitmap, bitmap)} inputAge=${inputAge}ms`)
      // 스크롤/클릭/키보드 입력이 최근에 없었으면(hover 로 생긴 밑줄/툴팁, 배너 애니
      // 메이션 등) 픽셀은 달라졌어도 재추출을 걸지 않는다 — lastBitmap 은 아래에서
      // 어차피 갱신되므로 다음 폴링부터는 이 상태를 기준으로 다시 비교한다.
      if (inputAge > INPUT_FRESHNESS_MS) {
        lastBitmap = bitmap
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }
      // 담당 A — 대상 창 포커스 확인(2026-07-31, isTargetWindowForeground 주석 참고) —
      // 입력이 최근이어도 그 입력이 대상 창을 향한 게 아니면(다른 모니터의 다른 창
      // 클릭 등) 이 diff는 대상 창이 포커스를 잃으며 생긴 비활성 렌더링 변화일 뿐일
      // 수 있다.
      if (!(await isTargetWindowForeground())) {
        console.log('[changeWatcher] poll: 대상 창이 포커스 아님 — 오탐(비활성 렌더링 변화)으로 보고 건너뜀')
        lastBitmap = bitmap
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }
      // 변화가 인식된 순간부터 새 OCR 결과가 올 때까지 기존 단어 박스는 더 이상 화면
      // 내용과 안 맞으므로 바로 지운다(재추출이 끝나면 refreshExtractionCache 가
      // sendOverlayWords 로 새 박스를 채워 넣는다). 스크롤처럼 계속 바뀌는 동안엔 매
      // 폴링마다 다시 호출되지만 이미 빈 상태라 실질적으로는 무해하다.
      sendOverlayWords([])
      sendDebugBlocks([]) // 자동 탐지 블록도 같이 비워야 새 화면 위에 옛 영역 표시가 안 남는다
      // 계속 바뀌는 동안(스크롤 등)은 대기 타이머를 매번 리셋해서, 변화가 완전히
      // 멈춘 뒤에만 재추출하도록 한다.
      scheduleSettle()
    }
    // 담당 A — 최초 폴링 비트맵을 "마지막 추출 화면"의 초기값으로도 기록한다(2026-07-30).
    // 모드 진입 시의 최초 추출은 changeWatcher 밖(ipc.ts/shortcut.ts → refreshExtractionCache)
    // 에서 돌아서 lastExtractedBitmap 이 안 잡히는데, 그 상태에서 드래그→취소처럼 화면이
    // 원래대로 돌아오는 변화가 오면 onSettled 의 복귀 판정이 기준이 없어 무조건 전체
    // 재추출을 돌렸다. 최초 폴링(진입 직후 ~1초 내)의 화면은 최초 추출 대상과 사실상
    // 같으므로 그걸 기준으로 삼는다.
    if (!lastExtractedBitmap && !lastBitmap) lastExtractedBitmap = bitmap
    lastBitmap = bitmap
  }
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
}

/** 영역이 확정된 선택 모드에 진입/유지될 때 호출 — 이미 실행 중이면 아무 것도 안 한다. */
export function startChangeWatcher(): void {
  if (running) return
  running = true
  lastBitmap = null
  lastExtractedBitmap = null
  pendingRetrigger = false
  cycleAbandoned = false
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
  lastExtractedBitmap = null
  // 진행 중이던 autoDetectRegion/refreshExtractionCache 사이클의 완료를 기다리지 않고
  // 그냥 잠금을 푼다 — 이미 시작된 비동기 작업 자체를 취소할 방법은 없지만(Promise 는
  // 중간에 못 끊음), 모드를 나갔다 다시 들어왔을 때 이 잠금이 계속 걸려 있어 새
  // 워처가 영영 재감지를 못 하는 상황은 막아야 한다. 그 사이클이 끝났을 때(onCycleDone)
  // pendingRetrigger 를 보고 새 사이클을 또 걸지 않도록 이것도 같이 지운다.
  regionRefreshInFlight = false
  pendingRetrigger = false
  cycleAbandoned = false
}
