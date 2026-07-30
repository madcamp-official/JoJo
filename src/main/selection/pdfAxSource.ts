import type { AnyLanguage, Word } from '@shared/types'
import { detectSupportedLanguage, resolveCjkLanguage } from '@shared/languageDetect'
import { unionRects } from '@shared/wordMapping'
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

/**
 * 선택된 Preview 창 제목에서 PDF 파일명만 뽑아낸다(사용자 요청, 2026-07-31 — 팝업 상단에
 * "PDF" 라벨과 함께 파일명도 보여달라). 창 이름은 `capture.ts: withOwnerName`이 만든
 * "Preview - <제목>" 형태이고, Preview의 창 제목 자체는 실측(TODO.md 참고)으로 확인된
 * "The Hobbit.pdf – Page 31 of 286" 처럼 "<파일명> – Page N of M"(en dash) 형태다 —
 * 앞의 소유 앱 접두사와 뒤의 페이지 표시를 벗겨내면 파일명만 남는다. 형식이 안 맞으면
 * (다른 언어 macOS 등 페이지 표시 문구가 다를 가능성) null — 호출부가 라벨 없이 "PDF"만
 * 쓰는 것으로 안전하게 폴백한다.
 */
function previewFileName(): string | null {
  const name = getSelectedWindowName()
  if (!name) return null
  const withoutOwner = name.replace(/^(preview|미리보기)\s*-\s*/i, '')
  const withoutPageSuffix = withoutOwner.replace(/\s*[–-]\s*Page\s+\d+\s+of\s+\d+\s*$/i, '')
  return withoutPageSuffix.trim() || null
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

/**
 * 화면에 보이는 페이지 전체를 읽어 OCR 결과와 같은 형태({text, words})로 만든다. 여기서는
 * 텍스트 양을 따지지 않는다 — 글자 하나만 있어도 그대로 반환한다(사용자 요청, 2026-07-30
 * — "텍스트가 적다면 그냥 그 적은 텍스트를 추출해서 걔만 호버박스 띄우면 된다"). "이 문서를
 * 통째로 direct 로 볼지 OCR 로 볼지" 판단(MIN_AX_TEXT_LENGTH 기준)은 이 함수의 일이 아니라
 * refresh() 가 최초 판정 시점에만 별도로 한다 — 그래야 이미 direct 모드로 들어온 뒤에는
 * 텍스트가 적은 페이지(예: 페이지 번호 하나)에서도 있는 만큼 호버박스가 뜬다.
 */
async function extractOnce(windowId: number): Promise<AxExtraction | null> {
  const result = readVisiblePages(windowId)
  if (!result || result.pages.length === 0) return null
  // result.pages 안 AxLine.boundsOf 클로저가 참조하는 AX 노드는 retain 돼 있다(macAx.ts
  // 주석 참고 — CJK 형태소 분석(아래 await)이 끝날 때까지 부모 배열 해제와 무관하게
  // 유효해야 하므로). 다 쓰고 나면 반드시 release 해서 짝을 맞춘다 — 안 하면 그 AX 객체가
  // 프로세스 종료까지 해제되지 않는다(누수).
  try {
    const words: Word[] = []
    for (const [pageIdx, page] of result.pages.entries()) {
      if (pageIdx > 0) words.push({ text: '\n' }) // 페이지 경계
      for (const paragraph of page.paragraphs) {
        for (const [li, line] of paragraph.entries()) {
          const lineWords = await wordsOfLine(line)
          if (lineWords.length === 0) continue
          // 이 줄이 직전 줄과 공백 없이 바로 이어지면(=AX 가 보고한 줄 경계가 단어 중간에서
          // 끊긴 것 — 실사용 확인, 2026-07-30: "pantries"가 "pantrie"/"s"로, "another"가
          // "a"/"nother"로 서로 다른 호버박스 단어로 쪼개짐) 줄 단위로 각각 토큰화하면
          // 그 단어가 두 개의 별개 단어로 갈라진다. 직전 줄의 마지막 실제 글자와 이 줄의
          // 첫 글자가 둘 다 공백이 아니면 같은 단어가 쪼개진 것으로 보고, 개행을 넣는 대신
          // 직전에 쌓아둔 마지막 토큰과 이 줄의 첫 토큰을 하나로 합친다(좌표는 두 줄에
          // 걸치므로 합집합 — 흔치 않은 경우라 완벽한 두 줄 박스보다 이 근사로 충분하다).
          // **판정 순서가 중요하다**: 개행을 "이번 줄 끝에" 넣으면 다음 줄이 이어지는지
          // 알기 전에 이미 넣어버려 병합 조건(prevWord가 실제 단어)이 항상 거짓이 된다 —
          // 그래서 개행은 "이번 줄 시작 전에, 직전 줄과의 관계를 보고" 넣는 방식으로 바꿨다.
          const prevLine = li > 0 ? paragraph[li - 1] : null
          const isWordSplit =
            prevLine !== null &&
            prevLine.text.length > 0 &&
            line.text.length > 0 &&
            !/\s/.test(prevLine.text.slice(-1)) &&
            !/\s/.test(line.text[0]!)
          const prevWord = words[words.length - 1]
          if (isWordSplit && prevWord && prevWord.text.trim() && lineWords[0]!.text.trim()) {
            words.pop()
            const first = lineWords[0]!
            words.push({
              text: prevWord.text + first.text,
              bbox:
                prevWord.bbox && first.bbox
                  ? (unionRects([prevWord.bbox, first.bbox]) ?? undefined)
                  : (prevWord.bbox ?? first.bbox),
            })
            words.push(...lineWords.slice(1))
          } else {
            // 병합 대상이 아니면(진짜 줄 경계) 직전 내용과 이 줄 사이에 개행을 넣는다 —
            // 문서/페이지 맨 처음이거나 이미 개행으로 끝난 경우(페이지 경계 등)는 중복
            // 삽입을 막는다.
            if (prevWord && prevWord.text !== '\n') words.push({ text: '\n' })
            words.push(...lineWords)
          }
        }
      }
    }
    // 문서 끝에도 개행을 남겨둔다(다음 페이지가 이어질 수도, 여기서 끝일 수도 있지만
    // 어느 쪽이든 무해) — 기존에 매 줄 끝마다 개행을 넣던 동작과 맞춘다.
    if (words.length > 0 && words[words.length - 1]!.text !== '\n') words.push({ text: '\n' })

    const text = words.map((w) => w.text).join('')
    if (!text.trim()) return null // 글자가 전혀 없음(순수 삽화 페이지 등) — 진짜 빈 결과
    const language = getLanguageOverride() ?? detectSupportedLanguage(text) ?? 'en'
    // 담당 milleion — 텍스트 누락/오인식 진단용(2026-07-30, 사용자 제보: 문장 앞부분이
    // 통째로 안 잡히거나 단어 중간 알파벳이 드문드문 빠짐). extractionCache.ts의
    // DEBUG_OCR_DUMP와 같은 패턴 — 환경변수로 지정한 디렉터리에 페이지별 원본
    // AXStaticText 값·줄 단위 분해 결과·최종 words[] 를 나란히 남겨, "AX가 원래 못
    // 주는 데이터"인지 "우리 파싱이 잘못 잘라내는지"를 구분한다.
    if (process.env.DEBUG_PDF_AX_DUMP) {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      writeFileSync(
        join(process.env.DEBUG_PDF_AX_DUMP, `pdf-ax-${Date.now()}.json`),
        JSON.stringify(
          {
            pages: result.pages.map((page) => ({
              bbox: page.bbox,
              paragraphs: page.paragraphs.map((paragraph) =>
                paragraph.map((line) => ({ text: line.text, location: line.location, bbox: line.bbox })),
              ),
            })),
            words: words.map((w) => ({ text: w.text, bbox: w.bbox ?? null })),
            text,
          },
          null,
          2,
        ),
      )
    }
    return { text, words, language }
  } finally {
    result.release()
  }
}

/**
 * 추출 → 캐시 커밋(오버레이 통지 포함).
 *
 * isInitialDecision 이 이 함수의 핵심 분기다(사용자 지적, 2026-07-30 — "PDF 파일 하나는
 * 기준이 하나였으면 좋겠는데, 텍스트 페이지 읽다가 삽화 페이지 나왔다고 OCR로 전환하면
 * 흐름이 깨진다"). 실측 결과 Preview 는 페이지를 지연 렌더링해서 화면 밖 페이지는
 * AXStaticText 자체가 없다(ax-try 하네스로 확인, 2026-07-30) — 그래서 "이 문서가
 * 텍스트 문서인가"를 모드 진입 전에 문서 전체를 미리 훑어 한 번에 결정하는 건 불가능하고,
 * 지금 눈에 보이는 화면으로만 판단할 수 있다. 이 제약 아래서 "문서당 판정 하나" 요구를
 * 최대한 만족하는 절충: **최초 진입 시 1회만** "이 화면에 텍스트가 없다"를 "이 문서는
 * direct 로 못 읽는다(스캔본 등)"로 해석해 OCR 로 폴백한다. **세션 도중(스크롤 등)**에는
 * 같은 신호("지금 화면에 텍스트 없음")를 "이 페이지는 삽화/표지처럼 원래 텍스트가 없는
 * 페이지다"로만 해석해, 문서 판정 자체는 바꾸지 않고 화면의 낡은 호버박스만 지운다 —
 * 텍스트 있는 페이지로 다시 스크롤하면 자연히 다시 채워진다.
 */
async function refresh(myEpoch: number, windowId: number, isInitialDecision: boolean): Promise<boolean> {
  if (extracting) return true // 이미 도는 중이면 그 결과를 그대로 쓴다(폴링이 겹치지 않게)
  extracting = true
  const startedAt = Date.now()
  try {
    const result = await extractOnce(windowId)
    if (myEpoch !== epoch) return false // 그 사이 모드가 꺼졌거나 재시작됨 — 결과 폐기
    // 팝업 상단에 "PDF"와 함께 파일명을 보여주려고 창 제목에서 뽑는다(사용자 요청,
    // 2026-07-31). 못 뽑아도(형식이 안 맞는 등) undefined 로 두면 PopupScreen.tsx 가
    // 파일명 없이 "PDF"만 보여주므로 안전하다.
    const fileName = previewFileName() ?? undefined
    // MIN_AX_TEXT_LENGTH 는 "이 문서를 통째로 direct 로 볼지"를 정하는 최초 판정에서만
    // 쓴다 — 페이지 번호 한둘처럼 짧은 텍스트만 있어도 이미 direct 모드로 들어온 뒤라면
    // (isInitialDecision=false) 그 적은 텍스트 그대로 호버박스를 띄운다(사용자 요청,
    // 2026-07-30 — "텍스트가 적다면 그냥 그 적은 텍스트를 추출해서 걔만 호버박스 띄우면
    // 된다"). extractOnce() 자체는 이 기준을 모른다(글자가 하나라도 있으면 항상 반환).
    if (!result || (isInitialDecision && result.text.trim().length < MIN_AX_TEXT_LENGTH)) {
      if (isInitialDecision) return false // 호출부가 OCR 폴백 여부를 결정
      // 세션 도중의 "텍스트 없음"은 문서 재판정이 아니라 이 페이지만의 특성으로 본다.
      commitDirectExtraction({
        text: '',
        words: [],
        language: getLanguageOverride() ?? 'en',
        source: { kind: 'pdf', appName: fileName },
        extraction: 'direct',
        debugBlocks: [],
      })
      return true
    }
    console.log(
      `[timing] pdf-ax 추출: ${Date.now() - startedAt}ms (${result.words.length} words, ${result.text.length} chars, ${result.language})`,
    )
    commitDirectExtraction({
      text: result.text,
      words: result.words,
      language: result.language,
      source: { kind: 'pdf', appName: fileName },
      extraction: 'direct',
      debugBlocks: [],
    })
    return true
  } catch (err) {
    console.error('[pdfAx] 추출 실패:', err)
    // 예외(AX 호출 자체가 깨짐 등)도 세션 도중이면 문서 판정을 뒤집지 않는다 — 다음 폴링
    // 때 다시 시도된다. 초기 판정에서는 실패로 보고 호출부가 OCR 로 폴백하게 한다.
    return !isInitialDecision
  } finally {
    extracting = false
  }
}

/**
 * 선택 모드 진입 시 호출 — 미리보기 창의 텍스트를 AX 로 읽어 오버레이에 올린다.
 * 최초 진입에서 텍스트가 없거나(스캔본 PDF), 접근성 권한이 없어 AX 호출이 실패하면
 * onUnavailable() 로 호출부(shortcut.ts)가 기존 OCR 경로로 폴백하게 한다 — webSource.ts 의
 * onInsufficientText 와 같은 역할. 이 판정은 문서당 한 번만 내려지고 세션 도중에는
 * 재판정하지 않는다(위 refresh() 주석 참고) — 삽화 페이지로 스크롤해도 OCR 로 전환되지
 * 않고, 그 페이지에 호버박스가 없을 뿐 계속 direct 모드로 남는다.
 *
 * `treatMissingTextAsFailure=false`(shortcut.ts의 수동 "텍스트 추출로 전환" 토글 전용)면
 * 첫 화면에 텍스트가 없어도 실패로 보지 않는다 — 사용자가 명시적으로 direct 모드를
 * 요청한 것이므로, 텍스트가 없으면 그냥 호버박스 없이 대기하고 조용히 OCR 로 넘어가지
 * 않는다(사용자 요청, 2026-07-30 — "조용히 OCR로 넘어가면 안 돼, 텍스트 없으면 그냥
 * 호버박스만 안 띄우면 돼"). AX 자체가 안 되는 경우(권한 없음/대상 창 정보 없음)는 이
 * 옵션과 무관하게 항상 onUnavailable 을 호출한다 — "텍스트 없음"과 달리 대안이 없다.
 */
export function startPdfAxMode(onUnavailable: () => void, opts?: { treatMissingTextAsFailure?: boolean }): void {
  const treatMissingTextAsFailure = opts?.treatMissingTextAsFailure ?? true
  // 이전 세션의 폴링 타이머가 남아있으면(모드를 껐다 바로 다시 켠 경우 등) 먼저 정리한다
  // — stopPdfAxMode() 는 호출 시점에 active 였을 때만 clearInterval 하므로, 그 전에
  // 놓친 타이머가 있으면 `active` 가드로 조용히 no-op 만 반복하며 영원히 살아있었다.
  if (polling) {
    clearInterval(polling)
    polling = null
  }
  const myEpoch = ++epoch
  const windowId = selectedWindowId()
  if (!isAxAvailable() || windowId === null) {
    onUnavailable()
    return
  }
  active = true
  lastSignature = readScrollSignature(windowId)
  void refresh(myEpoch, windowId, treatMissingTextAsFailure).then((ok) => {
    if (myEpoch !== epoch) return
    if (!ok) {
      stopPdfAxMode()
      onUnavailable()
      return
    }
    // 스크롤/확대/창 이동으로 좌표가 무효가 되면 다시 읽는다 — 문서 판정을 다시 하는 게
    // 아니라 화면에 맞게 단어/좌표만 갱신한다(위 refresh() isInitialDecision=false 분기).
    // 변화가 없으면 AX 호출 몇 번으로 끝나므로 폴링 비용은 무시할 만하다.
    polling = setInterval(() => {
      if (!active) return
      const signature = readScrollSignature(windowId)
      if (signature === null || signature === lastSignature) return
      lastSignature = signature
      void refresh(myEpoch, windowId, false)
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
