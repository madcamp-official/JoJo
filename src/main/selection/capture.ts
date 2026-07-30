import { app, BrowserWindow, desktopCapturer, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CaptureSource } from '@shared/types'
import { isViewerWindow } from '../windows'

const execFileAsync = promisify(execFile)
// win32Capture 는 koffi 로 user32.dll 등을 로드하므로 최상단 static import 로 두면
// Windows 가 아닌 OS(맥·리눅스)에서도 import 시점에 DLL 로드가 실행돼 크래시한다.
// → Windows 경로에서만 동적 import 로 지연 로드한다(koffi 는 optionalDependencies).

// 담당 A — 창 선택 & 포커스 창 캡처 (PLAN.md §5.1)
// Zoom 화면공유처럼 창 목록을 제공하고, 선택된 창의 화면을 캡처한다.
//
// Windows 에서는 desktopCapturer 대신 win32Capture(EnumWindows + PrintWindow)를
// 사용한다 — desktopCapturer 는 다른 창에 완전히 가려진 창을 누락시키거나 빈
// 썸네일을 주는 한계가 있다(PLAN.md 체크리스트: "창 선택 UI" 실사용 중 발견).

// 썸네일 그리드 타일과 동일한 종횡비로 고정 크롭한다(모든 창이 같은 픽셀 크기로 나가도록).
const THUMBNAIL_SIZE = { width: 320, height: 205 }

/** "앱 이름 - 창 제목" 형태로 합친다 — 앱 이름을 못 구했거나 제목과 중복되면 제목만 반환. */
function withOwnerName(owner: string | null | undefined, title: string): string {
  if (!owner || owner === title) return title
  return `${owner} - ${title}`
}

/** exe 파일명(확장자 제외, 예: "chrome")을 "Chrome" 처럼 대략적인 표시용 이름으로 만든다. */
function friendlyExeName(exeBase: string): string {
  return exeBase.charAt(0).toUpperCase() + exeBase.slice(1)
}

/** cover 방식으로 리사이즈 후 중앙 크롭 — 원본 창 크기/비율과 무관하게 항상 같은 크기를 반환. */
function toUniformThumbnail(image: Electron.NativeImage): Electron.NativeImage {
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return image

  const scale = Math.max(THUMBNAIL_SIZE.width / size.width, THUMBNAIL_SIZE.height / size.height)
  const scaled = image.resize({
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  })
  const scaledSize = scaled.getSize()
  const x = Math.max(0, Math.floor((scaledSize.width - THUMBNAIL_SIZE.width) / 2))
  const y = Math.max(0, Math.floor((scaledSize.height - THUMBNAIL_SIZE.height) / 2))

  return scaled.crop({
    x,
    y,
    width: Math.min(THUMBNAIL_SIZE.width, scaledSize.width),
    height: Math.min(THUMBNAIL_SIZE.height, scaledSize.height),
  })
}

// 최소화된 창의 직전 썸네일 캐시 — 최소화된 창은 PrintWindow 로 캡처가 안 되고, DWM
// 썸네일 방식(captureMinimizedWin32Window)은 호스트 창을 화면 우하단에 아주 짧게라도
// 실제로 띄워야만 해서(DWM 이 화면 밖/투명 창은 합성을 건너뜀 — 해당 함수 주석 참고)
// 창 목록을 열 때마다 그 창이 사용자 눈에 잠깐 보이는 문제가 있었다(사용자 제보,
// 2026-07-31 — "오른쪽 밑에 짧게 스크린샷 하는 게 보인다"). 창 목록에서는 그 방식을
// 버리고, 창이 아직 화면에 있을 때 목록에서 캡처해둔 마지막 썸네일을 재사용한다.
//
// 담당 A — userData/window-thumbnails.json 에 영속화(2026-07-31, 사용자 요청 — 메모리
// 캐시만으로는 앱을 껐다 켜면 사라져서 "이번 실행에서 한 번도 안 띄운 최소화 창"이라는
// 빈틈이 매번 생김). 키를 hwnd 대신 "소유 앱 exe + 창 제목"으로 잡는다 — hwnd는 창을
// 다시 열 때마다 새로 부여되는 임시 값이라 재시작하면 무의미해지지만, exe+제목 조합은
// 같은 창이면 재시작해도 그대로 유지된다.
const MAX_CACHED_THUMBNAILS = 200 // 무한정 쌓이지 않게, 가장 오래 안 갱신된 것부터 비운다(LRU 근사)

function thumbnailCacheFilePath(): string {
  return join(app.getPath('userData'), 'window-thumbnails.json')
}

/** "소유 앱 exe(친화적 이름 변환 전) + 창 제목" 조합 — hwnd와 달리 재시작해도 안정적이다. */
function thumbnailCacheKey(ownerExeBase: string | null, title: string): string {
  return `${ownerExeBase ?? ''}|${title}`
}

let thumbnailCache: Map<string, string> | null = null

function loadThumbnailCache(): Map<string, string> {
  if (thumbnailCache) return thumbnailCache
  try {
    const raw = readFileSync(thumbnailCacheFilePath(), 'utf-8')
    thumbnailCache = new Map(Object.entries(JSON.parse(raw)))
  } catch {
    thumbnailCache = new Map() // 파일이 없거나(첫 실행) 손상됐으면 빈 캐시로 시작
  }
  return thumbnailCache
}

let thumbnailCacheDirty = false

/** 새 썸네일을 캐시에 반영한다 — 디스크 저장은 flushThumbnailCache()가 호출부(창 목록
 *  조회 1회 끝)에서 한 번만 하도록 별도 플래그로 미룬다(창마다 매번 쓰기 I/O 하지 않게). */
function rememberThumbnail(key: string, dataUrl: string): void {
  const cache = loadThumbnailCache()
  cache.delete(key) // 있었으면 지우고 다시 넣어 삽입 순서를 최신으로 갱신(Map은 삽입 순서 유지 — LRU 근사)
  cache.set(key, dataUrl)
  while (cache.size > MAX_CACHED_THUMBNAILS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  thumbnailCacheDirty = true
}

function flushThumbnailCache(): void {
  if (!thumbnailCacheDirty || !thumbnailCache) return
  try {
    writeFileSync(thumbnailCacheFilePath(), JSON.stringify(Object.fromEntries(thumbnailCache)), 'utf-8')
    thumbnailCacheDirty = false
  } catch (err) {
    console.error('[capture] 썸네일 캐시 저장 실패:', err)
  }
}

// 캐시조차 없는 최소화 창용 플레이스홀더 — 피커 타일 배경과 어울리는 어두운 무지 타일.
// 메인 프로세스에서 텍스트를 그릴 수단이 마땅치 않아 단색으로만 채운다(창 이름은 어차피
// 타일 아래에 따로 표시됨).
let minimizedPlaceholder: string | null = null
function getMinimizedPlaceholder(): string {
  if (!minimizedPlaceholder) {
    const { width, height } = THUMBNAIL_SIZE
    const buf = Buffer.alloc(width * height * 4)
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 0x33 // B
      buf[i + 1] = 0x2f // G
      buf[i + 2] = 0x2d // R
      buf[i + 3] = 0xff
    }
    minimizedPlaceholder = nativeImage.createFromBitmap(buf, { width, height }).toDataURL()
  }
  return minimizedPlaceholder
}

// 담당 A — 최소화 창 썸네일에 desktopCapturer 를 써보는 실험(2026-07-31, 사용자 요청 —
// "mac 은 desktopCapturer 로 되는데 Windows 는 안 되나 해보자")은 실측 후 폐기했다.
// mac(listWindowsElectron)은 desktopCapturer 가 OS 레벨 창 스냅샷 캐시(WindowServer)를
// 그냥 물어보기만 하면 돼서 최소화 여부와 무관하게 항상 정상 썸네일을 주는데, Windows 는
// **desktopCapturer.getSources({types:['window']})가 최소화된 창을 후보 목록에서
// 아예 빼버린다**(빈 썸네일 정도가 아니라 목록 자체에 없음) — 실측 확인: 최소화 7개를
// 포함한 창 8개 중 desktopCapturer 는 최소화 안 된 1개만 돌려줬다. Windows 에는 mac의
// WindowServer 같은 "항상 살아있는 창 스냅샷 캐시"가 없고, 그 역할을 하는 유일한 API가
// DWM Thumbnail(captureMinimizedWin32Window)인데 이건 화면 밖/투명 창은 합성을 건너뛰는
// 제약이 있어 최소화 창을 깜빡임 없이 캡처할 방법이 원천적으로 없다 — 아래의 디스크
// 영속화 캐시(직전 썸네일 재사용)가 유일한 실용적 대안이다.

async function listWindowsWin32(): Promise<CaptureSource[]> {
  // Windows 에서만 실행되는 경로. koffi 의존 모듈을 여기서 지연 로드한다.
  const { captureWin32Window, listWin32Windows } = await import('./win32Capture')

  // 자체 문서 뷰어 창은 일부러 남긴다 — 사용자가 뷰어 창을 창 선택으로 골라 direct 추출
  // 위에 OCR 을 추가로 얹을 수 있어야 한다(뷰어가 텍스트를 못 뽑는 스캔본 PDF 등).
  const ownHwnds = new Set(
    BrowserWindow.getAllWindows()
      .filter((w) => !isViewerWindow(w))
      .map((w) => w.getNativeWindowHandle().readBigUInt64LE(0)),
  )

  const targets = listWin32Windows().filter((win) => !ownHwnds.has(win.hwnd))

  // 순차적으로 캡처한다 — 창 사이에 짧은 텀을 두어 GDI/DWM 리소스 경합을 줄인다.
  const sources: CaptureSource[] = []
  let captured = false // 실제 캡처를 한 번이라도 한 뒤부터만 텀을 둔다(캐시/플레이스홀더는 공짜)
  for (const win of targets) {
    const id = String(win.hwnd)
    const owner = win.ownerName ? friendlyExeName(win.ownerName) : null
    const name = withOwnerName(owner, win.title)
    const cacheKey = thumbnailCacheKey(win.ownerName, win.title)

    if (win.minimized) {
      const cached = loadThumbnailCache().get(cacheKey)
      console.log(`[capture] 최소화 창 "${win.title}" (key="${cacheKey}") 캐시 ${cached ? '있음' : '없음(플레이스홀더)'}`)
      sources.push({ id, name, thumbnail: cached ?? getMinimizedPlaceholder() })
      continue
    }

    if (captured) await new Promise((resolve) => setTimeout(resolve, 150))
    captured = true
    const shot = await captureWin32Window(win.hwnd, win.width, win.height)
    if (!shot) continue

    const image = nativeImage.createFromBitmap(shot.buffer, { width: shot.width, height: shot.height })
    const thumbnail = toUniformThumbnail(image).toDataURL()
    rememberThumbnail(cacheKey, thumbnail) // 나중에 이 창이 최소화된 채 목록에 뜰 때(재시작 이후에도) 재사용
    sources.push({ id, name, thumbnail })
  }
  flushThumbnailCache() // 이번 호출에서 새로 캡처한 게 있으면 한 번만 디스크에 반영
  return sources
}

// 담당 A — 창이 포그라운드로 올라오는 순간마다 상시로 썸네일을 캐시한다(2026-07-31,
// 사용자 요청 — "창 목록을 열 때뿐 아니라 어떤 창을 화면에 띄우면 그때 캡처해서 캐시").
// 위 listWindowsWin32 의 "목록 열 때 화면에 떠있는 창만 캡처"만으로는, 어떤 창을 띄웠다가
// 창 선택 화면을 한 번도 안 연 채로 바로 최소화해버리면 그 창은 영영 캐시가 안 생기는
// 빈틈이 있었다 — 시스템 전역 WinEventHook(EVENT_SYSTEM_FOREGROUND, win32Capture.ts:
// onWindowForegroundChanged, 이미 오버레이 z-order 추적에도 쓰이는 훅을 그대로 구독만
// 추가)으로 그 순간을 놓치지 않는다.
const FOREGROUND_CAPTURE_COOLDOWN_MS = 3000 // 같은 창을 짧은 시간 안에 반복 캡처하지 않는다(알트탭 연타 등)
const lastForegroundCaptureAt = new Map<string, number>() // cacheKey → 마지막 캡처 시각

let foregroundCaptureStarted = false

/** main/index.ts 가 앱 시작 시 1회 호출(win32 전용). 여러 번 불러도 안전(중복 등록 방지). */
export async function startForegroundThumbnailCapture(): Promise<void> {
  if (foregroundCaptureStarted || process.platform !== 'win32') return
  foregroundCaptureStarted = true

  const { captureWin32Window, getWin32WindowInfo, onWindowForegroundChanged } = await import('./win32Capture')

  onWindowForegroundChanged((hwnd) => {
    void (async () => {
      const ownHwnds = new Set(
        BrowserWindow.getAllWindows()
          .filter((w) => !isViewerWindow(w))
          .map((w) => w.getNativeWindowHandle().readBigUInt64LE(0)),
      )
      if (ownHwnds.has(hwnd)) return // 우리 앱 자신의 창은 대상 아님

      // 담당 A — 정보 조회를 지연 이후로 미룸(2026-07-31, 사용자 제보 두 건 연달아 확인).
      // (1) "유튜브 뮤직은 실제로 검은 화면인데 흰색으로 캡처됨" — GPU 합성을 쓰는 창
      // (Chrome 계열 등)은 방금 활성화된 순간엔 아직 실제 프레임을 그리기 전이라,
      // PrintWindow 가 (완전히 비어있진 않은) 흰 배경만 캡처해버릴 수 있다 —
      // captureWin32Window 의 재시도(hasRealContent)는 "완전히 빈 화면"만 걸러내지 "흰
      // 배경뿐인 아직 안 그려진 프레임"은 못 거른다(둘 다 nonzero 바이트 비율은 충분함).
      // (2) 지연을 추가한 뒤 재확인하니, 복원 애니메이션(작업표시줄에서 창을 다시 띄울
      // 때) 도중엔 이벤트가 막 도착한 시점에 `IsIconic`이 아직 true 를 돌려줘서
      // "이미 최소화 상태"로 오판, 캡처를 통째로 건너뛰어 옛(잘못된) 캐시가 그대로
      // 남는 문제도 같이 확인됨 — 정보 조회(getWin32WindowInfo, minimized 판정 포함)
      // 자체를 지연 이후로 미뤄서 두 문제를 한 번에 해결한다: 그 시점엔 GPU 렌더링도,
      // 복원 애니메이션도 대부분 끝나 있다.
      const FOREGROUND_CAPTURE_DELAY_MS = 400
      await new Promise((resolve) => setTimeout(resolve, FOREGROUND_CAPTURE_DELAY_MS))

      const info = getWin32WindowInfo(hwnd)
      // 임시 진단 로그(2026-07-31, 사용자 제보 — "방금 새로 띄운 창이 캐시 안 됨") — 어느
      // 단계에서 걸러지는지 확인한다.
      if (!info) {
        console.log(`[capture] 포그라운드 hwnd=${hwnd} 목록 후보 기준에서 제외됨(제목 없음/툴윈도우/클로킹 등)`)
        return
      }
      if (info.minimized) {
        console.log(`[capture] 포그라운드 "${info.title}" 인데 ${FOREGROUND_CAPTURE_DELAY_MS}ms 지연 후에도 최소화 상태 — 스킵`)
        return
      }

      const cacheKey = thumbnailCacheKey(info.ownerName, info.title)
      const now = Date.now()
      const last = lastForegroundCaptureAt.get(cacheKey)
      if (last !== undefined && now - last < FOREGROUND_CAPTURE_COOLDOWN_MS) {
        console.log(`[capture] 포그라운드 "${info.title}" 쿨다운 중(${now - last}ms 전 캡처) — 건너뜀`)
        return
      }
      lastForegroundCaptureAt.set(cacheKey, now)

      const shot = await captureWin32Window(hwnd, info.width, info.height)
      if (!shot) {
        console.log(`[capture] 포그라운드 "${info.title}" 캡처 실패(빈 결과)`)
        return
      }
      const image = nativeImage.createFromBitmap(shot.buffer, { width: shot.width, height: shot.height })
      rememberThumbnail(cacheKey, toUniformThumbnail(image).toDataURL())
      console.log(`[capture] 포그라운드 썸네일 캐시 갱신: "${info.title}" (key="${cacheKey}")`)
      scheduleThumbnailCacheFlush()
    })().catch((err) => console.error('[capture] 포그라운드 썸네일 캡처 실패:', err))
  })
}

// 포그라운드 전환마다 즉시 디스크에 쓰면 알트탭을 자주 하는 사용자에게 잦은 파일 I/O가
// 생긴다 — 마지막 캡처로부터 조용한 구간이 있을 때만 한 번 몰아서 쓴다(디바운스).
let flushTimer: NodeJS.Timeout | null = null
const FLUSH_DEBOUNCE_MS = 5000
function scheduleThumbnailCacheFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushThumbnailCache()
  }, FLUSH_DEBOUNCE_MS)
}

async function listWindowsElectron(): Promise<CaptureSource[]> {
  // 뷰어 창만 예외로 목록에 남긴다(위 win32 경로와 같은 이유).
  const ownSourceIds = new Set(
    BrowserWindow.getAllWindows()
      .filter((w) => !isViewerWindow(w))
      .map((w) => w.getMediaSourceId()),
  )

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: THUMBNAIL_SIZE.width * 2, height: THUMBNAIL_SIZE.height * 2 },
  })

  // macOS: desktopCapturer 는 owner 앱 이름을 안 주므로 CGWindowList 로 windowId → 앱 이름
  // 맵을 한 번에 조회해 "앱 이름 - 창 제목"으로 합쳐 보여준다.
  let ownerNames: Map<number, string> | null = null
  if (process.platform === 'darwin') {
    const { listMacWindowOwnerNames } = await import('./macWindow')
    ownerNames = listMacWindowOwnerNames()
  }

  return sources
    .filter((s) => !ownSourceIds.has(s.id))
    .map((s) => {
      const wid = ownerNames ? Number(/^window:(\d+)/.exec(s.id)?.[1]) : NaN
      const owner = ownerNames && Number.isFinite(wid) ? ownerNames.get(wid) : undefined
      return {
        id: s.id,
        name: withOwnerName(owner, s.name),
        thumbnail: toUniformThumbnail(s.thumbnail).toDataURL(),
      }
    })
}

export async function listWindows(): Promise<CaptureSource[]> {
  if (process.platform === 'win32') {
    try {
      return await listWindowsWin32()
    } catch (err) {
      console.error('[capture] win32 window enumeration failed, falling back:', err)
    }
  }
  return listWindowsElectron()
}

let selectedWindowId: string | null = null
let selectedWindowName: string | null = null

export function getSelectedWindowId(): string | null {
  return selectedWindowId
}

export function setSelectedWindowId(id: string | null): void {
  selectedWindowId = id
}

/** "오너앱 - 창 제목" 형식(withOwnerName)의 선택된 창 이름 — 브라우저 여부 판정 등에 씀. */
export function getSelectedWindowName(): string | null {
  return selectedWindowName
}

export function setSelectedWindowName(name: string | null): void {
  selectedWindowName = name
}

// 선택된 창을 프레임 캡처하여 OCR 입력용 이미지 버퍼(PNG) 반환.
export async function captureFocusedWindow(): Promise<Buffer> {
  if (!selectedWindowId) throw new Error('captureFocusedWindow: 선택된 창 없음')
  if (process.platform === 'darwin') return captureMacWindow(selectedWindowId)
  if (process.platform !== 'win32') {
    throw new Error('captureFocusedWindow: 지원하지 않는 플랫폼')
  }

  const hwnd = BigInt(selectedWindowId)
  const { captureMinimizedWin32Window, captureWin32Window, getWindowScreenRect } = await import(
    './win32Capture'
  )

  const rect = getWindowScreenRect(hwnd)
  const shot = rect
    ? await captureWin32Window(hwnd, rect.width, rect.height)
    : await captureMinimizedWin32Window(hwnd)
  if (!shot) throw new Error('captureFocusedWindow: 캡처 실패')

  return nativeImage
    .createFromBitmap(shot.buffer, { width: shot.width, height: shot.height })
    .toPNG()
}

/**
 * macOS 창 캡처 — 내장 `screencapture -l<windowID>` 로 대상 창을 네이티브 해상도 PNG 로 캡처한다
 * (Windows 의 PrintWindow 와 동급 품질). desktopCapturer 썸네일보다 선명해 OCR 정확도가 높다.
 * 화면 기록 권한이 필요하다(창 목록 표시에서 이미 요구됨). Retina 에선 물리 픽셀(2x)로 캡처되며,
 * OCR bbox 의 배율 보정은 alignWordsToOverlay(mac 분기)에서 처리한다.
 */
async function captureMacWindow(sourceId: string): Promise<Buffer> {
  const m = /^window:(\d+)/.exec(sourceId)
  if (!m) throw new Error(`captureFocusedWindow: mac window id 파싱 실패 (${sourceId})`)
  return captureMacWindowById(Number(m[1]))
}

async function captureMacWindowById(windowId: number): Promise<Buffer> {
  const out = join(tmpdir(), `nuance-capture-${process.pid}-${Date.now()}-${windowId}.png`)
  // -x: 소리 없음, -o: 창 그림자 제외(창 프레임만), -t png: PNG, -l<id>: 해당 CGWindowID 창만
  await execFileAsync('screencapture', ['-x', '-o', '-t', 'png', `-l${windowId}`, out])
  try {
    return await readFile(out)
  } finally {
    void unlink(out).catch(() => {})
  }
}
