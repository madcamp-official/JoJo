import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, Language } from '@shared/types'

// 담당 C — 汉典(zdic.net) 어댑터 (PLAN.md §6, zh-Hans 1순위 / zh-Hant 2순위(萌典 실패시) 폴백)
// 실측 근거는 DICTIONARY_SOURCES.md "汉典 (zh-Hans)" 절 참고.
//
// **엔트리 단위 폴백 — `#jbjs` → `#xxjs` → `#gyjs` 순서(2026-07-28 확정).** 표제어 페이지는
// 최대 4개 섹션(#jbjs 基本解释=한자 전용 기본 뜻풀이, #xxjs 词语解释/详细解释=단어/한자 상세
// 뜻풀이, #gyjs 国语辞典=대만 교육부 계열 데이터, #syn 近反义词=#gyjs 롤업이라 스킵)으로
// 갈린다. 최초 구현은 구조화 품질이 가장 좋다는 이유로 #gyjs만 채택했으나, **#gyjs가 실제로는
// 萌典(zh-Hant 1순위)과 같은 대만 国语辞典 데이터라 zh-Hans 1순위 소스가 대만 규범 콘텐츠를
// 쓰는 문제, 그리고 zh-Hant 폴백 체인(萌典→汉典→CC-CEDICT)에서 汉典이 萌典과 같은 원천을
// 중복으로 쓰는 문제**가 있어 뒤집혔다 — 지금은 대륙(mainland) 규범 콘텐츠인 #jbjs/#xxjs를
// 우선하고, 뜻풀이를 하나도 못 뽑을 때만 #gyjs로 폴백한다. 섹션 간 병합은 하지 않는다(같은
// sense를 서로 다른 문장으로 두 번 나열하는 문제를 피하기 위해 — 실측: `打算` 1번 뜻이 #gyjs
// "考虑思量、预先筹划"과 #xxjs "心里有个计划"로 문장은 다르지만 뜻은 같음). 이 폴백 순서의
// 트레이드오프: #jbjs/#xxjs로 확정된 엔트리는 synonyms/antonyms가 항상 undefined(이 정보는
// #gyjs에만 있고, #gyjs는 앞 두 섹션이 전부 실패했을 때만 쓰이므로).
//
// **접근**: 스크래핑, `/hans/`(간체)·`/hant/`(번체) 경로. WebFetch 도구는 실제 존재하는
// 페이지도 404를 반환했지만(문서에 기록된 현상), 일반 브라우저 User-Agent + 리다이렉트 추적
// (Node `fetch` 기본 동작)만으로 정적 SSR HTML이 200으로 온다.

export const ZDIC_BASE = 'https://www.zdic.net'
/** export하는 이유: senseSelect.ts의 출처 링크 빌더가 조회 언어별 경로(hans/hant)를
 *  그대로 재사용한다 — zdic.net 자체엔 daijisen(kotobank.jp)처럼 페이지 안에 여러
 *  하위 섹션(#jbjs/#xxjs/#gyjs)이 있지만, 실제로 어느 섹션이 채택됐는지는 이 어댑터
 *  내부 폴백 순서(파일 상단 주석 참고)에 따라 단어마다 달라 링크 빌더 쪽에서 결정할
 *  수 없다 — 그래서 섹션 앵커 없이 단어 페이지로만 연결한다. */
export const ZDIC_LANG_PATH: Record<'zh-Hans' | 'zh-Hant', string> = {
  'zh-Hans': 'hans',
  'zh-Hant': 'hant',
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export class HanyuHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HanyuHttpError'
  }
}

type ZhLanguage = 'zh-Hans' | 'zh-Hant'

// ---- HTML 정리 ---------------------------------------------------------------

/** 태그 제거 + 자주 나오는 HTML 엔티티 디코드. Wiktionary 어댑터(stripWiktionaryHtml)와
 *  동일한 "알려진 것만 처리, 나머지는 통째로 제거" 방침. #xxjs 한자 템플릿의 인라인 영어
 *  대역어(`<span class="encs">[love]</span>`)도 태그만 벗겨져 원문 뒤에 "[love]"로 남는데,
 *  무해해서 별도 처리 안 함(DICTIONARY_SOURCES.md 참고). */
function stripHanyuHtml(raw: string): string {
  let s = raw.replace(/<[^>]*>/g, '')
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

function extractByClass(block: string, className: string): string | undefined {
  const m = block.match(new RegExp(`${className}">([^<]*)<`))
  return m ? stripHanyuHtml(m[1]) : undefined
}

// ---- 품사 배지 → CanonicalPos --------------------------------------------------

/** `#gyjs`의 `gy-pos__badge`, `#xxjs` 한자 템플릿의 `xxjs-pos-badge`가 공유하는 글자셋
 *  (实측 확인, 2026-07-28) — 다음(多音) 한자 표제어(动/介/名 등)에서만 나오고, 단어/성어
 *  표제어는 이 배지 자체가 없어 pos 는 항상 undefined. `#jbjs`는 애초에 배지가 없음. */
const POS_BADGE_MAP: Record<string, CanonicalPos<ZhLanguage>> = {
  名: 'noun',
  动: 'verb',
  動: 'verb',
  形: 'adjective',
  副: 'adverb',
  代: 'pronoun',
  连: 'conjunction',
  連: 'conjunction',
  介: 'preposition',
  助: 'particle',
  叹: 'interjection',
  嘆: 'interjection',
  量: 'classifier',
}

function mapPosBadge(posRaw: string | undefined): CanonicalPos<ZhLanguage>[] | undefined {
  if (!posRaw) return undefined
  const mapped = POS_BADGE_MAP[posRaw]
  return mapped ? [mapped] : undefined
}

// ---- 공통: 최상위 섹션 잘라내기 -------------------------------------------------

/** `id="${id}"`를 포함하는 최상위 `<section class="dict-section" ...>` 블록 하나를
 *  잘라낸다(다음 `<section class="dict-section"` 시작 전까지). 최상위 섹션끼리는 중첩되지
 *  않으므로(내부 `gy-pos`/`xxjs-pos-section` 등은 class 가 달라 경계로 안 걸림) 이 방식으로
 *  충분하다. */
function extractSection(html: string, id: string): string | null {
  const marker = `id="${id}"`
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return null
  const sectionStart = html.lastIndexOf('<section', markerIdx)
  if (sectionStart === -1) return null
  const nextSectionIdx = html.indexOf('<section class="dict-section"', markerIdx + marker.length)
  return html.slice(sectionStart, nextSectionIdx === -1 ? undefined : nextSectionIdx)
}

/** `<div class="${wrapperClass}">`로 감싼 발음(拼音) 그룹을 나눈다(다음자면 여러 개) — 첫
 *  조각은 섹션 헤더 잔여물이라 버린다. `#jbjs`(jbjs-reading)/`#xxjs` 한자 템플릿(xxjs-reading)/
 *  `#gyjs`(gy-reading) 셋이 전부 이 구조를 공유한다(클래스명만 다름). */
function extractReadingBlocks(sectionHtml: string, wrapperClass: string): string[] {
  return sectionHtml.split(`<div class="${wrapperClass}">`).slice(1)
}

/** 한 발음 그룹 안에서 `<section class="${markerClass}">`(품사 배지+뜻풀이 목록)로 갈리는
 *  하위 그룹을 나눈다. 배지가 아예 없으면 조각이 1개(index 0)뿐이고 posRaw 는 undefined로
 *  남는다 — 배지가 여러 개(动/介 등)면 그만큼 조각이 나뉜다. `#gyjs`(gy-pos)와 `#xxjs` 한자
 *  템플릿(xxjs-pos-section)이 이 구조를 공유한다. */
function extractPosGroups(
  readingBlock: string,
  markerClass: string,
  badgeClass: string,
): { posRaw?: string; html: string }[] {
  return readingBlock.split(`<section class="${markerClass}">`).map((html, i) => {
    if (i === 0) return { posRaw: undefined, html }
    const badgeMatch = html.match(new RegExp(`^<span class="${badgeClass}">([^<]*)<`))
    return { posRaw: badgeMatch ? badgeMatch[1] : undefined, html }
  })
}

/** sense 하나(chunk)에서 예문/근의어/반의어를 뽑는다 — `<div class="xxjs-also">` 블록은
 *  label(`--also`=예문/`--syn`=근의어/`--ant`=반의어)로 성격이 갈린다. `#gyjs`의
 *  `gy-sense`뿐 아니라 `#xxjs` 단어 템플릿의 `xxjs-item`도 이 마크업을 공유한다(단, 실측상
 *  `#xxjs`에서 `--syn`/`--ant`가 나온 사례는 0건 — DICTIONARY_SOURCES.md 참고, 그래도 방어적
 *  으로 같이 뽑아둔다). */
function extractAlsoBlocks(chunk: string): { examples: string[]; synonyms: string[]; antonyms: string[] } {
  const examples: string[] = []
  const synonyms: string[] = []
  const antonyms: string[] = []
  const alsoBlocks = chunk.match(/<div class="xxjs-also">[\s\S]*?<\/div>/g) ?? []
  for (const block of alsoBlocks) {
    if (block.includes('xxjs-block-label--also')) {
      const textMatch = block.match(/<span class="xxjs-also__text">([\s\S]*?)<\/span>/)
      const text = textMatch ? stripHanyuHtml(textMatch[1]) : ''
      if (text) examples.push(text)
      continue
    }
    const tags = [...block.matchAll(/class="syn-tag"[^>]*>([^<]*)</g)].map((m) => stripHanyuHtml(m[1])).filter(Boolean)
    if (block.includes('xxjs-block-label--syn')) synonyms.push(...tags)
    if (block.includes('xxjs-block-label--ant')) antonyms.push(...tags)
  }
  return { examples, synonyms, antonyms }
}

// ---- #jbjs(基本解释) — 한자 전용, 가장 단순한 판본 ------------------------------

/** `li.jbjs-item` > `.jbjs-item__def`(뜻풀이) + `.jbjs-item__eg`(용례구, 선택) — 품사·
 *  근반의어·인용 전부 없음(실측 전수 확인). */
function parseJbjsItem(chunk: string): DictionarySense<ZhLanguage> | null {
  const defMatch = chunk.match(/<span class="jbjs-item__def">([\s\S]*?)<\/span>/)
  const gloss = defMatch ? stripHanyuHtml(defMatch[1]) : ''
  if (!gloss) return null

  const egMatch = chunk.match(/<span class="jbjs-item__eg">([\s\S]*?)<\/span>/)
  const example = egMatch ? stripHanyuHtml(egMatch[1]) : ''

  return {
    gloss: [gloss],
    examples: example ? [example] : undefined,
  } as DictionarySense<ZhLanguage>
}

function parseJbjsSection(sectionHtml: string): DictionaryReading<ZhLanguage>[] {
  const readings: DictionaryReading<ZhLanguage>[] = []

  for (const readingBlock of extractReadingBlocks(sectionHtml, 'jbjs-reading')) {
    const pinyin = extractByClass(readingBlock, 'jbjs-reading__py')
    const senses: DictionarySense<ZhLanguage>[] = []

    for (const item of readingBlock.split('<li class="jbjs-item').slice(1)) {
      const sense = parseJbjsItem(item)
      if (sense) senses.push(sense)
    }

    if (!senses.length) continue
    readings.push({ pronunciations: pinyin ? [{ value: pinyin }] : undefined, senses })
  }

  return readings
}

// ---- #xxjs(词语解释/详细解释) — 표제어 종류별로 템플릿이 다르다 -------------------

/** 단어/성어 템플릿(발음 그룹 래퍼 없음, `xxjs-reading-head` 단일)인지 한자 템플릿(다음자면
 *  여러 개인 `xxjs-reading` 래퍼)인지 판별 — 실측 확인(2026-07-28), 같은 섹션 id인데 표제어
 *  종류에 따라 마크업이 완전히 다르다(DICTIONARY_SOURCES.md 참고). */
function isXxjsCharTemplate(sectionHtml: string): boolean {
  return sectionHtml.includes('<div class="xxjs-reading">')
}

/** `.xxjs-item__def`(뜻풀이, 빈 문자열이면 요약용 더미 항목이라 버림 — 실측: `打算` 1번
 *  항목) + `xxjs-also`(label `--also`, 예문). `.xxjs-english`(영어 번역)는 스키마 대응 필드가
 *  없어 미반영. 한자 템플릿의 `.xxjs-citation`(고전 인용)은 def 와 형제 `<div>`라 애초에 이
 *  정규식 매칭 범위 밖 — 자연히 배제된다. */
function parseXxjsItem(chunk: string, posRaw: string | undefined): DictionarySense<ZhLanguage> | null {
  const defMatch = chunk.match(/<div class="xxjs-item__def">([\s\S]*?)<\/div>/)
  const gloss = defMatch ? stripHanyuHtml(defMatch[1]) : ''
  if (!gloss) return null

  const { examples } = extractAlsoBlocks(chunk)

  return {
    pos: mapPosBadge(posRaw),
    posRaw,
    gloss: [gloss],
    examples: examples.length ? examples : undefined,
  } as DictionarySense<ZhLanguage>
}

function extractXxjsItems(html: string): string[] {
  return html.split('<li class="xxjs-item').slice(1)
}

/** 단어/성어 템플릿: 발음 하나(`xxjs-reading-head`)에 뜻풀이 목록(`xxjs-list`) 하나가 바로
 *  붙는다 — 다음자 개념 자체가 없어 `DictionaryReading` 하나로 끝난다. */
function parseXxjsWordTemplate(sectionHtml: string): DictionaryReading<ZhLanguage>[] {
  const pinyin = extractByClass(sectionHtml, 'xxjs-reading__py')
  const senses: DictionarySense<ZhLanguage>[] = []

  for (const item of extractXxjsItems(sectionHtml)) {
    const sense = parseXxjsItem(item, undefined)
    if (sense) senses.push(sense)
  }

  if (!senses.length) return []
  return [{ pronunciations: pinyin ? [{ value: pinyin }] : undefined, senses }]
}

/** 한자 템플릿: `#jbjs`가 있는 한자는 실측상 예외 없이 이 템플릿도 갖고 있었지만(그래서
 *  `#jbjs` 우선 정책상 이 경로는 실질적으로 잘 안 밟힌다), `#jbjs`만 없는 한자가 나올 가능성에
 *  대비해 방어적으로 구현. `#gyjs`와 같은 발음 그룹→품사 배지 그룹→뜻풀이 3단 구조. */
function parseXxjsCharTemplate(sectionHtml: string): DictionaryReading<ZhLanguage>[] {
  const readings: DictionaryReading<ZhLanguage>[] = []

  for (const readingBlock of extractReadingBlocks(sectionHtml, 'xxjs-reading')) {
    const pinyin = extractByClass(readingBlock, 'xxjs-reading__py')
    const senses: DictionarySense<ZhLanguage>[] = []

    for (const group of extractPosGroups(readingBlock, 'xxjs-pos-section', 'xxjs-pos-badge')) {
      for (const item of extractXxjsItems(group.html)) {
        const sense = parseXxjsItem(item, group.posRaw)
        if (sense) senses.push(sense)
      }
    }

    if (!senses.length) continue
    readings.push({ pronunciations: pinyin ? [{ value: pinyin }] : undefined, senses })
  }

  return readings
}

function parseXxjsSection(sectionHtml: string): DictionaryReading<ZhLanguage>[] {
  return isXxjsCharTemplate(sectionHtml) ? parseXxjsCharTemplate(sectionHtml) : parseXxjsWordTemplate(sectionHtml)
}

// ---- #gyjs(国语辞典) — 대만 国语辞典 계열, 마지막 폴백 ---------------------------

/** `.gy-sense__def`(뜻풀이) + `xxjs-also`(label `--also`=예문/`--syn`=근의어/`--ant`=반의어,
 *  `.syn-tag` 링크). 고전 인용(`gy-sense__cit`, 저자·출전 포함)은 스코프 밖이라 파싱하지
 *  않는다(DICTIONARY_SOURCES.md 결정). */
function parseGyjsSense(chunk: string, posRaw: string | undefined): DictionarySense<ZhLanguage> | null {
  const defMatch = chunk.match(/<p class="gy-sense__def">([\s\S]*?)<\/p>/)
  const gloss = defMatch ? stripHanyuHtml(defMatch[1]) : ''
  if (!gloss) return null

  const examples: string[] = []
  const egMatch = chunk.match(/<span class="gy-sense__eg-text">([\s\S]*?)<\/span>/)
  if (egMatch) {
    const text = stripHanyuHtml(egMatch[1])
    if (text) examples.push(text)
  }
  const also = extractAlsoBlocks(chunk)
  examples.push(...also.examples)

  return {
    pos: mapPosBadge(posRaw),
    posRaw,
    gloss: [gloss],
    examples: examples.length ? examples : undefined,
    synonyms: also.synonyms.length ? also.synonyms : undefined,
    antonyms: also.antonyms.length ? also.antonyms : undefined,
  } as DictionarySense<ZhLanguage>
}

function parseGyjsSection(sectionHtml: string): DictionaryReading<ZhLanguage>[] {
  const readings: DictionaryReading<ZhLanguage>[] = []

  for (const readingBlock of extractReadingBlocks(sectionHtml, 'gy-reading')) {
    const pinyin = extractByClass(readingBlock, 'gy-reading__py')
    const senses: DictionarySense<ZhLanguage>[] = []

    for (const group of extractPosGroups(readingBlock, 'gy-pos', 'gy-pos__badge')) {
      for (const senseChunk of group.html.split('<div class="gy-sense">').slice(1)) {
        const sense = parseGyjsSense(senseChunk, group.posRaw)
        if (sense) senses.push(sense)
      }
    }

    if (!senses.length) continue
    readings.push({ pronunciations: pinyin ? [{ value: pinyin }] : undefined, senses })
  }

  return readings
}

// ---- 공개 API -------------------------------------------------------------

export interface HanyuLookupResult<L extends Language = Language> {
  entry?: DictionaryEntry<L>
}

/** word 를 zdic.net 에서 조회한다 — `#jbjs` → `#xxjs` → `#gyjs` 순서로 뜻풀이가 하나라도
 *  나오는 첫 섹션을 채택(엔트리 단위 폴백, 섹션 간 병합 안 함). 표제어를 못 찾으면(HTTP 404)
 *  entry 없이 빈 객체를 반환. 세 섹션 다 없거나 전부 뜻풀이를 못 뽑으면 마찬가지로 빈 객체 —
 *  다음 폴백(zh-Hant: CC-CEDICT, zh-Hans: CC-CEDICT)으로 넘어가라는 신호. */
export async function fetchHanyuEntry<L extends ZhLanguage>(word: string, language: L): Promise<HanyuLookupResult<L>> {
  const path = ZDIC_LANG_PATH[language]
  const url = `${ZDIC_BASE}/${path}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return {}
  if (!res.ok) {
    throw new HanyuHttpError(res.status, `汉典 요청 실패: HTTP ${res.status}`)
  }

  const html = await res.text()

  let readings: DictionaryReading<ZhLanguage>[] = []

  const jbjsSection = extractSection(html, 'jbjs')
  if (jbjsSection) readings = parseJbjsSection(jbjsSection)

  if (!readings.length) {
    const xxjsSection = extractSection(html, 'xxjs')
    if (xxjsSection) readings = parseXxjsSection(xxjsSection)
  }

  if (!readings.length) {
    const gyjsSection = extractSection(html, 'gyjs')
    if (gyjsSection) readings = parseGyjsSection(gyjsSection)
  }

  if (!readings.length) return {}

  const entry = {
    language,
    headword: [word],
    readings,
    source: 'hanyu-dict',
  } as DictionaryEntry<L>

  return { entry }
}
