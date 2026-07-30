import type { AnyLanguage, Word } from '@shared/types'
import { detectSupportedLanguage, resolveCjkLanguage } from '@shared/languageDetect'
import { segmentChineseWords } from '../nlp/chinese'
import { segmentJapaneseWords } from '../nlp/japanese'
import { getLanguageOverride } from '../settingsStore'
import { getSelectedWindowId, getSelectedWindowName } from './capture'
import { commitDirectExtraction } from './extractionCache'
import { type AxLine, readScrollSignature, readVisiblePages, isAxAvailable } from './macAx'
import { parseMacWindowId } from './macWindow'

// 담당 milleion — macOS 미리보기(Preview.app)로 연 PDF 를 OCR 없이 접근성(AX) API 로 직접
// 추출하는 경로. 화면 캡처+OCR 을 대체할 뿐, 그 뒤(오버레이 hover 박스 → 클릭 → 팝업)는
// 기존 OCR 경로와 완전히 같은 배선을 그대로 쓴다 — macAx.ts 가 만들어준 텍스트+좌표를
// OCR 결과와 동일한 `Word[]` 형태로 바꿔 extractionCache 에 넣어주면 끝이다.
//
// 단어를 어디서 끊을지(=hover 박스 하나의 단위)는 확장(브라우저) 경로와 같은 기준을 쓴다
// (사용자 요청, 2026-07-30): 라틴 문자는 공백 기준, CJK 는 형태소 분석 결과 기준. 확장은
// bridge.ts 가 같은 분석기(segmentJapaneseWords/segmentChineseWords)를 호출해 그 경계를
// 넘겨주는데, 이 경로는 앱 안이라 중간 전달 없이 직접 부른다 — 분석기가 같으므로 경계도
// 같고, 팝업의 atom 경계와도 일치한다(bridge.ts segmentAndSend 주석 참고).

/** 이 미만이면 "쓸만한 텍스트를 못 얻었다"고 보고 OCR 로 폴백한다(스캔본 PDF 등 —
 *  텍스트 레이어가 없으면 AX 트리에 AXImage 만 나와 텍스트가 거의 안 잡힌다). */
const MIN_AX_TEXT_LENGTH = 20

/** 스크롤/확대/창 이동 감지 주기 — 좌표가 통째로 무효가 되므로 감지하면 재추출한다.
 *  지문 조회(readScrollSignature)는 보이는 페이지의 좌표만 읽어서 가볍다. */
const SCROLL_POLL_MS = 400

let active = false
let polling: ReturnType<typeof setInterval> | null = null
let lastSignature: string | null = null
let extracting = false
/** startPdfAxMode 호출마다 올리는 세대값 — 비동기 추출이 끝났을 때 그 사이 모드가
 *  꺼졌거나 다시 시작됐으면 결과를 버린다(webSource.ts epoch 와 같은 패턴). */
let epoch = 0

export function isPdfAxModeActive(): boolean {
  return active
}

/** 선택된 창이 macOS 미리보기인지 — 창 이름은 "오너앱 - 창 제목"(capture.ts withOwnerName). */
export function isPreviewWindowSelected(): boolean {
  if (process.platform !== 'darwin') return false
  const name = getSelectedWindowName()
  if (!name) return false
  return /^(preview|미리보기)\b/i.test(name)
}

/** 선택된 창의 CGWindowID — AX 진입점을 만들 때 쓴다(mac 의 desktopCapturer id 는
 *  "window:7805:0" 형태라 숫자만 뽑아야 한다). */
function selectedWindowId(): number | null {
  const id = getSelectedWindowId()
  return id ? parseMacWindowId(id) : null
}

// ---- 줄 → 단어 분리 ---------------------------------------------------------

interface Token {
  text: string
  start: number
  end: number
}

/** 라틴 등 공백으로 단어가 갈리는 언어 — 공백 덩어리도 토큰으로 남긴다(공백을 버리면
 *  `text = words.map(w => w.text).join('')` 불변조건이 깨져 클릭 오프셋이 어긋난다). */
function splitBySpace(line: string): Token[] {
  const tokens: Token[] = []
  const re = /\S+|\s+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

/** CJK — 형태소 분석 경계로 자른다. 분석기가 못 덮은 구간(공백/기호 등)은 그대로 남겨
 *  역시 불변조건을 지킨다. */
async function splitByMorpheme(line: string, lang: 'ja' | 'zh-Hans' | 'zh-Hant'): Promise<Token[]> {
  const segments =
    lang === 'ja'
      ? (await segmentJapaneseWords(line)).map((t) => ({ start: t.start, end: t.end }))
      : (await segmentChineseWords(line, lang)).map((w) => ({ start: w.start, end: w.end }))
  const sorted = segments.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const tokens: Token[] = []
  let cursor = 0
  for (const seg of sorted) {
    if (seg.start < cursor) continue // 겹치는 결과는 앞선 것만 채택
    if (seg.start > cursor) tokens.push({ text: line.slice(cursor, seg.start), start: cursor, end: seg.start })
    tokens.push({ text: line.slice(seg.start, seg.end), start: seg.start, end: seg.end })
    cursor = seg.end
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), start: cursor, end: line.length })
  return tokens
}

async function tokenizeLine(line: string): Promise<Token[]> {
  const cjk = resolveCjkLanguage(line)
  if (!cjk) return splitBySpace(line)
  try {
    return await splitByMorpheme(line, cjk)
  } catch (err) {
    // 분석 실패는 치명적이지 않다 — 공백 기준으로 폴백하면 CJK 는 줄 전체가 한 덩어리가
    // 되지만(hover 단위가 커질 뿐) 좌표·텍스트 자체는 정상이다.
    console.warn('[pdfAx] 형태소 분석 실패, 공백 기준으로 폴백:', (err as Error)?.message)
    return splitBySpace(line)
  }
}

/** 줄 하나를 Word[] 로 바꾼다 — 각 단어의 bbox 는 그 단어의 문자 범위만 AX 에 다시 물어서
 *  얻는다(줄 bbox 를 글자 수로 나누는 근사가 아니라 실제 렌더 좌표). */
async function wordsOfLine(line: AxLine): Promise<Word[]> {
  const words: Word[] = []
  for (const token of await tokenizeLine(line.text)) {
    if (!token.text.trim()) {
      // 공백 토큰은 텍스트에만 남기고 좌표는 주지 않는다 — 빈 곳에 hover 박스가 뜨지
      // 않게(OCR 경로가 줄 사이에 넣는 공백/줄바꿈 Word 와 같은 취급).
      words.push({ text: token.text })
      continue
    }
    const bbox = line.boundsOf(token.start, token.text.length) ?? undefined
    words.push({ text: token.text, bbox })
  }
  return words
}

interface AxExtraction {
  text: string
  words: Word[]
  language: AnyLanguage
}

/** 화면에 보이는 페이지 전체를 읽어 OCR 결과와 같은 형태({text, words})로 만든다. */
async function extractOnce(windowId: number): Promise<AxExtraction | null> {
  const pages = readVisiblePages(windowId)
  if (!pages || pages.length === 0) return null

  const words: Word[] = []
  for (const [pageIdx, page] of pages.entries()) {
    if (pageIdx > 0) words.push({ text: '\n' }) // 페이지 경계
    for (const paragraph of page.paragraphs) {
      for (const line of paragraph) {
        const lineWords = await wordsOfLine(line)
        if (lineWords.length === 0) continue
        words.push(...lineWords)
        // 줄 끝에 항상 개행을 넣는다 — 팝업 문맥(앞뒤 N줄)이 '\n' 을 줄 경계로 쓰므로
        // (popup/selection.ts computeLineContextRange), 이게 없으면 페이지 전체가 한 줄이
        // 돼 문맥 범위가 통째로 잡힌다.
        if (!/\n$/.test(lineWords[lineWords.length - 1]!.text)) words.push({ text: '\n' })
      }
    }
  }

  const text = words.map((w) => w.text).join('')
  if (text.trim().length < MIN_AX_TEXT_LENGTH) return null
  const language = getLanguageOverride() ?? detectSupportedLanguage(text) ?? 'en'
  return { text, words, language }
}

/** 추출 → 캐시 커밋(오버레이 통지 포함). 성공하면 true. */
async function refresh(myEpoch: number, windowId: number): Promise<boolean> {
  if (extracting) return true // 이미 도는 중이면 그 결과를 그대로 쓴다(폴링이 겹치지 않게)
  extracting = true
  const startedAt = Date.now()
  try {
    const result = await extractOnce(windowId)
    if (myEpoch !== epoch) return false // 그 사이 모드가 꺼졌거나 재시작됨 — 결과 폐기
    if (!result) return false
    console.log(
      `[timing] pdf-ax 추출: ${Date.now() - startedAt}ms (${result.words.length} words, ${result.text.length} chars, ${result.language})`,
    )
    commitDirectExtraction({
      text: result.text,
      words: result.words,
      language: result.language,
      source: { kind: 'pdf' },
      extraction: 'direct',
      debugBlocks: [],
    })
    return true
  } catch (err) {
    console.error('[pdfAx] 추출 실패:', err)
    return false
  } finally {
    extracting = false
  }
}

/**
 * 선택 모드 진입 시 호출 — 미리보기 창의 텍스트를 AX 로 읽어 오버레이에 올린다.
 * 텍스트가 없거나(스캔본 PDF), 접근성 권한이 없어 AX 호출이 실패하면 onUnavailable() 로
 * 호출부(shortcut.ts)가 기존 OCR 경로로 폴백하게 한다 — webSource.ts 의
 * onInsufficientText 와 같은 역할.
 */
export function startPdfAxMode(onUnavailable: () => void): void {
  const myEpoch = ++epoch
  const windowId = selectedWindowId()
  if (!isAxAvailable() || windowId === null) {
    onUnavailable()
    return
  }
  active = true
  lastSignature = readScrollSignature(windowId)
  void refresh(myEpoch, windowId).then((ok) => {
    if (myEpoch !== epoch) return
    if (!ok) {
      stopPdfAxMode()
      onUnavailable()
      return
    }
    // 스크롤/확대/창 이동으로 좌표가 무효가 되면 다시 읽는다. 변화가 없으면 AX 호출
    // 몇 번으로 끝나므로 폴링 비용은 무시할 만하다.
    polling = setInterval(() => {
      if (!active) return
      const signature = readScrollSignature(windowId)
      if (signature === null || signature === lastSignature) return
      lastSignature = signature
      void refresh(epoch, windowId)
    }, SCROLL_POLL_MS)
  })
}

export function stopPdfAxMode(): void {
  epoch++ // 진행 중이던 추출 결과를 무효화
  if (!active) return
  active = false
  lastSignature = null
  if (polling) {
    clearInterval(polling)
    polling = null
  }
}
