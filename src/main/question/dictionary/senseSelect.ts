import type { CanonicalPos, DictionaryEntry, DictionarySourceId, Language, UsageTag } from '@shared/types'
import { merriamWebsterToIpa } from './merriamWebsterToIpa'
import { WIKTIONARY_LANG_NAME } from './wiktionary'

/** kotobank.jp의 사전 섹션(`<article id="...">`)은 그 사전명(예: "デジタル大辞泉")을 UTF-8
 *  바이트의 hex를 점(.)으로 이어붙인 값을 id로 쓴다(실측 확인: "花" 페이지의 daijisen
 *  article id가 정확히 이 인코딩과 일치) — 그대로 URL 뒤에 앵커로 붙이면 그 사전 섹션으로
 *  바로 스크롤된다(한 표제어 페이지에 daijisen 앞에 다른 사전이 여러 개 있어도 건너뜀).
 *  개별 뜻풀이 번호(`<b>1</b>` 등)에는 id가 없어 "몇 번 뜻으로 바로 스크롤"까지는 이
 *  사이트 마크업상 불가능 — 섹션 단위 점프까지만 된다. */
function kotobankSectionAnchor(sectionLabel: string): string {
  return [...Buffer.from(sectionLabel, 'utf-8')].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('.')
}

// 담당 B — 사전 뜻(sense) 번호 매기기 + LLM 판정/번역 결과 서식화 (PLAN.md §4.2-2)
// DictionaryEntry[] 를 LLM 프롬프트에 넣을 번호 매긴 평면 목록으로 바꾸고, LLM 은 문맥에
// 맞는 번호를 고른 뒤 그 뜻풀이·예문을 한국어로 번역한다(PLAN.md §5: "사전 API는 원어
// 뜻 목록만 제공, 한국어 설명·번역은 LLM이 담당"). pos 라벨·출처처럼 번역이 필요 없는
// 나머지는 여기서 사전 데이터를 그대로 서식화한다.

export interface NumberedSense {
  index: number
  /** 이 sense가 다른 sense의 더 좁은 하위 구분일 때, 그 부모 sense의 (평면화된) index를
   *  가리킨다(2026-07-28 신설 — DictionarySense.parentIndex를 LLM이 실제로 쓸 수 있게
   *  노출). 원본 DictionarySense.parentIndex는 같은 reading.senses 배열 안에서의 원본
   *  위치(0-based)를 가리키는데, 여기서는 그걸 numberSenses가 새로 매긴 index로 변환해
   *  담는다 — 그래야 buildSenseListText가 평평한 목록에서도 "몇 번의 하위 뜻"인지 그대로
   *  표시할 수 있다(부모가 gloss 없는 그룹 헤더라 목록에서 빠진 경우는 undefined). */
  parentIndex?: number
  headword: string
  pos?: CanonicalPos[]
  posRaw?: string
  /** 발음 표기(들) — 한 표제어에 발음이 여러 개인 소스가 있어(OEWN 지역별 variety, Wiktionary
   *  raw wikitext에서 뽑는 ja 이독/zh 이음자 등, 2026-07-28) 배열로 둔다. 첫 값만 쓰던
   *  이전 방식은 `reading.pronunciations`가 배열인 스키마 설계 의도를 못 살렸었음. */
  pronunciations?: string[]
  irregularForms?: string[]
  transitive?: boolean
  definite?: boolean
  gloss: string[]
  examples?: string[]
  usageTags?: UsageTag[]
  usageNote?: string
  isIdiom?: boolean
}

/** L 을 구체 언어로 받아야(제네릭 그대로 두면 DictionaryEntry 가 4개 언어 유니온이라
 *  sense.irregularForms 같은 언어 전용 필드에 TS 가 접근을 막는다 — shared/types.ts
 *  DictionaryEntry<L> 주석 참고) — 호출부가 DictionaryEntry<'en'>[] 처럼 구체 타입을
 *  넘기면 L 이 그걸로 추론되면서 아래 sense.irregularForms 접근이 안전해진다. */
export function numberSenses<L extends Language>(entries: DictionaryEntry<L>[]): NumberedSense[] {
  const out: NumberedSense[] = []
  let index = 1
  for (const entry of entries) {
    const headword = entry.headword[0]
    for (const reading of entry.readings) {
      const values = reading.pronunciations?.map((p) => p.value)
      const pronunciations = values?.length ? values : undefined
      // reading.senses 안에서의 원본 위치(position) → numberSenses 가 새로 매긴 index.
      // sense.parentIndex(원본 position 기준)를 이 배열로 찾아 "평면화된 목록에서의
      // 부모 index"로 변환한다 — 그룹 헤더(gloss 없어 스킵됨)를 가리키면 undefined 로 빠짐.
      const displayIndexByPosition: (number | undefined)[] = []
      reading.senses.forEach((sense, position) => {
        // gloss 없는 sense 는 하위 구분을 위한 그룹 헤더일 뿐 그 자체로는 선택 가능한
        // 뜻풀이가 아니다(shared/types.ts DictionarySenseGloss 참고) — LLM 판정 목록에서 제외한다.
        if (!sense.gloss) return
        const displayIndex = index++
        displayIndexByPosition[position] = displayIndex
        out.push({
          index: displayIndex,
          parentIndex: sense.parentIndex !== undefined ? displayIndexByPosition[sense.parentIndex] : undefined,
          headword,
          pos: sense.pos,
          posRaw: sense.posRaw,
          pronunciations,
          irregularForms: 'irregularForms' in sense ? sense.irregularForms : undefined,
          transitive: 'transitive' in sense ? sense.transitive : undefined,
          definite: 'definite' in sense ? sense.definite : undefined,
          gloss: sense.gloss,
          examples: sense.examples,
          usageTags: sense.usageTags,
          usageNote: sense.usageNote,
          isIdiom: entry.isIdiom,
        })
      })
    }
  }
  return out
}

/** LLM 프롬프트의 사용자 메시지에 넣을, 번호 매긴 뜻풀이 후보 목록(원어 그대로).
 *  예문이 여러 개인 경우(MW 실측: 한 뜻에 최대 4개까지) 전부 나열한다 — 첫 번째만
 *  보여주면 LLM 이 나머지 예문의 존재 자체를 몰라 번역 대상에서 빠진다. */
export function buildSenseListText(senses: NumberedSense[]): string {
  return senses
    .map((s) => {
      // transitive/definite 가 있으면(MW def.vd/fl 실측: "run"처럼 타동/자동사로 def
      // 블록이 갈리거나, "the"/"a" 처럼 정관사/부정관사가 구분되는 경우) 품사 라벨 자체를
      // 대체한다 — "동사 (타동사)"처럼 병기하지 않는다(사용자 요청, 2026-07-28). 둘 다
      // undefined 인 소스(OEWN/Wiktionary 등 구조화된 구분이 없는 경우)는 그냥 원래
      // 라벨("관사" 등)로 폴백된다.
      const label =
        s.transitive === true
          ? '타동사'
          : s.transitive === false
            ? '자동사'
            : s.definite === true
              ? '정관사'
              : s.definite === false
                ? '부정관사'
                : (s.posRaw ?? s.pos?.join('/'))
      const tag = label ? `[${label}] ` : ''
      const gloss = s.gloss.join('; ')
      const ex = s.examples?.length ? ` (예: ${s.examples.map((e) => `"${e}"`).join(' / ')})` : ''
      // parentIndex(2026-07-28 신설) — MW sdsense/daijisen(デジタル大辞泉) ①②③→㋐㋑㋒
      // 번호매김처럼 이
      // 뜻이 다른 뜻의 "더 좁은 하위 구분"일 때, 평평한 번호 목록에서도 그 관계가
      // LLM에 그대로 보이게 괄호로 표시한다(부모가 그룹 헤더라 목록에서 빠졌으면 undefined
      // 라 표시 안 함). 이게 없으면 하위 정의가 그냥 "또 다른 뜻 하나"로 보여 LLM이 원래
      // 뜻과의 좁은/넓은 관계를 알 수 없었다.
      const parentNote = s.parentIndex !== undefined ? `(${s.parentIndex}번의 더 좁은 의미) ` : ''
      return `${s.index}. ${parentNote}${tag}${gloss}${ex}`
    })
    .join('\n')
}

export interface SelectedSense {
  sense: NumberedSense
  /** LLM 이 문맥에 맞게 자연스러운 한국어로 옮긴 뜻풀이 */
  translatedGloss: string
  /** sense.examples 와 같은 순서 · 같은 개수로 대응하는 번역(원문 예문이 있었을 때만) */
  translatedExamples?: string[]
}

/** LLM 응답에서 "번호: N\n번역: ...\n예문번역: ..." 블록(들, "---" 로 구분)을 파싱한다.
 *  "번호: 0"(해당 없음)이나 파싱 실패 블록, 목록에 없는 번호는 조용히 걸러낸다. */
/** 대응어를 뜻풀이 번역과 나란히 보여줄지 정하는 기준 — 대응어 길이가 뜻풀이 번역
 *  길이의 이 비율을 넘으면(즉 뜻풀이를 다른 말로 살짝 바꿔 쓴 것에 가까우면) 대응어를
 *  버리고 뜻풀이 번역만 보여준다. LLM에게 "길이가 비슷하면 생략하라"고 프롬프트로
 *  지시해봤지만 실측 결과(2026-07-28, "close"(동사) "운영을 중단하다 — 운영을 멈추다"
 *  사례) 일관되게 지켜지지 않아, 결정론적인 로컬 로직으로 옮겼다. */
const COUNTERPART_LENGTH_RATIO_THRESHOLD = 0.7

function combineTranslation(counterpart: string | undefined, glossTranslation: string): string {
  if (!counterpart) return glossTranslation
  const ratio = counterpart.length / glossTranslation.length
  if (ratio > COUNTERPART_LENGTH_RATIO_THRESHOLD) return glossTranslation
  return `${counterpart} — ${glossTranslation}`
}

export function parseJudgeReply(reply: string, senses: NumberedSense[]): SelectedSense[] {
  const byIndex = new Map(senses.map((s) => [s.index, s]))
  const out: SelectedSense[] = []
  for (const block of reply.split(/\n?-{3,}\n?/)) {
    const numMatch = block.match(/번호\s*[:：]\s*(\d+)/)
    const glossMatch = block.match(/번역\s*[:：]\s*(.+)/)
    if (!numMatch || !glossMatch) continue
    const index = Number(numMatch[1])
    if (index === 0) continue
    const sense = byIndex.get(index)
    if (!sense) continue
    const counterpartMatch = block.match(/대응어\s*[:：]\s*(.+)/)
    const exampleMatch = block.match(/예문\s*번역\s*[:：]\s*(.+)/)
    // 예문이 여러 개면 " / " 로 구분해 한 줄에 담아 달라고 프롬프트에서 요청한다 —
    // sense.examples 와 순서·개수가 같다고 가정하고 그대로 index 로 대응시킨다.
    // LLM 이 프롬프트 지시를 무시하고 대괄호/따옴표를 붙여서 줄 때가 있어(실측 확인,
    // 2026-07-28 "this" → `["이 책은 내 것이다" / "오늘 아침 일찍"]`) 세그먼트마다
    // 감싸는 대괄호·따옴표를 벗겨내는 방어 로직을 둔다.
    const translatedExamples = exampleMatch?.[1]
      ?.split(' / ')
      .map((s) => s.trim().replace(/^[[\]"'“”]+|[[\]"'“”]+$/g, '').trim())
      .filter(Boolean)
    out.push({
      sense,
      translatedGloss: combineTranslation(counterpartMatch?.[1]?.trim(), glossMatch[1].trim()),
      translatedExamples,
    })
  }
  return out
}

const SOURCE_LABELS: Record<DictionarySourceId, string> = {
  'merriam-webster': 'Merriam-Webster',
  wordnet: 'OEWN (Open English WordNet)',
  wiktionary: 'Wiktionary',
  daijisen: 'デジタル大辞泉',
  jmdict: 'JMdict',
  'hanyu-dict': '汉典',
  'guoyu-cidian': '教育部重編國語辭典',
  'cc-cedict': 'CC-CEDICT',
}

/** CC/오픈 라이선스로 배포되는 소스는 출처 표기에 라이선스도 함께 밝힌다(2026-07-28) —
 *  Wiktionary는 CC BY-SA 4.0(+ GFDL 이중 라이선스), OEWN은 CC BY 4.0(DICTIONARY_SOURCES.md
 *  OEWN 절 참고 — 원본 Princeton WordNet 대신 이 커뮤니티 후속판을 채택한 이유이기도 함)
 *  이라 둘 다 저작자 표시 의무가 있음. 나머지 소스는 상업 API(MW)·자체 저작권 사전
 *  (daijisen/汉典/教育部重編國語辭典)이라 이 앱 기준 별도 라이선스 표기 대상이 아님 —
 *  필요해지면 그때 채운다. */
const SOURCE_LICENSE: Partial<Record<DictionarySourceId, string>> = {
  wiktionary: 'CC BY-SA 4.0',
  wordnet: 'CC BY 4.0',
}

/** 라이선스 있는 소스의 "원문을 찾아갈 수 있는 링크" — 저작자 표시 요건상 표기 문구뿐
 *  아니라 원문 링크까지 포함하는 게 안전하다(2026-07-28). 소스별로 원문 도달 방식이
 *  달라 링크 빌더를 소스 id 로 분기한다 — 링크를 못 만드는(또는 안전하게 못 만드는)
 *  소스는 이 맵에 없으면 formatDictionaryAnswer 가 자동으로 링크 없이 라이선스명만 표기.
 *
 *  - wiktionary: wiktionary.ts 가 조회에 쓰는 표제어(queryWord)와 en.wiktionary.org
 *    페이지 타이틀이 같다는 전제(어댑터가 word 를 그대로 페이지 타이틀로 씀)로 표제어별
 *    딥링크 생성 가능. **앵커 추가(2026-07-28)**: en.wiktionary.org는 언어별
 *    `<h2 id="Japanese">` 같은 표준 MediaWiki 헤딩 id를 쓰므로(실측 확인: "猫"
 *    페이지에 `id="Japanese"` 존재), `#Japanese`처럼 조회 언어의 영문명을 앵커로 붙이면
 *    en/ja/zh 가 한 페이지에 섞여 있어도 관련 언어 섹션으로 바로 스크롤된다
 *    (WIKTIONARY_LANG_NAME 재사용, wiktionary.ts가 언어 블록 필터링에 쓰는 값과 동일).
 *  - wordnet(OEWN): 표제어별 딥링크가 없다 — 조회 API(en-word.net)가 DICTIONARY_SOURCES.md
 *    실측대로 503으로 불안정해 죽은 링크로 안내할 위험이 있고, 이 어댑터는 애초에 그
 *    라이브 API 를 쓰지 않고 GitHub Releases 데이터 파일을 로컬 번들로 쓴다(oewn.ts) —
 *    조회 결과와 무관하게 항상 살아있는 공식 프로젝트 페이지(GitHub 저장소)로 대신 연결한다.
 *  - daijisen: 저작권 있는 상업 사전이라 저작자 표시 의무는 없지만(SOURCE_LICENSE에 없음),
 *    daijisen.ts가 실제로 조회에 쓰는 `kotobank.jp/word/{표제어}` 그대로 링크를 만들면
 *    사용자가 원문(다른 사전 8개·관련어 등)을 바로 볼 수 있다 — ID 없이도 정확한 페이지로
 *    자동 리다이렉트됨을 실측 확인(daijisen.ts 상단 주석 참고)해 딥링크로 안전하게 씀.
 *    **앵커 추가(2026-07-28)**: `kotobankSectionAnchor('デジタル大辞泉')`로 daijisen
 *    섹션(다른 사전 8개가 앞에 있을 수 있음)으로 바로 스크롤 — 단, 개별 뜻풀이 번호까지는
 *    이 사이트 마크업상 앵커가 없어 안 됨(위 kotobankSectionAnchor 주석 참고). */
const SOURCE_URL: Partial<Record<DictionarySourceId, (word: string, language: Language) => string>> = {
  wiktionary: (word, language) =>
    `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}#${WIKTIONARY_LANG_NAME[language]}`,
  wordnet: () => 'https://github.com/globalwordnet/english-wordnet',
  daijisen: (word) => `https://kotobank.jp/word/${encodeURIComponent(word)}#${kotobankSectionAnchor('デジタル大辞泉')}`,
}

const POS_KO: Partial<Record<CanonicalPos, string>> = {
  noun: '명사',
  verb: '동사',
  adjective: '형용사',
  adverb: '부사',
  pronoun: '대명사',
  preposition: '전치사',
  conjunction: '접속사',
  article: '관사',
  particle: '조사',
  interjection: '감탄사',
  classifier: '양사',
  adnominal: '연체사',
}

/** 최종적으로 채팅창에 보여줄 마크다운 — 뜻풀이·예문은 LLM 이 번역한 한국어, 나머지
 *  (표제어·발음·품사·출처 등)는 사전 데이터를 그대로 서식화한다. */
/** queryWord 는 표시용이 아니라 "문맥에 맞는 뜻을 못 찾았을 때"의 안내 메시지에만 쓰인다
 *  — 실제 표제어 표시는 sense 마다 다를 수 있어(예: "closed" 조회 시 형용사 "closed"
 *  자체와 동사 "close"의 활용형이 동시에 후보로 오는 경우, 실측 확인) sense.headword
 *  (원형이 정확히 반영된 값)를 그대로 쓴다. */
export function formatDictionaryAnswer(
  queryWord: string,
  source: DictionarySourceId,
  selected: SelectedSense[],
  language: Language,
): string {
  if (!selected.length) return `**${queryWord}**\n\n문맥에 맞는 뜻을 찾지 못했습니다.`

  const lines: string[] = []

  // sense 마다 발음·품사가 다를 수 있어(예: bank 명사 vs bank 동사) 표제어 줄 자체를
  // sense 블록 단위로 반복한다 — 선택된 sense 가 하나뿐인 보통의 경우엔 한 줄만 나온다.
  for (const { sense, translatedGloss, translatedExamples } of selected) {
    // MW def[].vd/fl 실측 확인(2026-07-28) — 동사는 sense 마다 타동/자동 여부가(intransitive/
    // transitive 로 def 블록이 갈림), 관사는 fl 자체가("definite article"/"indefinite
    // article") 다를 수 있어 있으면 품사 라벨을 "타동사"/"자동사"/"정관사"/"부정관사"로
    // 대체한다(사용자 요청, "동사 (타동사)"처럼 병기 안 함). 구조화된 구분이 없는 소스는
    // 전부 undefined 라 기존 POS_KO/posRaw 폴백 그대로 나온다.
    const label =
      sense.transitive === true
        ? '타동사'
        : sense.transitive === false
          ? '자동사'
          : sense.definite === true
            ? '정관사'
            : sense.definite === false
              ? '부정관사'
              : (sense.pos?.map((p) => POS_KO[p] ?? p).join('/') ?? sense.posRaw)
    const idiomTag = sense.isIdiom ? ' (관용구)' : ''
    const posSuffix = label ? ` · ${label}${idiomTag}` : ''
    // MW 는 IPA 가 아니라 자체 표기법이라 표시 직전에 IPA 근사치로 변환한다(merriamWebsterToIpa.ts).
    // 다른 en 소스(OEWN/Wiktionary)는 원래부터 실제 IPA 라 변환하지 않고 그대로 쓴다.
    // 발음이 여러 개(ja 이독, zh 이음자, OEWN 지역별 variety 등)면 전부 쉼표로 나열한다 —
    // 첫 번째만 보여주면 나머지 읽기가 있다는 사실 자체가 사용자에게 안 보이게 된다.
    const pronunciations = sense.pronunciations?.map((p) => (source === 'merriam-webster' ? merriamWebsterToIpa(p) : p))
    const pronSuffix = pronunciations?.length ? ` [${pronunciations.join(', ')}]` : ''
    lines.push(`**${sense.headword}**${pronSuffix}${posSuffix}`)
    // 원문·번역은 같은 뜻을 언어만 달리 적은 동격 정보라 스타일을 다르게 주지 않는다.
    lines.push(sense.gloss.join('; '))
    lines.push(translatedGloss)
    // 예문이 여러 개면 전부 보여준다(원문 바로 아래 그 예문의 번역, 있는 만큼만) —
    // translatedExamples 는 개수가 부족할 수 있어(LLM이 일부만 번역한 경우) 인덱스로
    // 안전하게 대응시키고 없으면 원문만 보여준다.
    for (const [i, example] of (sense.examples ?? []).entries()) {
      lines.push(`> ${example}`)
      const translated = translatedExamples?.[i]
      if (translated) lines.push(`> ${translated}`)
    }
    // 활용형은 예문 다음, 다른 파트와는 빈 줄로 띄워 구분한다.
    if (sense.irregularForms?.length) {
      lines.push('')
      lines.push(`활용형: ${sense.irregularForms.join(', ')}`)
    }
    if (sense.usageTags?.length) lines.push(`_${sense.usageTags.map((t) => t.text).join(', ')}_`)
    if (sense.usageNote) lines.push(sense.usageNote)
    lines.push('')
  }

  // 라이선스가 있는 소스(Wiktionary/OEWN)는 원문 링크 + 라이선스명을 함께 표기해
  // 저작자 표시 요건을 최소한으로 충족한다 — 링크 빌더가 없는 소스는 라이선스명만.
  const license = SOURCE_LICENSE[source]
  const urlBuilder = SOURCE_URL[source]
  const sourceLabel = urlBuilder ? `[${SOURCE_LABELS[source]}](${urlBuilder(queryWord, language)})` : SOURCE_LABELS[source]
  const licenseSuffix = license ? ` (${license})` : ''
  lines.push(`_출처: ${sourceLabel}${licenseSuffix}_`)
  // 마크다운은 줄바꿈 하나(\n)만으론 같은 문단으로 합쳐 렌더링하므로(예: 원문/번역이
  // 한 줄로 붙어버림), 줄 끝에 공백 2개를 붙여 강제 줄바꿈(hard break)으로 만든다.
  return lines.join('  \n').trim()
}
