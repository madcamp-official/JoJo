import koffi from 'koffi'
import type { Rect } from '@shared/types'
import { getMacWindowBounds, getMacWindowOwnerPid } from './macWindow'

// 담당 milleion — macOS 접근성(AX) API 로 미리보기(Preview.app)가 화면에 그린 PDF 텍스트와
// 그 좌표를 OCR 없이 직접 읽는다(TODO.md "브라우저 밖 PDF" 항목, 사전 검증은
// feat/mac-ax-pdf 스파이크에서 완료).
//
// 구조(실측): AXWindow / AXSplitGroup / AXScrollArea / AXGroup(AXSharedDocumentContainer)
//             / AXPage × 페이지수 / AXGroup… / AXStaticText(문단 단위)
// 텍스트 노드는 파라미터 속성(AXRangeForLine / AXStringForRange / AXBoundsForRange)을
// 지원해서, 문자 범위만 지정하면 그 범위만 감싸는 정확한 CGRect 를 돌려준다 — 이 좌표가
// 곧 hover 박스가 된다.
//
// 구현 시 함정 두 가지(스파이크에서 실제로 겪음, TODO.md 에도 기록):
//  1) 파라미터 속성 이름은 상수 심볼명(kAXBoundsForRangeParameterizedAttribute)이 아니라
//     실제 문자열 값("AXBoundsForRange")이다. 틀리면 -25213(파라미터 속성 미지원)으로
//     조용히 실패하는데, 노드는 지원 목록에 그 이름을 광고하고 있어서 오진하기 쉽다.
//  2) koffi 에 CFRange/CGRect 같은 구조체를 넘길 때는 JS 객체가 아니라 Buffer 로 인코딩해야
//     한다(객체를 넘기면 "Unexpected Object value, expected void *" 로 크래시).

const APPLICATION_SERVICES =
  '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

type KFn = (...args: unknown[]) => unknown

const CGRectS = koffi.struct('AxCGRect', { x: 'double', y: 'double', width: 'double', height: 'double' })
const CGPointS = koffi.struct('AxCGPoint', { x: 'double', y: 'double' })
const CGSizeS = koffi.struct('AxCGSize', { width: 'double', height: 'double' })

const kAXValueCGPointType = 1
const kAXValueCGSizeType = 2
const kAXValueCGRectType = 3
const kAXValueCFRangeType = 4
const kCFStringEncodingUTF8 = 0x08000100
/** 파라미터 속성이 아예 없는 노드(그룹 등)에서 나는 오류 — 정상 흐름이라 로그도 남기지 않는다. */
const kAXErrorParameterizedAttributeUnsupported = -25213

let loaded = false
let AXUIElementCreateApplication: KFn | null = null
let AXUIElementCopyAttributeValue: KFn | null = null
let AXUIElementCopyParameterizedAttributeValue: KFn | null = null
let AXValueGetValue: KFn | null = null
let AXValueCreate: KFn | null = null
let CFStringCreateWithCString: KFn | null = null
let CFStringGetCString: KFn | null = null
let CFGetTypeID: KFn | null = null
let CFStringGetTypeID: KFn | null = null
let CFArrayGetTypeID: KFn | null = null
let CFArrayGetCount: KFn | null = null
let CFArrayGetValueAtIndex: KFn | null = null
let CFRelease: KFn | null = null
let CFRetain: KFn | null = null

function ensureAx(): boolean {
  if (loaded) return AXUIElementCreateApplication !== null
  loaded = true
  if (process.platform !== 'darwin') return false
  try {
    const as = koffi.load(APPLICATION_SERVICES)
    const cf = koffi.load(CORE_FOUNDATION)
    AXUIElementCreateApplication = as.func('void* AXUIElementCreateApplication(int pid)')
    AXUIElementCopyAttributeValue = as.func(
      'int AXUIElementCopyAttributeValue(void* el, void* attr, _Out_ void** value)',
    )
    AXUIElementCopyParameterizedAttributeValue = as.func(
      'int AXUIElementCopyParameterizedAttributeValue(void* el, void* attr, void* param, _Out_ void** value)',
    )
    AXValueGetValue = as.func('bool AXValueGetValue(void* value, uint32_t type, void* out)')
    AXValueCreate = as.func('void* AXValueCreate(uint32_t type, void* ptr)')
    CFStringCreateWithCString = cf.func('void* CFStringCreateWithCString(void* alloc, const char* s, uint32_t enc)')
    CFStringGetCString = cf.func('bool CFStringGetCString(void* s, _Out_ char* buf, long size, uint32_t enc)')
    CFGetTypeID = cf.func('unsigned long CFGetTypeID(void* cf)')
    CFStringGetTypeID = cf.func('unsigned long CFStringGetTypeID()')
    CFArrayGetTypeID = cf.func('unsigned long CFArrayGetTypeID()')
    CFArrayGetCount = cf.func('long CFArrayGetCount(void* arr)')
    CFArrayGetValueAtIndex = cf.func('void* CFArrayGetValueAtIndex(void* arr, long idx)')
    CFRelease = cf.func('void CFRelease(void* cf)')
    CFRetain = cf.func('void* CFRetain(void* cf)')
    return true
  } catch (err) {
    console.warn('[macAx] 접근성 프레임워크 로드 실패:', (err as Error)?.message)
    AXUIElementCreateApplication = null
    return false
  }
}

// 속성 이름 CFString 은 호출마다 새로 만들지 않고 캐시한다(호출 횟수가 단어 수만큼 많다).
const cfStringCache = new Map<string, unknown>()
function cfstr(s: string): unknown {
  let ref = cfStringCache.get(s)
  if (ref === undefined) {
    ref = CFStringCreateWithCString!(null, s, kCFStringEncodingUTF8)
    cfStringCache.set(s, ref)
  }
  return ref
}

function release(ref: unknown): void {
  if (!ref) return
  try {
    CFRelease!(ref)
  } catch {
    /* 무시 */
  }
}

/**
 * `CFArrayGetValueAtIndex`/`AXUIElementCopyAttributeValue` 로 얻는 자식 요소는 "Get 규칙"
 * (빌려온 참조)이라, 그 부모 배열이 해제되는 즉시 무효화된다. `forEachChild` 는 순회가
 * 끝나면 곧바로 그 배열을 해제하므로(synchronous), 순회 콜백 안에서 받은 요소를 나중에
 * (특히 비동기 처리 뒤에) 다시 쓰려면 반드시 여기서 명시적으로 retain 해둬야 한다 —
 * 안 그러면 배열 해제 후 그 요소에 접근할 때 use-after-free 로 크래시난다(실측,
 * 2026-07-30: `AXUIElementCopyParameterizedAttributeValue`→`_AXUIElementValidate`에서
 * SIGSEGV — `AxParagraph.boundsOf` 클로저가 CJK 형태소 분석 대기 뒤에야 호출되는데, 그 사이
 * 부모 `AXChildren` 배열이 이미 해제된 뒤였다). retain 한 요소는 다 쓴 뒤 반드시
 * `release()`로 짝을 맞춰야 한다(macAx.ts: releaseRetained 참고).
 */
function retain<T>(ref: T): T {
  if (!ref) return ref
  return CFRetain!(ref) as T
}

function cfStringToJs(ref: unknown): string | null {
  if (!ref) return null
  // CFStringGetLength 는 UTF-16 길이라 UTF-8 최악(문자당 4바이트) + 종단을 잡아준다.
  const buf = Buffer.alloc(1024 * 1024)
  if (!CFStringGetCString!(ref, buf, buf.length, kCFStringEncodingUTF8)) return null
  const end = buf.indexOf(0)
  return buf.toString('utf8', 0, end < 0 ? buf.length : end)
}

/** 속성 하나 읽기 — 반환된 CF 객체는 호출부가 release() 해야 한다(+1 retained). */
function copyAttribute(el: unknown, name: string): unknown {
  const out = [null]
  const err = AXUIElementCopyAttributeValue!(el, cfstr(name), out) as number
  if (err !== 0) return null
  return out[0]
}

function attributeString(el: unknown, name: string): string | null {
  const value = copyAttribute(el, name)
  if (!value) return null
  try {
    if (CFGetTypeID!(value) !== CFStringGetTypeID!()) return null
    return cfStringToJs(value)
  } finally {
    release(value)
  }
}

function decodeAxValue(value: unknown, type: number, size: number, struct: unknown): Record<string, number> | null {
  const buf = Buffer.alloc(size)
  if (!AXValueGetValue!(value, type, buf)) return null
  return koffi.decode(buf, struct as never) as Record<string, number>
}

function attributePoint(el: unknown, name: string): { x: number; y: number } | null {
  const value = copyAttribute(el, name)
  if (!value) return null
  try {
    const p = decodeAxValue(value, kAXValueCGPointType, 16, CGPointS)
    return p ? { x: p.x!, y: p.y! } : null
  } finally {
    release(value)
  }
}

function attributeSize(el: unknown, name: string): { width: number; height: number } | null {
  const value = copyAttribute(el, name)
  if (!value) return null
  try {
    const s = decodeAxValue(value, kAXValueCGSizeType, 16, CGSizeS)
    return s ? { width: s.width!, height: s.height! } : null
  } finally {
    release(value)
  }
}

/** 자식 요소들을 순회한다 — 요소 포인터는 부모 배열이 살아있는 동안만 유효하므로,
 *  콜백 안에서 필요한 값을 다 뽑아 쓰고 배열은 순회가 끝나면 바로 해제한다(포인터를
 *  배열 밖으로 들고 나가면 해제 뒤 무효 포인터가 된다). */
function forEachChild(el: unknown, fn: (child: unknown) => void): void {
  const array = copyAttribute(el, 'AXChildren')
  if (!array) return
  try {
    if (CFGetTypeID!(array) !== CFArrayGetTypeID!()) return
    const count = Number(CFArrayGetCount!(array))
    for (let i = 0; i < count; i++) {
      const child = CFArrayGetValueAtIndex!(array, i)
      if (child) fn(child)
    }
  } finally {
    release(array)
  }
}

function copyParameterized(el: unknown, name: string, param: unknown): unknown {
  const out = [null]
  const err = AXUIElementCopyParameterizedAttributeValue!(el, cfstr(name), param, out) as number
  if (err !== 0) {
    if (err !== kAXErrorParameterizedAttributeUnsupported && process.env.DEBUG_AX) {
      console.warn(`[macAx] ${name} err=${err}`)
    }
    return null
  }
  return out[0]
}

function rangeBuffer(location: number, length: number): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeBigInt64LE(BigInt(location), 0)
  buf.writeBigInt64LE(BigInt(length), 8)
  return buf
}

/** 문자 범위 [location, location+length) 를 감싸는 화면 사각형(스크린 전역 좌표, 포인트). */
function boundsForRange(el: unknown, location: number, length: number): Rect | null {
  const param = AXValueCreate!(kAXValueCFRangeType, rangeBuffer(location, length))
  if (!param) return null
  const value = copyParameterized(el, 'AXBoundsForRange', param)
  release(param)
  if (!value) return null
  try {
    const r = decodeAxValue(value, kAXValueCGRectType, 32, CGRectS)
    if (!r || !(r.width! > 0 && r.height! > 0)) return null
    return { x: r.x!, y: r.y!, width: r.width!, height: r.height! }
  } finally {
    release(value)
  }
}

// ---- 페이지/문단 추출 --------------------------------------------------------

/**
 * 텍스트 노드(문단) 하나 — 전체 텍스트와, 그 안 임의 문자 범위의 화면 사각형을 얻는 함수.
 *
 * **`AXRangeForLine`은 안 쓴다(2026-07-30/31, 실사용 제보 + `DEBUG_PDF_AX_DUMP` 덤프로
 * 확인).** 처음엔 이 API로 "화면에 표시된 줄"을 얻어 그 경계에 맞춰 텍스트를 잘랐는데,
 * 이 PDF의 특정 노드에서 근본적으로 신뢰할 수 없다는 게 드러났다 — 문단 첫 줄이 실제
 * 시작이 아니라 한참 건너뛴 지점부터 시작하거나("In a hole in the ground there"
 * 유실), 줄 경계가 공백이 아니라 단어 중간에서 끊기거나("pantries"→"pantrie"+"s"),
 * 문단 하나의 마지막 "줄"이 다음 문단 내용까지 섞여서 나오는 등, 한 가지 보정으로는
 * 끝이 없는 다양한 방식으로 어긋났다. 반면 문단 전체를 한 번에 가져오는 `AXValue`
 * (`text`)와, 임의 문자 범위의 좌표를 그때그때 물어보는 `AXBoundsForRange`는 스파이크
 * 실측부터 지금까지 일관되게 신뢰할 만했다 — 그래서 **텍스트는 항상 `AXValue`를
 * 통째로 쓰고(줄 단위로 다시 쪼개지 않음), 단어 하나하나의 좌표만 필요할 때마다
 * `AXBoundsForRange`로 직접 질의한다.** 화면상 줄바꿈이 필요한 곳(팝업 문맥 계산용)은
 * AX 에 묻지 않고 인접 단어들의 실제 렌더 좌표(Y 겹침 여부)로 호출부(pdfAxSource.ts)가
 * 직접 판정한다 — 이러면 애초에 "AX가 주장하는 줄 경계"라는 신뢰 못 할 개념 자체가
 * 파이프라인에서 사라진다.
 */
export interface AxParagraph {
  text: string
  /** text 안의 [start, start+length) 범위를 감싸는 사각형(창 좌상단 기준 DIP). */
  boundsOf: (start: number, length: number) => Rect | null
}

function paragraphOfTextNode(node: unknown, origin: { x: number; y: number }): AxParagraph | null {
  const value = attributeString(node, 'AXValue')
  if (!value) return null
  const toWindow = (r: Rect | null): Rect | null =>
    r ? { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height } : null
  return {
    text: value,
    boundsOf: (start, length) => toWindow(boundsForRange(node, start, length)),
  }
}

/** 한 페이지 = 화면에 보이는 문단(텍스트 노드) 목록. */
export interface AxPage {
  /** 페이지 사각형(창 기준 DIP) — 스크롤 위치 변화 감지에 쓴다. */
  bbox: Rect
  paragraphs: AxParagraph[]
}

const MAX_TREE_DEPTH = 16
// 노드 하나마다 AX 호출은 프로세스 간 통신(XPC)이라 개당 비용이 있다. 실측(2026-07-30,
// ax-attrs.cjs 진단)으로 확인된 실제 PDF 렌더 트리는 한 깊이에 300개가 넘는 장식용
// AXGroup/AXImage 가 나오고 그 아래로도 계속 자식이 있어서, 방문 개수 상한 없이 깊이
// 제한만으로는 한 페이지 서브트리 전체 순회가 수천~수만 회 호출로 폭발할 수 있다(진단
// 스크립트가 몇 초 안에 끝난 건 "3개 찾으면 중단"하는 조기 종료 때문이었다 — 이 함수들은
// 콜백이 조기 종료를 안 하므로 그 이점이 없다). 총 방문 노드 수에 상한을 둬 최악의 경우
// 에도 응답이 멈추지 않게 한다 — 넘치면 그 지점까지 찾은 결과만 쓰고 텍스트 일부가
// 빠질 수 있지만, 몇 초씩 멈추는 것보다 낫다.
const MAX_NODES_VISITED = 6000

function forEachPage(el: unknown, depth: number, budget: { left: number }, fn: (page: unknown) => void): void {
  if (depth > MAX_TREE_DEPTH || budget.left <= 0) return
  forEachChild(el, (child) => {
    if (budget.left <= 0) return
    budget.left--
    if (attributeString(child, 'AXRole') === 'AXPage') fn(child)
    else forEachPage(child, depth + 1, budget, fn)
  })
}

/** page 아래의 텍스트 노드(AXStaticText)를 찾아 콜백한다. */
function forEachTextNode(el: unknown, depth: number, budget: { left: number }, fn: (node: unknown) => void): void {
  if (depth > MAX_TREE_DEPTH || budget.left <= 0) return
  forEachChild(el, (child) => {
    if (budget.left <= 0) return
    budget.left--
    if (attributeString(child, 'AXRole') === 'AXStaticText') fn(child)
    else forEachTextNode(child, depth + 1, budget, fn)
  })
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * windowId(=CGWindowID) 가 가리키는 창의 AX 요소를 찾는다 — AX 는 창 id 를 노출하지 않으므로
 * 소유 앱의 AXWindows 중 위치·크기가 CGWindow bounds 와 일치하는 것을 고른다(제목 비교는
 * 같은 문서를 여러 창으로 열면 모호해진다). 콜백 안에서만 유효한 포인터를 넘긴다.
 */
function withWindowElement<T>(windowId: number, fn: (win: unknown, bounds: Rect) => T | null): T | null {
  const bounds = getMacWindowBounds(windowId)
  const pid = getMacWindowOwnerPid(windowId)
  if (!bounds || pid === null) return null
  const appEl = AXUIElementCreateApplication!(pid)
  if (!appEl) return null
  const windows = copyAttribute(appEl, 'AXWindows')
  if (!windows) {
    release(appEl)
    return null
  }
  try {
    if (CFGetTypeID!(windows) !== CFArrayGetTypeID!()) return null
    const count = Number(CFArrayGetCount!(windows))
    let fallback: unknown = null
    for (let i = 0; i < count; i++) {
      const win = CFArrayGetValueAtIndex!(windows, i)
      if (!win) continue
      if (fallback === null) fallback = win
      const pos = attributePoint(win, 'AXPosition')
      const size = attributeSize(win, 'AXSize')
      if (!pos || !size) continue
      const near = Math.abs(pos.x - bounds.x) < 4 && Math.abs(pos.y - bounds.y) < 4
      const sameSize = Math.abs(size.width - bounds.width) < 8 && Math.abs(size.height - bounds.height) < 8
      if (near && sameSize) return fn(win, bounds)
    }
    // 일치하는 창을 못 찾으면(전체화면 전환 직후 등) 첫 창으로 폴백한다.
    return fallback ? fn(fallback, bounds) : null
  } finally {
    release(windows)
    release(appEl)
  }
}

/** readVisiblePages()의 반환값 — pages 안 AxParagraph.boundsOf 클로저가 참조하는 AX 노드는
 *  전부 retain 돼 있다(위 retain() 주석 참고). 다 쓰고 나면 반드시 release() 를 호출해
 *  짝을 맞춰야 한다 — 안 그러면 누수(그 노드가 가리키는 accessibility 객체가 이 프로세스
 *  종료까지 해제되지 않음). */
export interface AxReadResult {
  pages: AxPage[]
  release: () => void
}

/**
 * 선택된 창(미리보기)에서 지금 화면에 보이는 페이지들의 텍스트+좌표를 읽는다.
 * 좌표는 전부 창 좌상단 기준 DIP(포인트) — 오버레이가 창에 맞춰 떠 있으므로 그대로 쓸 수
 * 있다. OCR 경로(물리 픽셀)와 달리 배율 보정이 필요 없다(extractionCache.ts
 * alignWordsToOverlay 를 타지 않는 이유).
 */
export function readVisiblePages(windowId: number): AxReadResult | null {
  if (!ensureAx()) return null
  try {
    return withWindowElement(windowId, (win, bounds) => {
      const origin = { x: bounds.x, y: bounds.y }
      const windowRect: Rect = { x: 0, y: 0, width: bounds.width, height: bounds.height }
      const pages: AxPage[] = []
      const retainedNodes: unknown[] = []
      // 페이지 찾기 자체는 얕다(문서 컨테이너 바로 아래 전 페이지가 형제로 나열됨,
      // 실측: 286페이지 문서에서 한 자리 숫자 깊이) — 전체 문서 기준 예산 하나면 충분.
      const pageSearchBudget = { left: MAX_NODES_VISITED }
      forEachPage(win, 0, pageSearchBudget, (page) => {
        const pos = attributePoint(page, 'AXPosition')
        const size = attributeSize(page, 'AXSize')
        if (!pos || !size) return
        const bbox: Rect = {
          x: pos.x - origin.x,
          y: pos.y - origin.y,
          width: size.width,
          height: size.height,
        }
        // 화면 밖 페이지(연속 스크롤이라 문서 전체가 트리에 있다)는 건너뛴다 — 페이지당
        // 텍스트 노드 순회 비용이 있어서, 안 보이는 285 페이지까지 읽으면 감당이 안 된다.
        if (!intersects(bbox, windowRect)) return
        const paragraphs: AxParagraph[] = []
        // 페이지 하나의 서브트리는 (이미지 조각별 장식용 그룹 등으로) 노드 수가 페이지
        // 찾기보다 훨씬 클 수 있어(실측: 한 깊이에 300개 이상) 페이지마다 별도 예산을 준다
        // — 한 페이지가 예산을 다 써도 다른 보이는 페이지의 텍스트 탐색에 영향이 없게.
        forEachTextNode(page, 0, { left: MAX_NODES_VISITED }, (node) => {
          // node 는 부모 AXChildren 배열에서 빌려온 참조 — 그 배열은 forEachChild 가 이
          // 콜백에서 돌아오는 즉시 해제한다. AxParagraph.boundsOf 클로저는 나중에(호출부가
          // 비동기 토큰화를 마친 뒤) node 를 다시 쓰므로, 여기서 retain 해 배열 해제와
          // 무관하게 유효하도록 만든다(위 retain() 주석 — 안 하면 use-after-free 크래시).
          const retained = retain(node)
          retainedNodes.push(retained)
          const paragraph = paragraphOfTextNode(retained, origin)
          if (paragraph && paragraph.text.trim()) paragraphs.push(paragraph)
        })
        if (paragraphs.length > 0) pages.push({ bbox, paragraphs })
      })
      pages.sort((a, b) => a.bbox.y - b.bbox.y)
      return { pages, release: () => retainedNodes.forEach(release) }
    })
  } catch (err) {
    console.warn('[macAx] 페이지 읽기 실패:', (err as Error)?.message)
    return null
  }
}

/**
 * 스크롤 위치 지문 — 화면에 보이는 페이지들의 좌표만 싸게 읽어 만든다(텍스트 노드는 안
 * 건드림). 이 값이 바뀌면 스크롤/확대/창 이동으로 좌표가 전부 무효가 됐다는 뜻이라
 * 재추출이 필요하다. 전체 재추출보다 훨씬 가벼워 폴링에 쓸 수 있다.
 */
export function readScrollSignature(windowId: number): string | null {
  if (!ensureAx()) return null
  try {
    return withWindowElement(windowId, (win, bounds) => {
      const windowRect: Rect = { x: 0, y: 0, width: bounds.width, height: bounds.height }
      const parts: string[] = [`${Math.round(bounds.width)}x${Math.round(bounds.height)}`]
      forEachPage(win, 0, { left: MAX_NODES_VISITED }, (page) => {
        const pos = attributePoint(page, 'AXPosition')
        const size = attributeSize(page, 'AXSize')
        if (!pos || !size) return
        const bbox: Rect = {
          x: pos.x - bounds.x,
          y: pos.y - bounds.y,
          width: size.width,
          height: size.height,
        }
        if (!intersects(bbox, windowRect)) return
        parts.push(`${Math.round(bbox.x)},${Math.round(bbox.y)},${Math.round(bbox.width)}`)
      })
      return parts.join('|')
    })
  } catch {
    return null
  }
}

/** 접근성 권한이 없으면 AX 호출이 전부 실패한다 — 호출부가 OCR 로 폴백할지 판단하는 데 쓴다. */
export function isAxAvailable(): boolean {
  return ensureAx()
}
