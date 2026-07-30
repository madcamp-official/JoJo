import type { DictionaryEntry, DictionaryReading, DictionarySense } from '@shared/types'
import { BROWSER_USER_AGENT } from './httpConfig'

// 담당 ja — daijisen(デジタル大辞泉, kotobank.jp 경유) 어댑터 (PLAN.md §6 ja-1)
// 실측 근거는 DICTIONARY_SOURCES.md "daijisen" 절 참고.
//
// **소스 결정**: kotobank.jp 표제어 페이지엔 daijisen(デジタル大辞泉)/nikkokuseisen(精選版
// 日本国語大辞典) 외에도 백과사전류(sekaidaihyakka/nipponica/britannica/mypedia)·한자
// 자원사전(jitsu) 등 최대 9개 소스가 `<article class="dictype cf ...">`로 나란히 붙지만,
// 이 어댑터는 **daijisen 하나만** 채택한다 — nikkokuseisen(3단 계층·역사적 초출 인용 중심)은
// 두 사전을 합칠 때의 복잡도(parentIndex 오프셋·類語 중복 등)에 비해 이 앱의 "지금 문맥상
// 무슨 뜻인지" 판정 목적과 거리가 있어 실측만 하고 미채택 확정(2026-07-28 리네임 논의 참고).
// 나머지(백과사전/한자자원)는 gloss·품사·예문을 주는 일반 국어사전이 아니라 애초에 스코프 밖.
//
// **URL 조회**: 정확한 ID(`kotobank.jp/word/{표제어}-{ID}`)를 몰라도 `/word/{표제어}`로
// 직접 접근하면 검색 없이 정확한 ID 페이지로 자동 리다이렉트됨을 실측 확인(2026-07-28, 花/
// 食べる/犬/美しい 4개 표제어 curl 직접 검증). 존재하지 않는 표제어는 HTTP 404(실측: title
// "お探しのページは見つかりません"). **단, 리다이렉트가 모든 표기 변형을 흡수해주진 않는다**
// (2026-07-29 실측 발견): 大辞泉 표기가 오쿠리가나 괄호 생략형(【落（と）す】)인 표제어는
// URL 슬러그도 생략형(`/word/落す-453451`)이라, 표준 표기("落とす")로 접근하면 리다이렉트
// 없이 404가 난다 — 이 경우에 한해 `kotobank.jp/search?q={조회어}` 검색 결과에서 조회어의
// 오쿠리가나 생략 변형(같은 첫 글자 + 히라가나만 빠진 부분수열)에 해당하는 표제어 URL을
// 찾아 재시도한다(searchFallback, 404일 때만 — 리다이렉트가 무관한 페이지로 간 경우까지
// 검색으로 넓히면 なる→ナル류 오탐이 다시 생길 수 있어 넓히지 않는다).
//
// **동형이의 항목 처리**: 한 daijisen article 안에 `<div class="ex cf">`로 나뉘는 여러
// 하위 항목이 있을 수 있다(실측: "花" 페이지 — ①はな【花／華】(일반 단어) ②か【花】［漢字項目］
// (한자항목) ③はな【花】［曲名］(가곡 제목) 3개). 어댑터가 미리 관련성을 판단해 걸러내지 않고
// **전부** 별도 `DictionaryReading`으로 만들어 넘긴다 — 이 앱은 애초에 "사전이 후보 뜻을
// 여러 개 주면 LLM이 문맥상 맞는 걸 고른다"는 구조라(senseSelect.ts), 한자항목/곡명 같은
// 부차 항목도 후보 하나로 얹어두면 그만이다(MW 어댑터가 동형이의어(hom)를 전부 별도
// reading으로 넘기는 것과 동일 패턴). headword는 모든 항목의 한자 표기를 합집합으로 모으고,
// 각 항목의 읽기(<h3> 대괄호 앞부분)는 그 reading의 pronunciations로 채운다.
//
// **활용형 미대응**: JMdict와 마찬가지로 활용된 형태를 원형으로 자동 변환하지 않는다 —
// 표면형을 그대로 URL에 써서 조회한다(基本形 전처리는 이 어댑터 스코프 밖, main/nlp/
// japanese.ts 형태소 분석 결과가 조회 전에 이미 적용돼 있어야 함).
//
// **품사(pos) 미대응**: `<span class="hinshi">` 품사 마커가 실측상 표기 방식이 일관되지
// 않아(동사/형용사 결합 표기 차이, 명사 무표시 등, DICTIONARY_SOURCES.md 참고) 이 어댑터는
// pos/posRaw를 채우지 않는다 — 품사 판정은 방침대로 JMdict 1순위 소스에 맡긴다.
//
// **번호매김 구조**: `<b>１</b>` 같은 최상위 번호(전각 숫자 1~9, 10 이상은 반각 숫자 실측
// 확인) 아래 `㋐㋑㋒`(U+32D0~U+32FE, 가타카나 원문자) 하위 세분이 붙을 수 있다(2단 구조) —
// `DictionarySense.parentIndex`로 표현한다. 최상위 번호 중 그 자체 뜻풀이 없이 하위만 묶는
// "그룹 헤더"도 실측 확인(예: "食べる" sense 3 — `<b>３</b><br>㋐...㋑...`, ３ 자체엔 텍스트
// 없음) — 이 경우 MW sdsense 처리(merriamWebster.ts)와 같은 방침으로, 빈 부모를 억지로
// 만들지 않고 그 하위(㋐㋑)를 곧바로 parentIndex 없는 독립 sense로 승격한다.
//
// **類語(유의어)**: `[類語]（<b>N</b>）단어・단어・...` 형태로 특정 최상위 sense 번호(N)를
// 지목해 붙는다(실측: "花" → `[類語]（1）草花・生花・...`) — 그 번호에 해당하는 sense의
// `synonyms`로 붙인다. 예문(「…」)·고전 인용(〈…〉)은 각각 examples로 추출/버림.

const KOTOBANK_WORD_ENDPOINT = 'https://kotobank.jp/word'
const KOTOBANK_SEARCH_ENDPOINT = 'https://kotobank.jp/search'

export class DaijisenHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DaijisenHttpError'
  }
}

// ---- HTML 정리 -----------------------------------------------------------------

/** 태그 제거 + 엔티티 디코드. hanyu.ts(stripHanyuHtml)와 동일 방침이되, ruby 표기
 *  (`<ruby><rb>漢字</rb><rt>よみ</rt></ruby>`)는 rb(한자)만 남기고 rt(후리가나)는 버린다 —
 *  이 앱 스키마에 후리가나 전용 필드가 없어 본문 안에 별도 표기할 자리가 없기 때문. */
function stripDaijisenHtml(raw: string): string {
  let s = raw.replace(/<ruby>\s*<rb>([^<]*)<\/rb>\s*<rt>[^<]*<\/rt>\s*<\/ruby>/g, '$1')
  s = s.replace(/<[^>]*>/g, '')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** 전각 숫자(０-９) → 반각 숫자 문자열. 최상위 번호가 1~9는 전각(`１`), 10 이상은 실측상
 *  반각(`10`)으로 섞여 나와 표시 번호를 일관되게 비교하려면 정규화가 필요하다. */
function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String('０１２３４５６７８９'.indexOf(c)))
}

/** ㋐㋑㋒... 원문자(U+32D0~U+32FE, 가타카나 어원) 하위 세분 마커 판별. */
function isSubMarker(ch: string): boolean {
  const code = ch.codePointAt(0)
  return code !== undefined && code >= 0x32d0 && code <= 0x32fe
}

/** 「…」 예문 인용과 〈…〉 고전 출전을 gloss 본문에서 분리한다. 〈…〉(예: 〈古今・春下〉)는
 *  저자·출전 메타데이터라 스키마 대응 필드가 없어(汉典 고전 인용과 동일 근거, DICTIONARY_
 *  SOURCES.md 참고) 버린다.
 *
 *  「…」는 실측상 용도가 둘로 갈린다(食べる 재확인) — (1) 실제 용례문(headword 반복을
 *  "―"로 대신 표기, 예: 「生で―・べる」), (2) 정의문 안에서 다른 단어를 인용하는 상호참조
 *  (예: 「食う」「飲む」の謙譲語 — 이건 예문이 아니라 "食う/飲む의 겸양어"라는 뜻풀이 그
 *  자체). "―"(headword 대용 기호) 포함 여부로 이 둘을 가른다 — 포함하면 examples로,
 *  아니면 괄호만 벗기고 gloss 본문에 그대로 남긴다. */
function splitGlossAndExamples(text: string): { gloss: string; examples: string[] } {
  const examples: string[] = []
  let gloss = text.replace(/〈[^〉]*〉/g, '')
  gloss = gloss.replace(/「([^」]*)」/g, (_, inner) => {
    const trimmed = inner.trim()
    if (!trimmed) return ''
    if (trimmed.includes('―')) {
      examples.push(trimmed)
      return ''
    }
    return trimmed
  })
  // "⇔"(반의어 표시, 예: "幼稚園の子供⇔大人")는 원문에서 인용부호「」안에 붙어있어
  // 괄호가 붙어 있는 동안엔 괄호 자체가 시각적 구분을 해줬는데, 위에서 「」를 벗겨내면
  // 양옆 단어에 바로 들러붙어 "子供⇔大人"처럼 빽빽해 보인다(사용자 피드백, 2026-07-29) —
  // 괄호를 벗긴 뒤에도 구분이 유지되도록 앞뒤에 공백을 넣는다.
  gloss = gloss.replace(/\s*⇔\s*/g, ' ⇔ ')
  return { gloss: gloss.trim(), examples }
}

// ---- daijisen article 잘라내기 --------------------------------------------------

/** `class="dictype cf daijisen"`를 포함하는 최상위 `<article>` 블록 하나를 잘라낸다(다음
 *  `<article ... class="dictype` 시작 전까지) — hanyu.ts(extractSection)와 동일한 "최상위
 *  섹션끼리 중첩 안 됨" 전제. **주의**: 실제 마크업은 `<article itemscope itemtype="..."
 *  id="..." class="dictype cf daijisen">`처럼 `<article`과 `class=` 사이에 다른 속성이
 *  끼어 있다 — 다음 article 탐지에 `indexOf('<article class="dictype')` 같은 고정 문자열
 *  검색을 쓰면 절대 매칭이 안 돼(모든 article이 같은 속성 순서라 항상 실패) 경계를 못 찾고
 *  daijisen 이후 페이지 전체(다른 사전들+광고+관련어)를 통째로 삼켜버리는 버그가 실제로
 *  났다(실측: "花" — article 길이가 정상 19458자 대신 228181자, ex-cf 블록이 3개가 아니라
 *  21개로 잡힘) — 반드시 정규식(`<article[^>]*class="dictype`)으로 속성을 건너뛰어야 한다. */
function extractDaijisenArticle(html: string): string | null {
  const marker = 'class="dictype cf daijisen"'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return null
  const articleStart = html.lastIndexOf('<article', markerIdx)
  if (articleStart === -1) return null
  const nextArticleMatch = html.slice(markerIdx + marker.length).match(/<article[^>]*class="dictype/)
  const nextArticleIdx = nextArticleMatch?.index !== undefined ? markerIdx + marker.length + nextArticleMatch.index : -1
  return html.slice(articleStart, nextArticleIdx === -1 ? undefined : nextArticleIdx)
}

/** `<div class="ex cf">`로 나뉘는 동형이의 하위 항목 전부를 잘라낸다(위 파일 상단 주석
 *  "동형이의 항목 처리" 참고) — 조각 0번은 `<h2>` 등 article 헤더 잔여물이라 버린다.
 *  한자항목(か【花】［漢字項目］)·곡명(はな【花】［曲名］) 같은 부차 항목을 어댑터가 미리
 *  판단해 걸러내지 않고 전부 후보로 넘긴다 — 이 앱은 애초에 "사전이 후보를 주면 LLM이
 *  문맥상 맞는 걸 고른다"는 구조라(senseSelect.ts), MW 어댑터가 동형이의어(hom)를 전부
 *  별도 reading으로 넘기는 것과 동일한 방침. */
function extractEntryBlocks(articleHtml: string): string[] {
  return articleHtml.split('<div class="ex cf">').slice(1)
}

/** 오쿠리가나/복합어 경계 표시 문자 제거 — "・"(동사 어간 경계, 예: "た・べる")와
 *  "‐"(U+2010, 가타카나 복합어 경계, 실측: "サラリー‐マン"="サラリーマン") 둘 다 표시
 *  목적일 뿐 실제 표기의 일부가 아니다. 이걸 안 지우면 "サラリー‐マン"(headword) !=
 *  "サラリーマン"(조회어)가 돼 아래 관련성 확인에서 정상 항목까지 걸러진다(실측 확인). */
function stripBoundaryMarkers(s: string): string {
  return s.replace(/[・‐]/g, '')
}

interface HeadwordAndReading {
  headword: string[]
  /** 관련성 확인용 표기 변형 전체 — headword(괄호만 벗긴 표준 표기)에 더해 오쿠리가나
   *  괄호 생략형(괄호째 제거, "落（と）す"→"落す")까지 포함한다. 화면 표시(headword)와
   *  조회어 매칭(matchForms)을 분리하기 위한 필드. */
  matchForms: string[]
  reading?: string
  /** 읽기의 "・"(어간 경계) 뒤 오쿠리가나 부분("た・べる"→"べる") — 예문의 "―"(표제어
   *  대용 기호) 복원 시 어간을 계산하는 데 쓴다(restoreHeadwordPlaceholders 참고).
   *  경계가 없으면(명사 등) undefined. */
  okuriganaSuffix?: string
}

/** `<h3>` 표기에서 읽기와 한자 표기(들)를 분리한다. 대부분(예: "はな【花／華】",
 *  "た・べる【食べる】", "か【花】［漢字項目］")은 읽기+【한자】 형태지만, **가타카나
 *  외래어는 【】 표기 자체가 없다**(실측: "コンピューター（computer）" — 원어 병기가
 *  【】가 아니라 전각 괄호 （）로 붙는다, "コンピューター" 단독 조회에서 daijisen
 *  article이 실제로 있는데도 예전 코드(【】 필수)로는 이 표기를 못 뽑아 entry 전체가
 *  통째로 드롭되고 있었음). 【】가 없으면 h3 텍스트 자체를 headword로 쓰고(가타카나어는
 *  표기=읽기라 reading도 동일값), 끝에 붙는 원어 병기 괄호는 headword가 아니라 어원
 *  표시라 제거한다.
 *
 *  **오쿠리가나 괄호 생략형**(2026-07-29 실측 발견, "落とす"): 브래킷 안 표기가
 *  "落（と）す"처럼 생략 가능한 오쿠리가나를 전각 괄호로 감싼 형태일 수 있다 — 괄호만
 *  벗긴 표준 표기("落とす")를 headword(화면 표시·매칭 기본형)로 쓰고, 괄호째 지운
 *  생략형("落す", kotobank URL 슬러그가 이 표기)은 matchForms에만 추가한다. 예전엔
 *  "落（と）す"가 그대로 headword로 들어가 관련성 확인("…".includes("落とす"))에서
 *  정상 항목까지 걸러졌다. */
function extractHeadwordAndReading(entryHtml: string): HeadwordAndReading {
  const h3Match = entryHtml.match(/<h3>([\s\S]*?)<\/h3>/)
  if (!h3Match) return { headword: [], matchForms: [] }
  const text = stripDaijisenHtml(h3Match[1])

  const bracketMatch = text.match(/【([^】]*)】/)
  if (bracketMatch) {
    const headword: string[] = []
    const matchForms: string[] = []
    for (const segment of bracketMatch[1].split(/[／/]/)) {
      const cleaned = stripBoundaryMarkers(segment).trim()
      if (!cleaned) continue
      const canonical = cleaned.replace(/[（）]/g, '')
      const omitted = cleaned.replace(/（[^）]*）/g, '')
      if (canonical && !headword.includes(canonical)) headword.push(canonical)
      for (const form of [canonical, omitted]) {
        if (form && !matchForms.includes(form)) matchForms.push(form)
      }
    }
    const readingWithBoundary = text.slice(0, bracketMatch.index).trim()
    const boundaryIdx = readingWithBoundary.lastIndexOf('・')
    const okuriganaSuffix =
      boundaryIdx !== -1 ? stripBoundaryMarkers(readingWithBoundary.slice(boundaryIdx + 1)).trim() || undefined : undefined
    const readingRaw = stripBoundaryMarkers(readingWithBoundary).trim()
    return { headword, matchForms, reading: readingRaw || undefined, okuriganaSuffix }
  }

  const withoutOrigin = stripBoundaryMarkers(text.replace(/[（(][^）)]*[）)]\s*$/, '')).trim()
  const headword = withoutOrigin || stripBoundaryMarkers(text).trim()
  return headword
    ? { headword: [headword], matchForms: [headword], reading: headword }
    : { headword: [], matchForms: [] }
}

/** 예문 속 "―"(U+2015, 표제어 대용 기호)를 실제 표제어로 복원한다 — daijisen 예문은
 *  표제어 자리를 "―"로 표기하는데(명사: "わが―"=わが君, 활용어: "生で―・べる"=生で食べる),
 *  이걸 그대로 화면에 내보내면 예문에 표제어가 아예 안 보인다(실사용 피드백, 2026-07-29:
 *  君 예문 "―、一緒に行こう"). 활용어는 "―"가 표제어 전체가 아니라 **어간**(오쿠리가나
 *  앞부분)을 대신하므로, 읽기의 "・" 경계에서 얻은 오쿠리가나(okuriganaSuffix)를 headword
 *  끝에서 떼어 어간을 계산하고 "―・" 통째를 어간으로 치환한다("―・べる"→食+べる=食べる).
 *  headword가 오쿠리가나로 안 끝나면(한자만 있는 이표기 등) headword 그대로 치환. */
function restoreHeadwordPlaceholders(text: string, headword: string, okuriganaSuffix?: string): string {
  const stem =
    okuriganaSuffix && headword.endsWith(okuriganaSuffix)
      ? headword.slice(0, -okuriganaSuffix.length)
      : headword
  return text.replace(/―・?/g, stem)
}

function extractDescriptionSection(entryHtml: string): string | null {
  const m = entryHtml.match(/<section class="description">([\s\S]*?)<\/section>/)
  return m ? m[1] : null
}

// ---- sense 파싱 -----------------------------------------------------------------

interface ParsedDaijisenSenses {
  senses: DictionarySense<'ja'>[]
  synonymsByNumber: Map<number, string[]>
}

function parseDaijisenSenses(sectionHtml: string): ParsedDaijisenSenses {
  const synonymsByNumber = new Map<number, string[]>()

  // [類語]（N）단어・단어・...／（M）단어・단어・... 블록을 먼저 뽑아내 흐름에서 제거한다
  // (위 파일 상단 주석 "類語" 참고) — 남기면 sense 본문 파싱에 섞여 들어간다.
  // "類語" 라벨 자체가 실측상 평문일 때(花)와 <a> 링크일 때(食べる)가 섞여 있어 둘 다
  // 받아들이고, 한 블록 안에 "／"로 여러 sense 번호 그룹이 이어질 수 있어(食べる: (1)…／
  // (2)…) 바깥 블록을 통째로 잘라낸 뒤 안에서 번호별로 다시 나눈다.
  const cleaned = sectionHtml.replace(
    /\[(?:<a[^>]*>)?類語(?:<\/a>)?\]([\s\S]*?)(?=<br\s*\/?>|$)/g,
    (_, body: string) => {
      const groupRe = /（(?:<b>)?(\d+)(?:<\/b>)?）([\s\S]*?)(?=（(?:<b>)?\d+(?:<\/b>)?）|$)/g
      let groupMatch: RegExpExecArray | null
      while ((groupMatch = groupRe.exec(body))) {
        const words = [...groupMatch[2].matchAll(/<a[^>]*>([^<]*)<\/a>/g)]
          .map((m) => stripDaijisenHtml(m[1]))
          .filter(Boolean)
        if (words.length) synonymsByNumber.set(Number(groupMatch[1]), words)
      }
      return ''
    },
  )

  const chunks = cleaned
    .split(/<br\s*\/?>/)
    .map((c) => c.trim())
    .filter(Boolean)

  const senses: DictionarySense<'ja'>[] = []
  const topNumberToIndex = new Map<number, number>()
  let currentTopIndex: number | undefined

  const hasTopMarker = chunks.some((c) => /^<b>[0-9０-９]+<\/b>/.test(c))

  if (!hasTopMarker) {
    // 번호매김 자체가 없는 단일 뜻(예: 가곡/곡명 항목) — 통째로 sense 하나.
    const { gloss, examples } = splitGlossAndExamples(stripDaijisenHtml(cleaned))
    if (gloss) senses.push({ gloss: [gloss], examples: examples.length ? examples : undefined })
    return { senses, synonymsByNumber }
  }

  for (const chunk of chunks) {
    const topMatch = chunk.match(/^<b>([0-9０-９]+)<\/b>\s*([\s\S]*)$/)
    if (topMatch) {
      const num = Number(normalizeDigits(topMatch[1]))
      const { gloss, examples } = splitGlossAndExamples(stripDaijisenHtml(topMatch[2]))
      if (gloss) {
        // MW sdsense 처리(merriamWebster.ts)와 동일 방침 — 이 최상위 번호 자체엔 뜻풀이가
        // 있으므로 독립 sense로 등록.
        senses.push({ gloss: [gloss], examples: examples.length ? examples : undefined })
        currentTopIndex = senses.length - 1
        // first-write-wins: 犬 실측 확인(2026-07-28) — 한 표제어 안에 품사가 바뀌는
        // 여러 그룹(［名］/［接頭］ 등)이 있으면 번호가 그룹마다 1부터 다시 매겨진다.
        // [類語]는 항상 맨 처음(주 품사, 보통 명사) 그룹의 번호를 가리키므로, 이후 그룹이
        // 같은 번호를 재사용해도 먼저 채운 값을 덮어쓰지 않는다.
        if (!topNumberToIndex.has(num)) topNumberToIndex.set(num, currentTopIndex)
      } else {
        // 뜻풀이 없는 "그룹 헤더"(예: 食べる sense 3) — 빈 부모를 만들지 않고, 이어지는
        // ㋐㋑ 하위를 곧바로 parentIndex 없는 독립 sense로 승격시킨다(아래 subMatch 분기).
        currentTopIndex = undefined
        if (!topNumberToIndex.has(num)) topNumberToIndex.set(num, -1)
      }
      continue
    }

    const subMatch = chunk.match(/^([\u{32D0}-\u{32FE}])\s*([\s\S]*)$/u)
    if (subMatch && isSubMarker(subMatch[1])) {
      const { gloss, examples } = splitGlossAndExamples(stripDaijisenHtml(subMatch[2]))
      if (!gloss) continue
      if (currentTopIndex !== undefined) {
        senses.push({
          parentIndex: currentTopIndex,
          gloss: [gloss],
          examples: examples.length ? examples : undefined,
        })
      } else {
        senses.push({ gloss: [gloss], examples: examples.length ? examples : undefined })
      }
      continue
    }

    // 그 외(품사 정보 헤더, 후속 예문 인용, [補説] 등)는 이 sense의 최상위 마커 다음에
    // 이어지는 추가 줄이다 — 이미 만든 sense가 있으면 이어지는 설명/예문으로 흡수하고,
    // 없으면(첫 <b> 이전의 품사 헤더) 조용히 버린다. [補説](용법 보충 설명, 예: 食べる)는
    // gloss가 아니라 usageNote로 분리 — DictionarySense.usageNote가 정확히 이 용도다.
    if (senses.length) {
      const cleanedChunk = stripDaijisenHtml(chunk)
      const last = senses[senses.length - 1]
      const hosetsuMatch = cleanedChunk.match(/^\[補説\]\s*([\s\S]*)$/)
      if (hosetsuMatch) {
        const { gloss: note } = splitGlossAndExamples(hosetsuMatch[1])
        if (note) last.usageNote = last.usageNote ? `${last.usageNote} ${note}` : note
      } else {
        const { gloss, examples } = splitGlossAndExamples(cleanedChunk)
        if (gloss) last.gloss = [...(last.gloss ?? []), gloss]
        if (examples.length) last.examples = [...(last.examples ?? []), ...examples]
      }
    }
  }

  for (const [num, words] of synonymsByNumber) {
    const idx = topNumberToIndex.get(num)
    if (idx !== undefined && idx >= 0) senses[idx].synonyms = words
  }

  return { senses, synonymsByNumber }
}

// ---- 공개 API -------------------------------------------------------------------

export interface DaijisenLookupResult {
  entry?: DictionaryEntry<'ja'>
}

/** word 를 kotobank.jp 에서 조회한다(daijisen 소스만 채택, 위 파일 상단 주석 참고).
 *  표제어를 못 찾으면 entry 없이 빈 객체를 반환 — 다음 폴백(JMdict)으로 넘어가라는 신호.
 *  daijisen article 자체가 없거나(드묾, 실측상 daijisen 없는 페이지는 못 봤으나 방어적
 *  으로 처리) 뜻풀이를 하나도 못 뽑아도 마찬가지. HTTP 404는 곧바로 포기하지 않고 검색
 *  폴백(searchFallback — 오쿠리가나 괄호 생략형 표제어 대응, 위 파일 상단 "URL 조회" 주석
 *  참고)을 한 번 거친다. */
export async function fetchDaijisenEntry(word: string): Promise<DaijisenLookupResult> {
  const direct = await fetchDaijisenPage(`${KOTOBANK_WORD_ENDPOINT}/${encodeURIComponent(word)}`, word)
  if (direct !== 'not-found') return direct
  return searchFallback(word)
}

/** kotobank 검색(`/search?q=`) 결과에서 조회어의 오쿠리가나 생략 변형에 해당하는 표제어
 *  URL을 찾아 재시도한다 — `/word/{조회어}` 직접 접근이 404일 때만 호출된다(실측: "落とす"
 *  → 검색 결과에 `/word/落す-453451`). 검색 자체의 실패는 어차피 "여기선 못 찾음"과 같은
 *  결과라 조용히 삼키고 빈 객체를 반환한다(폴백 체인이 JMdict로 넘어감). */
async function searchFallback(word: string): Promise<DaijisenLookupResult> {
  let paths: string[]
  try {
    paths = await searchKotobankCandidatePaths(word)
  } catch (err) {
    console.warn('[daijisen] kotobank 검색 폴백 실패:', err)
    return {}
  }
  for (const path of paths.slice(0, 3)) {
    try {
      const result = await fetchDaijisenPage(`https://kotobank.jp${path}`, word)
      if (result !== 'not-found' && result.entry) return result
    } catch (err) {
      console.warn(`[daijisen] 검색 폴백 후보(${path}) 조회 실패:`, err)
    }
  }
  return {}
}

/** 검색 결과 페이지에서 `/word/{슬러그}-{ID}` 링크를 긁어, 슬러그가 조회어와 정확히
 *  같거나 오쿠리가나 생략 변형(isOkuriganaOmittedVariant)인 것만 순서 유지로 돌려준다. */
async function searchKotobankCandidatePaths(word: string): Promise<string[]> {
  const res = await fetch(`${KOTOBANK_SEARCH_ENDPOINT}?q=${encodeURIComponent(word)}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT },
  })
  if (!res.ok) {
    throw new DaijisenHttpError(res.status, `daijisen(kotobank.jp) 검색 실패: HTTP ${res.status}`)
  }
  const html = await res.text()
  const paths: string[] = []
  // 검색 결과 링크는 대부분 `#w-{ID}` 프래그먼트가 붙어 있다(실측: /word/落す-453451#w-453451)
  // — 프래그먼트는 버리고 경로만 취한다.
  for (const m of html.matchAll(/href="(\/word\/[^"#]+)(?:#[^"]*)?"/g)) {
    const path = m[1]
    if (paths.includes(path)) continue
    const slugEncoded = path.slice('/word/'.length).replace(/-\d+$/, '')
    let slug: string
    try {
      slug = decodeURIComponent(slugEncoded)
    } catch {
      continue
    }
    if (slug === word || isOkuriganaOmittedVariant(slug, word)) paths.push(path)
  }
  return paths
}

/** slug 가 word 의 오쿠리가나 생략 표기인지("落す" vs "落とす") — 첫 글자가 같고, word 에서
 *  히라가나만 몇 글자 빠진 부분수열이면 참. 검색 결과의 무관한 복합어("打落す"/"目を落とす"
 *  등)는 첫 글자 불일치·길이 초과로 자연히 걸러진다. */
function isOkuriganaOmittedVariant(slug: string, word: string): boolean {
  const slugChars = [...slug]
  const wordChars = [...word]
  if (slugChars.length >= wordChars.length) return false
  if (slugChars[0] !== wordChars[0]) return false
  let i = 0
  const omitted: string[] = []
  for (const ch of wordChars) {
    if (i < slugChars.length && slugChars[i] === ch) i++
    else omitted.push(ch)
  }
  return i === slugChars.length && omitted.every((ch) => /^[ぁ-ゖ]$/.test(ch))
}

/** 표제어 페이지 하나를 내려받아 daijisen entry 로 파싱한다 — 직접 URL 경로와 검색 폴백
 *  경로가 공유. HTTP 404 만 'not-found' 로 구분해 돌려준다(검색 폴백을 탈지 판단용). */
async function fetchDaijisenPage(url: string, word: string): Promise<DaijisenLookupResult | 'not-found'> {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_USER_AGENT } })
  if (res.status === 404) return 'not-found'
  if (!res.ok) {
    throw new DaijisenHttpError(res.status, `daijisen(kotobank.jp) 요청 실패: HTTP ${res.status}`)
  }

  const html = await res.text()
  const article = extractDaijisenArticle(html)
  if (!article) return {}

  const entryBlocks = extractEntryBlocks(article)
  if (!entryBlocks.length) return {}

  const headword: string[] = []
  const readings: DictionaryReading<'ja'>[] = []

  for (const entryBlock of entryBlocks) {
    const {
      headword: blockHeadword,
      matchForms,
      reading: readingText,
      okuriganaSuffix,
    } = extractHeadwordAndReading(entryBlock)
    if (!blockHeadword.length) continue
    // 관련성 확인(2026-07-28 실측 후 추가) — kotobank.jp의 ID 없는 리다이렉트가 항상
    // 조회어와 관련된 페이지로 가는 게 아니다: 순수 히라가나 상용 동사(예: "なる")가
    // 전혀 다른 가타카나 표제어("ナル", 발음만 같은 별개 단어로 추정)로 리다이렉트되는
    // 걸 실측 확인(반면 한자로 "成る"를 조회하면 정상적으로 동사 뜻이 나옴). 이런 경우를
    // 걸러내지 않으면 완전히 무관한 뜻을 조회어의 뜻인 것처럼 조용히 반환하게 된다(빈
    // 값을 반환해 다음 폴백으로 넘어가는 것보다 훨씬 나쁨) — MW 어댑터의 `isRelevantEntry`
    // 와 같은 목적.
    // **정확히 일치가 아니라 포함 관계로 비교**해야 한다 — 実측(水): もい〔もひ〕【▽水】
    // 처럼 희귀/방언 읽기를 나타내는 "▽" 마커(`<sup>▽</sup>`)가 브래킷 안에 붙는 표기가
    // 있는데, 이걸 정확히 일치로 비교하면 "▽水" ≠ "水"라 진짜 水의 이표기까지 잘못
    // 걸러진다 — 포함 관계("▽水".includes("水"))로 비교하면 이런 마커는 자연히 통과되고,
    // なる→ナル처럼 문자 자체가 다른 완전 별개 단어는 여전히 걸러진다. 비교 대상은
    // headword(표준 표기)가 아니라 matchForms — 오쿠리가나 괄호 생략형("落す")으로 조회된
    // 경우도 통과시키기 위함(검색 폴백 경로, extractHeadwordAndReading 주석 참고).
    if (!matchForms.some((h) => h.includes(word)) && readingText !== word) continue

    const descriptionHtml = extractDescriptionSection(entryBlock)
    if (!descriptionHtml) continue

    const { senses } = parseDaijisenSenses(descriptionHtml)
    if (!senses.length) continue

    // 예문 속 "―"(표제어 대용 기호)를 실제 표제어로 복원 — 첫 headword(주 표기)를 쓴다.
    // [補説](usageNote)에도 같은 기호가 나올 수 있어 함께 처리한다.
    for (const sense of senses) {
      if (sense.examples) {
        sense.examples = sense.examples.map((e) => restoreHeadwordPlaceholders(e, blockHeadword[0], okuriganaSuffix))
      }
      if (sense.usageNote) {
        sense.usageNote = restoreHeadwordPlaceholders(sense.usageNote, blockHeadword[0], okuriganaSuffix)
      }
    }

    for (const h of blockHeadword) if (!headword.includes(h)) headword.push(h)
    readings.push({
      pronunciations: readingText ? [{ value: readingText }] : undefined,
      senses,
    })
  }

  if (!headword.length || !readings.length) return {}

  const entry: DictionaryEntry<'ja'> = {
    language: 'ja',
    headword,
    readings,
    source: 'daijisen',
  }

  return { entry }
}
