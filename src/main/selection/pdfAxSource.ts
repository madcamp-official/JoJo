import type { AnyLanguage, Rect, Word } from '@shared/types'
import { detectSupportedLanguage, resolveCjkLanguage } from '@shared/languageDetect'
import { segmentCjkText } from '../nlp/segmentCjk'
import { getLanguageOverride } from '../settingsStore'
import { getSelectedWindowId, getSelectedWindowName } from './capture'
import { commitDirectExtraction } from './extractionCache'
import { type AxParagraph, readScrollSignature, readVisiblePages, isAxAvailable } from './macAx'
import { parseMacWindowId } from './macWindow'

// 담당 milleion — macOS 미리보기(Preview.app)로 연 PDF 를 OCR 없이 접근성(AX) API 로 직접
// 추출하는 경로. 화면 캡처+OCR 을 대체할 뿐, 그 뒤(오버레이 hover 박스 → 클릭 → 팝업)는
// 기존 OCR 경로와 완전히 같은 배선을 그대로 쓴다 — macAx.ts 가 만들어준 텍스트+좌표를
// OCR 결과와 동일한 `Word[]` 형태로 바꿔 extractionCache 에 넣어주면 끝이다.
//
// 단어를 어디서 끊을지(=hover 박스 하나의 단위)는 확장(브라우저) 경로와 같은 기준을 쓴다
// (사용자 요청, 2026-07-30): 라틴 문자는 공백 기준, CJK 는 형태소 분석 결과 기준. 확장은
// bridge.ts 가 그 경계를 계산해 넘겨주고, 이 경로는 앱 안이라 중간 전달 없이 직접 부른다 —
// 분할기 자체는 `nlp/segmentCjk.ts` 하나를 확장 bridge·자체 뷰어와 함께 쓰므로 경계가
// 갈릴 일이 없고, 팝업의 atom 경계와도 일치한다(segmentCjk.ts 주석 참고).

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
  // 분할 자체는 확장(자막·웹 문단)·자체 뷰어와 같은 소스를 쓴다 — 경로마다 다른 기준으로
  // 쪼개면 같은 문장인데 호버로 묶이는 단위가 갈린다(segmentCjk.ts 주석 참고).
  const segments = await segmentCjkText(line, lang)
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

/** 두 사각형이 화면상 같은 줄(가로 방향 시각적 행)에 있는지 — Y 범위가 겹치면 같은 줄로
 *  본다(shared/wordMapping.ts: groupRectsByLine 과 동일한 기준). */
function sameLine(a: Rect, b: Rect): boolean {
  return a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * 문단 하나를 Word[] 로 바꾼다. **`AXRangeForLine`이 주는 "줄" 개념은 아예 안 쓴다**
 * (macAx.ts: AxParagraph 주석 참고 — 이 PDF에서 신뢰할 수 없다고 실측 확인됨). 문단 전체
 * 텍스트를 한 번에 토큰화하고(줄 경계 때문에 단어가 쪼개지는 문제 자체가 원천적으로
 * 없어짐), 각 단어의 bbox 는 그 단어의 문자 범위만 AX 에 물어서 얻는다.
 *
 * 문단 "안"의 줄바꿈은 여기서 만들지 않는다(사용자 요청, 2026-07-31 — "줄바꿈 문단
 * 단위로 되게 해줘"): 원래 텍스트의 공백은 그대로 공백으로 남기고, 화면상 시각적 줄이
 * 바뀌는 지점이라도 팝업에는 자연스럽게 이어 붙여 보여준다(팝업 쪽 CSS 가 알아서
 * 다시 줄바꿈한다) — 실제 문단 경계('\n')는 이 문단(AX 노드) 자체가 끝나는 지점에서만,
 * 호출부(extractOnce)가 다음 문단과의 기하 관계로 판정한다.
 *
 * **중국어 PDF는 문단 텍스트 자체에 시각적 줄바꿈마다 리터럴 `\n`이 박혀 있다**(2026-07-31,
 * 사용자 제보 — "삼체 pdf에서 줄바꿈이 문단 단위가 아니라 pdf 줄바꿈 단위로 되네").
 * `DEBUG_PDF_AX_DUMP` 덤프로 확인: 三体.pdf 는 문단(AX 노드) 하나의 `AXValue` 자체가
 * `"...科幻繁华\n巨厦的情感..."`처럼 문장 중간 줄바꿈 지점에 `\n`을 그대로 포함한다
 * (The Hobbit 은 이런 임베디드 개행이 전혀 없었다 — PDF/렌더러별로 AX 가 텍스트를
 * 인코딩하는 방식이 다른 것으로 보인다). 이 개행은 문단 경계가 아니라 순수 시각적
 * 줄바꿈이라 다른 공백과 똑같이 취급해야 하는데, 위쪽(문단 "안"의 줄바꿈을 안 만든다)
 * 주석대로 여기선 아무 개행도 새로 안 만드는데도 **원본 텍스트에 이미 박혀 있는**
 * 개행은 그대로 살아남아 팝업에 문장 단위 줄바꿈으로 보였다. 모든 토큰의 출력 텍스트에서
 * 개행 문자를 무조건 제거한다 — 실제 문단 경계 개행은 `extractOnce`가 노드 "사이"에서
 * 별도로 넣으므로 이 문단 "안"의 개행만 지워도 안전하다. **공백 전용 토큰만 걸러서
 * 지우면 안 된다**(첫 시도에서 놓친 부분) — CJK 분할기가 개행 문자를 하드 경계로 안
 * 보고 앞뒤 글자와 한 토큰으로 묶어버리는 경우가 있어서("与此同时，\n科" 처럼 개행이
 * 낀 채로 한 세그먼트가 됨), `trim()`이 비어있지 않은(=글자로 보이는) 토큰에도 개행이
 * 섞여 들어올 수 있다 — bbox 조회 여부는 원본 `t.text.trim()` 기준으로 그대로 두고,
 * 출력 텍스트에서만 개행을 지운다(bbox 범위는 원본 문자 오프셋 그대로라 영향 없음).
 */
async function wordsOfParagraph(paragraph: AxParagraph): Promise<Word[]> {
  const tokens = await tokenizeLine(paragraph.text)
  return tokens.map((t) => ({
    text: t.text.replace(/\n/g, ''),
    bbox: t.text.trim() ? (paragraph.boundsOf(t.start, t.text.length) ?? undefined) : undefined,
  }))
}

/** words 안에서 bbox 를 가진 첫/마지막 단어를 찾는다(공백 토큰은 좌표가 없어서 건너뛴다). */
function firstBbox(words: Word[]): Rect | undefined {
  return words.find((w) => w.bbox)?.bbox
}
function lastBbox(words: Word[]): Rect | undefined {
  for (let i = words.length - 1; i >= 0; i--) if (words[i]!.bbox) return words[i]!.bbox
  return undefined
}

/** 들여쓰기 판정 임계값 — 첫 줄 들여쓰기는 보통 글자 크기(=한 줄 bbox 높이)의 절반
 *  이상이다. 이 책(The Hobbit) 조판은 문단 사이 빈 줄 없이 첫 줄 들여쓰기만으로 문단을
 *  구분하므로(실측 스크린샷 확인, 2026-07-31), 세로 간격이 아니라 가로 시작 위치로
 *  문단 경계를 판정해야 한다. */
const INDENT_THRESHOLD_EM = 0.5

/**
 * 문단(AX 노드) 경계에서 진짜 새 문단이 시작되는지 판정한다. AX 트리의 텍스트 노드
 * 하나가 실제로는 "문단"이 아니라 문장/구절 단위로 쪼개져 있는 경우가 있어서(실측,
 * 2026-07-31 — 문장마다 줄바꿈이 생기는 버그로 발견), 노드 경계를 곧이곧대로 문단
 * 경계로 믿을 수 없다. 대신 다음 노드의 첫 단어가:
 *  - 이전 노드의 마지막 단어와 같은 줄에 있으면(문장 중간에 노드가 쪼개진 경우) 무조건
 *    이어지는 문단이고,
 *  - 다른 줄이면, 페이지의 "보통 왼쪽 여백"보다 들여써져 있는지로 새 문단인지 판정한다
 *    (본문 줄바꿈은 여백에 딱 붙고, 새 문단 첫 줄만 들여쓰기된다).
 */
function isParagraphBreak(prev: Rect, next: Rect, pageLeftMargin: number): boolean {
  if (sameLine(prev, next)) return false
  return next.x > pageLeftMargin + next.height * INDENT_THRESHOLD_EM
}

/**
 * 지금까지 쌓은 words 가 이미 개행으로 끝나는지 — 문단 경계에 개행을 중복으로 넣지
 * 않으려고 확인한다. **`words[last].text === '\n'` 로 비교하면 안 된다**(사용자 제보,
 * 2026-07-31 — 팝업에서 문단 사이에 빈 줄이 생김): AX 가 주는 문단 텍스트(AXValue)는
 * 그 자체가 이미 개행으로 끝나는 경우가 많은데(실측: `"...richer. \n"`), 그 마지막
 * 토큰은 `" \n"`(공백+개행)이라 정확 일치 검사를 통과해버려 개행이 하나 더 붙었다.
 */
function endsWithNewline(words: Word[]): boolean {
  const last = words[words.length - 1]
  return last !== undefined && /\n\s*$/.test(last.text)
}

/** 문단(AX 노드) 경계가 이어지는 문단으로 판정됐을 때, 그 경계에 실제 공백 문자가
 *  하나도 없어서 두 노드의 텍스트가 그냥 붙어버리는 걸 막는다(예: "...middle."+"The
 *  door..."). 이미 한쪽 끝에 공백이 있으면 중복 삽입하지 않는다. */
function needsSpaceBetween(prevWords: Word[], nextWords: Word[]): boolean {
  const prevLast = prevWords[prevWords.length - 1]
  const nextFirst = nextWords[0]
  const prevEndsWithSpace = !prevLast || /\s$/.test(prevLast.text)
  const nextStartsWithSpace = !nextFirst || /^\s/.test(nextFirst.text)
  return !prevEndsWithSpace && !nextStartsWithSpace
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
  // result.pages 안 AxParagraph.boundsOf 클로저가 참조하는 AX 노드는 retain 돼 있다
  // (macAx.ts 주석 참고 — CJK 형태소 분석(아래 await)이 끝날 때까지 부모 배열 해제와
  // 무관하게 유효해야 하므로). 다 쓰고 나면 반드시 release 해서 짝을 맞춘다 — 안 하면
  // 그 AX 객체가 프로세스 종료까지 해제되지 않는다(누수).
  try {
    const words: Word[] = []
    for (const [pageIdx, page] of result.pages.entries()) {
      if (pageIdx > 0) words.push({ text: '\n' }) // 페이지 경계
      // 문단(AX 노드) 하나하나가 실제 시각적 "문단"과 일치한다고 믿을 수 없다(위
      // isParagraphBreak 주석 참고 — 문장 단위로 쪼개진 노드가 있음이 실측으로 확인됨).
      // 그래서 노드 경계마다 무조건 개행하지 않고, 페이지 전체의 "보통 왼쪽 여백"부터
      // 먼저 구해야 한다 — 여백은 노드 하나만 봐서는 알 수 없고 페이지의 모든 단어를
      // 봐야 한다.
      const paragraphWordLists = await Promise.all(page.paragraphs.map((p) => wordsOfParagraph(p)))
      const marginCandidates = paragraphWordLists.flatMap((ws) => ws.filter((w) => w.bbox).map((w) => w.bbox!.x))
      const pageLeftMargin = marginCandidates.length > 0 ? Math.min(...marginCandidates) : Infinity

      let prevWords: Word[] | null = null
      for (const curWords of paragraphWordLists) {
        if (curWords.length === 0) continue
        const last = words[words.length - 1]
        if (prevWords) {
          const prevB = lastBbox(prevWords)
          const nextB = firstBbox(curWords)
          const isBreak = prevB && nextB ? isParagraphBreak(prevB, nextB, pageLeftMargin) : true
          if (isBreak) {
            if (last && !endsWithNewline(words)) words.push({ text: '\n' })
          } else if (needsSpaceBetween(prevWords, curWords)) {
            words.push({ text: ' ' })
          }
        } else if (last && !endsWithNewline(words)) {
          words.push({ text: '\n' }) // 페이지 맨 처음 문단인데 개행이 아직 없는 경우
        }
        words.push(...curWords)
        prevWords = curWords
      }
    }
    // 문서 끝에도 개행을 남겨둔다(다음 페이지가 이어질 수도, 여기서 끝일 수도 있지만
    // 어느 쪽이든 무해).
    if (words.length > 0 && !endsWithNewline(words)) words.push({ text: '\n' })

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
              paragraphs: page.paragraphs.map((paragraph) => paragraph.text),
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
        detectedBlocks: [],
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
      detectedBlocks: [],
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
