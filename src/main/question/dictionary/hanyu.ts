import type { CanonicalPos, DictionaryEntry, DictionaryReading, DictionarySense, Language } from '@shared/types'

// 담당 C — 汉典(zdic.net) 어댑터 (PLAN.md §5, zh-Hans 1순위 / zh-Hant 2순위(萌典 실패시) 폴백)
// 실측 근거는 DICTIONARY_SOURCES.md "汉典 (zh-Hans)" 절 참고 — 단, 문서 작성 시점 이후 사이트
// 템플릿이 바뀐 것으로 보여(실측 재확인, 2026-07-28) 이 어댑터는 **현재 라이브 HTML 구조**를
// 기준으로 구현했다: 표제어 페이지는 최대 4개 섹션(#jbjs 基本解释=단일 한자 간이 뜻풀이,
// #xxjs 词语解释=단어 상세 뜻풀이, #gyjs 国语辞典=대만 교육부 계열 데이터, #syn 近反义词)으로
// 갈리는데, 이 셋 중 **#gyjs(国语辞典) 하나만 채택**한다 — 단어/한자/성어 표제어 전부에서
// 공통으로 존재함이 확인됐고(#jbjs 는 한자 표제어에만, #xxjs 는 단어 표제어에만 있어 표제어
// 종류별로 다른 파서가 필요해짐), 품사(`gy-pos__badge`)·근의어/반의어(`xxjs-also--syn`/`--ant`)가
// sense 단위로 정확히 붙어 있어 다른 두 섹션보다 구조화 품질이 높다. #syn 섹션은 #gyjs 안의
// sense별 근반의어를 표제어 전체로 합친 롤업이라 중복이라 스킵.
//
// **접근**: 스크래핑, `/hans/`(간체)·`/hant/`(번체) 경로. WebFetch 도구는 실제 존재하는
// 페이지도 404를 반환했지만(문서에 기록된 현상 재확인), 일반 브라우저 User-Agent + 리다이렉트
// 추적(Node `fetch` 기본 동작)만으로 정적 SSR HTML이 200으로 온다.

const ZDIC_BASE = 'https://www.zdic.net'
const ZDIC_LANG_PATH: Record<'zh-Hans' | 'zh-Hant', string> = {
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

// ---- HTML 정리 ---------------------------------------------------------------

/** 태그 제거 + 자주 나오는 HTML 엔티티 디코드. Wiktionary 어댑터(stripWiktionaryHtml)와
 *  동일한 "알려진 것만 처리, 나머지는 통째로 제거" 방침. */
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

// ---- gy-pos__badge → CanonicalPos --------------------------------------------

/** 실측 확인(2026-07-28, "打" 페이지): `gy-pos__badge`가 존재하는 건 다음(多音) 한자
 *  표제어(动/介/名 등)뿐 — 단어/성어 표제어(打算/结婚/一石二鸟)는 이 배지 자체가 없어
 *  pos 는 항상 undefined. 량사(量) 배지는 미확인이나 CanonicalPos 'classifier' 매핑을
 *  미리 대비해둔다. */
const POS_BADGE_MAP: Record<string, CanonicalPos<'zh-Hans' | 'zh-Hant'>> = {
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

// ---- #gyjs 섹션 파싱 -----------------------------------------------------------

/** `id="${id}"`를 포함하는 최상위 `<section class="dict-section" ...>` 블록 하나를
 *  잘라낸다(다음 `<section class="dict-section"` 시작 전까지). 최상위 섹션끼리는 중첩되지
 *  않으므로(내부 `gy-pos` 등은 class 가 달라 경계로 안 걸림) 이 방식으로 충분하다. */
function extractSection(html: string, id: string): string | null {
  const marker = `id="${id}"`
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return null
  const sectionStart = html.lastIndexOf('<section', markerIdx)
  if (sectionStart === -1) return null
  const nextSectionIdx = html.indexOf('<section class="dict-section"', markerIdx + marker.length)
  return html.slice(sectionStart, nextSectionIdx === -1 ? undefined : nextSectionIdx)
}

/** `.gy-reading` 마커로 발음(拼音) 그룹을 나눈다 — 첫 조각은 섹션 헤더 잔여물이라 버린다. */
function extractReadingBlocks(sectionHtml: string): string[] {
  return sectionHtml.split('<div class="gy-reading">').slice(1)
}

function extractPinyin(readingBlock: string): string | undefined {
  const m = readingBlock.match(/gy-reading__py">([^<]*)</)
  return m ? stripHanyuHtml(m[1]) : undefined
}

/** 한 발음(拼音) 그룹 안에서 `<section class="gy-pos">`(품사 배지+뜻풀이 목록)로 갈리는
 *  하위 그룹들을 나눈다. 배지가 아예 없는 표제어(단어/성어)는 조각이 1개(index 0)뿐이고
 *  pos 는 undefined로 남는다 — "打" 실측처럼 배지가 여러 개(动/介 등)면 그만큼 조각이 나뉜다. */
function extractPosGroups(readingBlock: string): { posRaw?: string; html: string }[] {
  return readingBlock.split('<section class="gy-pos">').map((html, i) => {
    if (i === 0) return { posRaw: undefined, html }
    const badgeMatch = html.match(/^<span class="gy-pos__badge">([^<]*)</)
    return { posRaw: badgeMatch ? badgeMatch[1] : undefined, html }
  })
}

/** `<div class="gy-sense">` 마커로 개별 뜻풀이를 나눈다(첫 조각은 헤더/배지 잔여물). 汉典은
 *  계층형 뜻 구조가 없음이 실측 확인돼(DICTIONARY_SOURCES.md 참고) 항상 평평한 목록이라
 *  `<div class="gy-sense">` 사이에 다른 `<div>`가 중첩될 일이 없어 이 분할만으로 충분하다. */
function extractSenseBlocks(posGroupHtml: string): string[] {
  return posGroupHtml.split('<div class="gy-sense">').slice(1)
}

/** 뜻풀이 하나(chunk)에서 gloss/예문/근의어/반의어를 뽑는다. 예문은 두 가지 마크업으로
 *  온다: 단어/성어 표제어는 `xxjs-also`(label `--also`, 텍스트는 `xxjs-also__text`), 한자
 *  표제어는 `gy-sense__eg`(텍스트는 `gy-sense__eg-text`) — 실측 확인(2026-07-28). 근의어/
 *  반의어는 `xxjs-also`(label `--syn`/`--ant`) 안의 `.syn-tag` 링크 텍스트만 모은다. 고전
 *  인용(`gy-sense__cit`, 저자·출전 포함)은 DICTIONARY_SOURCES.md 결정대로 스코프 밖 — 아예
 *  파싱하지 않는다. */
function parseSenseChunk(
  chunk: string,
  posRaw: string | undefined,
): DictionarySense<'zh-Hans' | 'zh-Hant'> | null {
  const defMatch = chunk.match(/<p class="gy-sense__def">([\s\S]*?)<\/p>/)
  const gloss = defMatch ? stripHanyuHtml(defMatch[1]) : ''
  if (!gloss) return null

  const examples: string[] = []
  const egMatch = chunk.match(/<span class="gy-sense__eg-text">([\s\S]*?)<\/span>/)
  if (egMatch) {
    const text = stripHanyuHtml(egMatch[1])
    if (text) examples.push(text)
  }

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

  const mappedPos = posRaw ? POS_BADGE_MAP[posRaw] : undefined
  const pos = mappedPos ? [mappedPos] : undefined

  return {
    pos,
    posRaw,
    gloss: [gloss],
    examples: examples.length ? examples : undefined,
    synonyms: synonyms.length ? synonyms : undefined,
    antonyms: antonyms.length ? antonyms : undefined,
  } as DictionarySense<'zh-Hans' | 'zh-Hant'>
}

function parseGyjsSection(sectionHtml: string): DictionaryReading<'zh-Hans' | 'zh-Hant'>[] {
  const readings: DictionaryReading<'zh-Hans' | 'zh-Hant'>[] = []

  for (const readingBlock of extractReadingBlocks(sectionHtml)) {
    const pinyin = extractPinyin(readingBlock)
    const senses: DictionarySense<'zh-Hans' | 'zh-Hant'>[] = []

    for (const group of extractPosGroups(readingBlock)) {
      for (const senseChunk of extractSenseBlocks(group.html)) {
        const sense = parseSenseChunk(senseChunk, group.posRaw)
        if (sense) senses.push(sense)
      }
    }

    if (!senses.length) continue
    readings.push({
      pronunciations: pinyin ? [{ value: pinyin }] : undefined,
      senses,
    })
  }

  return readings
}

// ---- 공개 API -------------------------------------------------------------

export interface HanyuLookupResult<L extends Language = Language> {
  entry?: DictionaryEntry<L>
}

/** word 를 zdic.net `#gyjs`(国语辞典) 섹션으로 조회한다. 표제어를 못 찾으면(HTTP 404)
 *  entry 없이 빈 객체를 반환. `#gyjs` 섹션 자체가 없거나(비표준 표제어) 뜻풀이를 하나도
 *  못 뽑으면 마찬가지로 빈 객체 — 다음 폴백(zh-Hant: 汉典→CC-CEDICT, zh-Hans: →CC-CEDICT)
 *  으로 넘어가라는 신호. */
export async function fetchHanyuEntry<L extends 'zh-Hans' | 'zh-Hant'>(
  word: string,
  language: L,
): Promise<HanyuLookupResult<L>> {
  const path = ZDIC_LANG_PATH[language]
  const url = `${ZDIC_BASE}/${path}/${encodeURIComponent(word)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return {}
  if (!res.ok) {
    throw new HanyuHttpError(res.status, `汉典 요청 실패: HTTP ${res.status}`)
  }

  const html = await res.text()
  const gyjsSection = extractSection(html, 'gyjs')
  if (!gyjsSection) return {}

  const readings = parseGyjsSection(gyjsSection)
  if (!readings.length) return {}

  const entry = {
    language,
    headword: [word],
    readings,
    source: 'hanyu-dict',
  } as DictionaryEntry<L>

  return { entry }
}
