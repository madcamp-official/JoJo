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

// ---- 숫자 성조(numbered tone) → 발음 구별 부호(diacritic) 변환 --------------------

/** 한 음절의 성조 표시 모음(a/e/o/i/u/ü)별 1~4성 발음 구별 부호. 5번째 자리(경성)는
 *  부호 없이 원문자 그대로 — 배열 인덱스를 tone-1 로 바로 쓴다. */
const TONE_MARKS: Record<string, string> = {
  a: 'āáǎàa',
  e: 'ēéěèe',
  i: 'īíǐìi',
  o: 'ōóǒòo',
  u: 'ūúǔùu',
  ü: 'ǖǘǚǜü',
}

/** vowel 하나에 성조 부호를 입힌다 — 대소문자는 그 글자 자체의 대소문자를 따른다(고유
 *  명사가 통째로 대문자로 시작해도(예: "Zhong1guo2") 부호 붙는 모음 자체는 소문자인
 *  경우가 대부분이라 단어 전체가 아니라 글자 단위로 판단해야 함). */
function markVowel(vowel: string, toneIndex: number): string {
  const lower = vowel.toLowerCase()
  const marks = TONE_MARKS[lower]
  if (!marks) return vowel
  const marked = marks[toneIndex] ?? lower
  return vowel === lower ? marked : marked.toUpperCase()
}

/** CC-CEDICT 원본 음절 하나(예: "da3", "nu:3", "lu:4")를 성조 부호 표기로 바꾼다.
 *  **실측 확인(2026-07-28)**: CC-CEDICT는 ü를 "v"가 아니라 **"u:"**로 표기한다
 *  (`nu:4`=衄, `yi1 lu:4`=一律 등 원본 파일 직접 grep 확인) — 흔히 쓰이는 "v" 표기
 *  방식의 다른 로마자 입력기와 다르니 혼동 주의. 성조 부호를 놓는 모음 우선순위는
 *  표준 병음 규칙(a>e>o>나머지 i/u/ü 중 마지막 글자, 단 "iu"/"ui"는 뒤 글자) 그대로
 *  따른다. **주의(2026-07-28, 실측 재검증 중 발견)**: 'o' 체크를 "ou"부분 문자열
 *  포함 여부로만 판정하면 "guo2"(国)의 'o'를 못 찾아 대신 'u'에 부호가 붙어버리고
 *  ("gúo", 틀림), "zhong1"(中)처럼 'o'가 있어도 "ou"가 아니면 아예 부호가 안 붙는
 *  문제가 있었다 — 'o'는 "ou"에 한정하지 않고 있으면 무조건 e 다음 우선순위로
 *  잡아야 한다(guó/zhōng 둘 다 이렇게 고쳐서 해결). */
function convertPinyinSyllable(syllable: string): string {
  const m = /^([A-Za-z:]+)([1-5])$/.exec(syllable)
  if (!m) return syllable
  const [, rawLetters, toneDigit] = m
  const toneIndex = Number(toneDigit) - 1
  const letters = rawLetters.replace(/u:/g, 'ü').replace(/U:/g, 'Ü')
  if (toneIndex === 4) return letters // 경성 — 부호 없음

  const lower = letters.toLowerCase()
  let targetIdx = -1
  if (lower.includes('a')) targetIdx = lower.indexOf('a')
  else if (lower.includes('e')) targetIdx = lower.indexOf('e')
  else if (lower.includes('o')) targetIdx = lower.indexOf('o')
  else {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ('iuü'.includes(lower[i])) {
        targetIdx = i
        break
      }
    }
  }
  if (targetIdx === -1) return letters

  const chars = [...letters]
  chars[targetIdx] = markVowel(chars[targetIdx], toneIndex)
  return chars.join('')
}

/** 공백으로 이어진 음절 전체(예: "da3 suan4")를 변환한다. 숫자 성조 표기 하나가 아니라
 *  이미 발음 구별 부호가 붙은 값이 들어와도(다른 소스 재사용 등) 정규식이 매칭 안 돼
 *  그대로 통과하니 이중 변환 걱정은 없다. */
export function numberedPinyinToDiacritic(pinyin: string): string {
  return pinyin
    .split(' ')
    .map((syllable) => convertPinyinSyllable(syllable))
    .join(' ')
}

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

interface GlossSegment {
  text: string
  usageTags: { text: string; kind: UsageTagKind }[]
  domain: string[]
}

interface ParsedLine {
  /** 세그먼트 하나 = sense 하나(2026-07-28 결정) — "확定"(13개 세그먼트가 사실상 2~3개
   *  뜻의 근의어 나열인 경우)처럼 과분할되는 소스도 있지만, CC-CEDICT 원본에 세그먼트
   *  묶음을 판정할 근거(sense 번호 등)가 없어 세그먼트 하나에 여러 뜻을 억지로 모으는
   *  쪽(구버전)보다 라벨-뜻풀이 매칭 정확도를 우선한다는 방향으로 정리(사용자 결정). */
  glossSegments: GlossSegment[]
  /** 이 줄(발음) 전체에 걸리는 교차참조 — 특정 세그먼트가 아니라 표제어/발음 단위의
   *  포인터라(예: "一族" → "see also 族[zu2]") 아래에서 모든 split sense 에 동일하게
   *  복제한다(entry 최상위 라벨을 모든 sense 에 전파하는 MW `lbs` 패턴과 같은 방식). */
  seeAlso: { text: string; kind: SeeAlsoKind }[]
  /** "Taiwan pr. [...]" 로 뜻풀이 안에 파묻혀 있던 대만식 발음 — pronunciations 에 별도
   *  variety 항목으로 승격한다(문서 결정). */
  pronunciationVarieties: string[]
  isIdiom: boolean
}

function parseLine(segments: string[]): ParsedLine {
  const glossSegments: GlossSegment[] = []
  const seeAlso: { text: string; kind: SeeAlsoKind }[] = []
  const pronunciationVarieties: string[] = []
  let isIdiom = false

  for (const segment of segments) {
    // CL:(양사) 세그먼트는 표제어 전체(주로 명사 뜻 하나)에 걸리는 정보인데, 세그먼트당
    // sense 하나로 쪼개는 지금 구조에선 여러 split sense 중 어디에 붙일지 원본에 구조적
    // 근거가 없다 — 억지로 아무 sense 에나 붙이지 않고 그냥 버린다(2026-07-28, `classifiers`
    // 필드 자체를 스키마에서 제거 — shared/types.ts 참고. 이 필드는 애초에 senseSelect.ts/
    // 프롬프트 어디서도 안 읽던 미사용 필드였다).
    if (segment.startsWith('CL:')) continue

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

    const usageTags: { text: string; kind: UsageTagKind }[] = []
    const domain: string[] = []
    text = text
      .replace(KNOWN_LABEL_RE, (_, label: string) => {
        if (label === 'idiom') isIdiom = true
        else if (label in USAGE_LABELS) usageTags.push({ text: label, kind: USAGE_LABELS[label] })
        else domain.push(label)
        return ''
      })
      .replace(/\s+/g, ' ')
      .trim()

    // 라벨만 있고 실제 뜻풀이 텍스트가 안 남는 세그먼트는 그 자체로 sense 가 아니므로 버린다.
    if (text) glossSegments.push({ text, usageTags, domain })
  }

  return { glossSegments, seeAlso, pronunciationVarieties, isIdiom }
}

// ---- CedictLine → DictionaryReading ---------------------------------------------

/** 세그먼트 하나(=하나의 근원어 뜻풀이)를 sense 하나로 대응시킨다(2026-07-28 결정,
 *  이전엔 한 줄의 세그먼트 전부를 sense 하나에 합쳤었음 — 그러면 세그먼트마다 반복되는
 *  라벨이 중복 적재되고 라벨이 정확히 어느 뜻풀이에 걸리는지도 알 수 없었다). */
function lineToReading<L extends Language>(line: CedictLine): { reading: DictionaryReading<L>; isIdiom: boolean } | null {
  const parsed = parseLine(line.segments)
  if (!parsed.glossSegments.length) return null

  const pronunciations: DictionaryPronunciation[] = [{ value: numberedPinyinToDiacritic(line.pinyin) }]
  for (const taiwanPinyin of parsed.pronunciationVarieties) {
    pronunciations.push({ value: numberedPinyinToDiacritic(taiwanPinyin), variety: 'Taiwan' })
  }

  const senses = parsed.glossSegments.map(
    (seg) =>
      ({
        gloss: [seg.text],
        usageTags: seg.usageTags.length ? seg.usageTags : undefined,
        domain: seg.domain.length ? seg.domain : undefined,
        seeAlso: parsed.seeAlso.length ? parsed.seeAlso : undefined,
      }) as unknown as DictionarySense<L>,
  )

  return { reading: { pronunciations, senses }, isIdiom: parsed.isIdiom }
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
