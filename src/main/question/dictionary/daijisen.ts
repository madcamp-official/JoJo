import type { DictionaryEntry, DictionaryReading, DictionarySense } from '@shared/types'

// 담당 ja — daijisen(デジタル大辞泉, kotobank.jp 경유) 어댑터 (PLAN.md §5 ja-1)
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
// 食べる/犬/美しい 4개 표제어 curl 직접 검증) — 별도 검색 API 호출 불필요. 존재하지 않는
// 표제어는 HTTP 404(실측: title "お探しのページは見つかりません").
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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

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

/** `<h3>` 표기(예: "はな【花／華】", "た・べる【食べる】", "か【花】［漢字項目］")에서
 *  읽기(오쿠리가나 경계 표시 "・"는 제거)와 한자 표기(들)를 분리한다. */
function extractHeadwordAndReading(entryHtml: string): { headword: string[]; reading?: string } {
  const h3Match = entryHtml.match(/<h3>([\s\S]*?)<\/h3>/)
  if (!h3Match) return { headword: [] }
  const text = stripDaijisenHtml(h3Match[1])
  const bracketMatch = text.match(/【([^】]*)】/)
  if (!bracketMatch) return { headword: [] }
  const headword = bracketMatch[1]
    .split(/[／/]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const readingRaw = text.slice(0, bracketMatch.index).replace(/・/g, '').trim()
  return { headword, reading: readingRaw || undefined }
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
 *  표제어를 못 찾으면(HTTP 404) entry 없이 빈 객체를 반환 — 다음 폴백(JMdict)으로 넘어가라는
 *  신호. daijisen article 자체가 없거나(드묾, 실측상 daijisen 없는 페이지는 못 봤으나 방어적
 *  으로 처리) 뜻풀이를 하나도 못 뽑아도 마찬가지. */
export async function fetchDaijisenEntry(word: string): Promise<DaijisenLookupResult> {
  const url = `${KOTOBANK_WORD_ENDPOINT}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return {}
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
    const { headword: blockHeadword, reading: readingText } = extractHeadwordAndReading(entryBlock)
    if (!blockHeadword.length) continue

    const descriptionHtml = extractDescriptionSection(entryBlock)
    if (!descriptionHtml) continue

    const { senses } = parseDaijisenSenses(descriptionHtml)
    if (!senses.length) continue

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
