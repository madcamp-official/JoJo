import { readFile } from 'fs/promises'
import { join } from 'path'
import type {
  DictionaryEntry,
  DictionaryPronunciation,
  DictionaryReading,
  DictionarySense,
  Language,
  SeeAlsoKind,
  UsageTagKind,
} from '@shared/types'

// 담당 zh — CC-CEDICT 로컬 번들 어댑터 (PLAN.md §5, zh-Hans 2순위/zh-Hant 3순위 —
// 汉典·萌典 실패 시 공통 폴백, 그다음은 Wiktionary). 원본은 resources/cedict.u8(MDBG
// 공개 배포, CC BY-SA 4.0) — 이 앱의 중국어 분절기(nlp/engines/chineseTokenizer.ts)가
// 이미 같은 파일을 쓰고 있어 별도 용량 증가가 없다. 네트워크 호출이 없는 로컬 파싱
// 어댑터라는 점에서 oewn.ts 와 같은 패턴.
//
// 원본 한 줄 포맷: `번체 간체 [pinyin] /뜻1/뜻2/.../` — 슬래시로 나뉜 뜻 목록 안에 실제
// 정의뿐 아니라 사용역/전문분야 라벨, 교차참조, 양사, 발음 변이(Taiwan pr.)가 전부
// 비정형 평문으로 섞여 있어, 세그먼트마다 정규식으로 분류해 스키마 필드로 라우팅한다
// (근거·실측 수치는 DICTIONARY_SOURCES.md "CC-CEDICT" 절 참고). `pos` 필드 자체가
// 원본에 없어 이 소스는 항상 undefined.

const CEDICT_PATH = join(__dirname, '../../resources/cedict.u8')

interface CedictLine {
  traditional: string
  simplified: string
  pinyin: string
  segments: string[]
}

interface CedictBundle {
  /** 번체/간체 어느 표기로 조회해도 같은 줄을 찾도록 두 표기 전부를 키로 인덱싱한다 —
   *  registry.ts 상 이 어댑터가 zh-Hans/zh-Hant 양쪽의 폴백 후보라 스크립트 판별과
   *  무관하게 한 인덱스로 커버해야 한다. 이음(異音字, 예: "行"→hang2/heng2/xing2)은
   *  같은 키에 여러 줄이 쌓인다(→ DictionaryReading[] 로 자연스럽게 대응). */
  byHeadword: Map<string, CedictLine[]>
}

let bundlePromise: Promise<CedictBundle> | null = null

const LINE_RE = /^(\S+) (\S+) \[([^\]]+)\] \/(.+)\/$/

function parseBundle(raw: string): CedictBundle {
  const byHeadword = new Map<string, CedictLine[]>()
  // MDBG 배포본이 CRLF(\r\n)로 오는 경우가 실측 확인됨(scripts/fetch-cedict.sh 로 새로
  // 받으면 \r\n, 예전에 저장소에 커밋돼 있던 사본은 LF였음) — 둘 다 지원.
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const m = LINE_RE.exec(line)
    if (!m) continue
    const [, traditional, simplified, pinyin, glossPart] = m
    const segments = glossPart
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
    const entry: CedictLine = { traditional, simplified, pinyin, segments }
    for (const key of new Set([traditional, simplified])) {
      const list = byHeadword.get(key)
      if (list) list.push(entry)
      else byHeadword.set(key, [entry])
    }
  }
  return { byHeadword }
}

/** 12만 줄 파싱은 최초 1회만 — 이후 호출은 캐시된 프라미스를 재사용한다
 *  (oewn.ts getBundle/chineseTokenizer.ts getTokenize 와 동일 패턴). */
function getBundle(): Promise<CedictBundle> {
  if (!bundlePromise) {
    bundlePromise = readFile(CEDICT_PATH, 'utf-8').then(parseBundle)
  }
  return bundlePromise
}

// ---- 세그먼트 분류 (DICTIONARY_SOURCES.md "CC-CEDICT" 절 실측/결정 그대로) -----------

/** 사용역/표기 관례 라벨 → usageTags (kind 분류는 문서의 2026-07-28 결정 표 그대로).
 *  **2026-07-28 확장**: `resources/cedict.u8`을 빈도순으로 재실측해 기존 문서 표에
 *  없던 라벨 중 의미가 명확한 것들을 추가 — `(fig.)`(비유적 표현, 1401회)/`(lit.)`
 *  (문자 그대로, 267회)/`(onom.)`(의성어, 230회)는 격식과 무관한 표기 관례라 `other`,
 *  `(Tw)`(대만식 어휘, 1277회)/`(Cantonese)`(광둥어, 69회)는 지역 방언 표시라 `dialect`,
 *  `(Internet slang)`(인터넷 신조어, 135회)는 `slang`과 같은 축이라 `register`. `(sb)`/
 *  `(sth)`는 라벨이 아니라 뜻풀이 문장 안의 문법적 자리표시자("give (sth) to (sb)")라
 *  이 목록에 넣으면 안 된다(2026-07-28 재실측 시 확인) — 절대 추가 금지. */
const USAGE_LABELS: Record<string, UsageTagKind> = {
  'coll.': 'register',
  slang: 'register',
  'derog.': 'register',
  archaic: 'register',
  literary: 'register',
  'Internet slang': 'register',
  dialect: 'dialect',
  Tw: 'dialect',
  Cantonese: 'dialect',
  loanword: 'other',
  'bound form': 'other',
  'fig.': 'other',
  'lit.': 'other',
  'onom.': 'other',
}

/** 전문분야 라벨 → domain (JMdict `field`와 동일 필드로 통합).
 *  **2026-07-28 확장**: 위와 같은 재실측으로 physics/botany/sports/geology/anatomy/
 *  music/military/linguistics/zoology(각 70~170회) 추가. */
const DOMAIN_LABELS = new Set([
  'math.',
  'computing',
  'chemistry',
  'medicine',
  'TCM',
  'Buddhism',
  'law',
  'finance',
  'physics',
  'botany',
  'sports',
  'geology',
  'anatomy',
  'music',
  'military',
  'linguistics',
  'zoology',
])

/** 알려진 라벨만 괄호째 찾아 뜻풀이 본문에서 떼어낸다 — `(bird species of China)`처럼
 *  분류가 아직 미정인 라벨(문서 참고)은 이 목록에 없으므로 건드리지 않고 그대로 둔다. */
const KNOWN_LABEL_RE = new RegExp(
  `\\((${[...Object.keys(USAGE_LABELS), ...DOMAIN_LABELS, 'idiom'].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\)`,
  'g',
)

// 괄호로 감싸 다른 정의 안에 파묻힌 형태(예: "behavior; conduct (Taiwan pr. [xing4])")와
// 세그먼트 자체가 통째로 이 표기뿐인 형태(예: "打" da2 항목의 독립 세그먼트 "Taiwan pr.
// [da3]") 둘 다 실측됨 — 괄호를 선택적으로 둔다.
const TAIWAN_PR_RE = /\(?Taiwan pr\. \[([^\]]+)\]\)?/

/** 교차참조 포인터 — 세그먼트 전체가 이 패턴 중 하나와 일치하면 gloss 가 아니라 seeAlso 로
 *  라우팅한다(문서의 kind 매핑 결정 그대로). "old variant of"/"erhua variant of"가
 *  "variant of" 보다 먼저 와야 접두어가 잘못 먼저 매치되지 않는다. */
const SEE_ALSO_PREFIXES: [RegExp, SeeAlsoKind][] = [
  [/^old variant of (.+)$/, 'variant'],
  [/^erhua variant of (.+)$/, 'dialectVariant'],
  [/^variant of (.+)$/, 'variant'],
  [/^also written (.+)$/, 'variant'],
  [/^abbr\. for (.+)$/, 'abbreviation'],
  [/^used in (.+)$/, 'usedIn'],
  [/^see also (.+)$/, 'related'],
]

interface ParsedSegments {
  gloss: string[]
  usageTags: { text: string; kind: UsageTagKind }[]
  domain: string[]
  seeAlso: { text: string; kind: SeeAlsoKind }[]
  classifiers: string[]
  /** "Taiwan pr. [...]" 로 뜻풀이 안에 파묻혀 있던 대만식 발음 — pronunciations 에 별도
   *  variety 항목으로 승격한다(문서 결정). */
  pronunciationVarieties: string[]
  isIdiom: boolean
}

function parseSegments(segments: string[]): ParsedSegments {
  const gloss: string[] = []
  const usageTags: { text: string; kind: UsageTagKind }[] = []
  const domain: string[] = []
  const seeAlso: { text: string; kind: SeeAlsoKind }[] = []
  const classifiers: string[] = []
  const pronunciationVarieties: string[] = []
  let isIdiom = false

  for (const segment of segments) {
    if (segment.startsWith('CL:')) {
      classifiers.push(
        ...segment
          .slice(3)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      continue
    }

    const pointer = SEE_ALSO_PREFIXES.find(([re]) => re.test(segment))
    if (pointer) {
      const [re, kind] = pointer
      seeAlso.push({ text: re.exec(segment)![1].trim(), kind })
      continue
    }

    let text = segment
    const taiwan = TAIWAN_PR_RE.exec(text)
    if (taiwan) {
      pronunciationVarieties.push(taiwan[1])
      text = text.replace(TAIWAN_PR_RE, '')
    }

    text = text
      .replace(KNOWN_LABEL_RE, (_, label: string) => {
        if (label === 'idiom') isIdiom = true
        else if (label in USAGE_LABELS) usageTags.push({ text: label, kind: USAGE_LABELS[label] })
        else domain.push(label)
        return ''
      })
      .replace(/\s+/g, ' ')
      .trim()

    if (text) gloss.push(text)
  }

  return {
    gloss,
    // CC-CEDICT는 라벨을 세그먼트마다 반복해서 붙인다(예: "行"(hang2) → "(bound form)
    // row; line/(bound form) line of business; .../..." — 같은 라벨이 뜻풀이 4개에
    // 나란히 붙음). 세그먼트 단위로 순회하며 뽑다 보면 그대로 중복이 쌓이므로, sense
    // 하나로 합쳐 반환하기 직전에 한 번만 걸러낸다(2026-07-28).
    usageTags: dedupBy(usageTags, (t) => `${t.kind}:${t.text}`),
    domain: [...new Set(domain)],
    seeAlso,
    classifiers,
    pronunciationVarieties,
    isIdiom,
  }
}

function dedupBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---- CedictLine → DictionaryReading ---------------------------------------------

/** CC-CEDICT 는 표제어당 sense 번호가 없는 슬래시 평문 목록이라(문서 "스키마 매핑" 절),
 *  한 줄(=한 발음)의 정의 세그먼트 전부를 sense 하나의 gloss 배열로 합친다 — 다른 소스처럼
 *  세그먼트별로 별개 sense 를 만들지 않는다. */
function lineToReading<L extends Language>(line: CedictLine): { reading: DictionaryReading<L>; isIdiom: boolean } | null {
  const parsed = parseSegments(line.segments)
  if (!parsed.gloss.length) return null

  const pronunciations: DictionaryPronunciation[] = [{ value: line.pinyin }]
  for (const taiwanPinyin of parsed.pronunciationVarieties) pronunciations.push({ value: taiwanPinyin, variety: 'Taiwan' })

  const sense = {
    gloss: parsed.gloss,
    usageTags: parsed.usageTags.length ? parsed.usageTags : undefined,
    domain: parsed.domain.length ? parsed.domain : undefined,
    seeAlso: parsed.seeAlso.length ? parsed.seeAlso : undefined,
    classifiers: parsed.classifiers.length ? parsed.classifiers : undefined,
  } as unknown as DictionarySense<L>

  return { reading: { pronunciations, senses: [sense] }, isIdiom: parsed.isIdiom }
}

export interface CcCedictLookupResult<L extends Language = Language> {
  entry?: DictionaryEntry<L>
}

/** word(번체 또는 간체 표기)를 로컬 CC-CEDICT 번들에서 조회한다. 호출부가 이미 zh-Hans/
 *  zh-Hant 스크립트를 판별해 놓은 상태(SelectionContext.language)이므로 그 언어를 그대로
 *  받아 entry 에 채운다 — wiktionary.ts 의 language 매개변수 패턴과 동일. */
export async function fetchCcCedictEntry<L extends 'zh-Hans' | 'zh-Hant'>(
  word: string,
  language: L,
): Promise<CcCedictLookupResult<L>> {
  const bundle = await getBundle()
  const lines = bundle.byHeadword.get(word)
  if (!lines?.length) return {}

  const built = lines.map((line) => lineToReading<L>(line)).filter((r): r is { reading: DictionaryReading<L>; isIdiom: boolean } => r !== null)
  if (!built.length) return {}

  const first = lines[0]
  const headword = first.traditional === first.simplified ? [first.traditional] : [first.traditional, first.simplified]
  const isIdiom = built.some((r) => r.isIdiom) || undefined

  const entry = {
    language,
    headword,
    isIdiom,
    readings: built.map((r) => r.reading),
    source: 'cc-cedict',
  } as DictionaryEntry<L>

  return { entry }
}
