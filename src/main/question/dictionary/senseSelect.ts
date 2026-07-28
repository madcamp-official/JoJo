import type { CanonicalPos, DictionaryEntry, DictionarySourceId, Language, UsageTag } from '@shared/types'
import { merriamWebsterToIpa } from './merriamWebsterToIpa'

// 담당 B — 사전 뜻(sense) 번호 매기기 + LLM 판정/번역 결과 서식화 (PLAN.md §4.2-2)
// DictionaryEntry[] 를 LLM 프롬프트에 넣을 번호 매긴 평면 목록으로 바꾸고, LLM 은 문맥에
// 맞는 번호를 고른 뒤 그 뜻풀이·예문을 한국어로 번역한다(PLAN.md §5: "사전 API는 원어
// 뜻 목록만 제공, 한국어 설명·번역은 LLM이 담당"). pos 라벨·출처처럼 번역이 필요 없는
// 나머지는 여기서 사전 데이터를 그대로 서식화한다.

export interface NumberedSense {
  index: number
  headword: string
  pos?: CanonicalPos
  posRaw?: string
  pronunciation?: string
  irregularForms?: string[]
  transitive?: boolean
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
      const pronunciation = reading.pronunciations?.[0]?.value
      for (const sense of reading.senses) {
        // gloss 없는 sense 는 하위 구분을 위한 그룹 헤더일 뿐 그 자체로는 선택 가능한
        // 뜻풀이가 아니다(shared/types.ts DictionarySenseGloss 참고) — LLM 판정 목록에서 제외한다.
        if (!sense.gloss) continue
        out.push({
          index: index++,
          headword,
          pos: sense.pos,
          posRaw: sense.posRaw,
          pronunciation,
          irregularForms: 'irregularForms' in sense ? sense.irregularForms : undefined,
          transitive: 'transitive' in sense ? sense.transitive : undefined,
          gloss: sense.gloss,
          examples: sense.examples,
          usageTags: sense.usageTags,
          usageNote: sense.usageNote,
          isIdiom: entry.isIdiom,
        })
      }
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
      // transitive 가 있으면(MW def.vd 실측: "run"처럼 타동/자동사로 def 블록이 갈리는
      // 경우) 품사 라벨 자체를 "타동사"/"자동사"로 대체한다 — "동사 (타동사)"처럼
      // 병기하지 않는다(사용자 요청, 2026-07-28).
      const label = s.transitive === true ? '타동사' : s.transitive === false ? '자동사' : (s.posRaw ?? s.pos)
      const tag = label ? `[${label}] ` : ''
      const gloss = s.gloss.join('; ')
      const ex = s.examples?.length ? ` (예: ${s.examples.map((e) => `"${e}"`).join(' / ')})` : ''
      return `${s.index}. ${tag}${gloss}${ex}`
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
  kotobank: 'Kotobank',
  jmdict: 'JMdict',
  'hanyu-dict': '汉典',
  moedict: '萌典',
  'cc-cedict': 'CC-CEDICT',
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
): string {
  if (!selected.length) return `**${queryWord}**\n\n문맥에 맞는 뜻을 찾지 못했습니다.`

  const lines: string[] = []

  // sense 마다 발음·품사가 다를 수 있어(예: bank 명사 vs bank 동사) 표제어 줄 자체를
  // sense 블록 단위로 반복한다 — 선택된 sense 가 하나뿐인 보통의 경우엔 한 줄만 나온다.
  for (const { sense, translatedGloss, translatedExamples } of selected) {
    // MW def[].vd(verb divider) 실측 확인(2026-07-28, "run") — 동사 sense 마다 타동/자동
    // 여부가 다를 수 있어(intransitive/transitive 로 def 블록 자체가 갈림) 있으면 품사
    // 라벨 자체를 "타동사"/"자동사"로 대체한다(사용자 요청, "동사 (타동사)"처럼 병기 안 함).
    const label =
      sense.transitive === true
        ? '타동사'
        : sense.transitive === false
          ? '자동사'
          : ((sense.pos && POS_KO[sense.pos]) ?? sense.posRaw)
    const idiomTag = sense.isIdiom ? ' (관용구)' : ''
    const posSuffix = label ? ` · ${label}${idiomTag}` : ''
    // MW 는 IPA 가 아니라 자체 표기법이라 표시 직전에 IPA 근사치로 변환한다(merriamWebsterToIpa.ts).
    // 다른 en 소스(OEWN/Wiktionary)는 원래부터 실제 IPA 라 변환하지 않고 그대로 쓴다.
    const pronunciation =
      source === 'merriam-webster' && sense.pronunciation
        ? merriamWebsterToIpa(sense.pronunciation)
        : sense.pronunciation
    const pronSuffix = pronunciation ? ` [${pronunciation}]` : ''
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

  lines.push(`_출처: ${SOURCE_LABELS[source]}_`)
  // 마크다운은 줄바꿈 하나(\n)만으론 같은 문단으로 합쳐 렌더링하므로(예: 원문/번역이
  // 한 줄로 붙어버림), 줄 끝에 공백 2개를 붙여 강제 줄바꿈(hard break)으로 만든다.
  return lines.join('  \n').trim()
}
