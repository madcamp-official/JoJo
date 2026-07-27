import type { CanonicalPos, DictionaryEntry, DictionarySourceId } from '@shared/types'

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
  gloss: string[]
  examples?: string[]
  usageTags?: string[]
  usageNote?: string
  isIdiom?: boolean
}

export function numberSenses(entries: DictionaryEntry[]): NumberedSense[] {
  const out: NumberedSense[] = []
  let index = 1
  for (const entry of entries) {
    const headword = entry.headword[0]
    for (const reading of entry.readings) {
      const pronunciation = reading.pronunciations?.[0]?.value
      for (const sense of reading.senses) {
        out.push({
          index: index++,
          headword,
          pos: sense.pos,
          posRaw: sense.posRaw,
          pronunciation,
          irregularForms: sense.irregularForms,
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

/** LLM 프롬프트의 사용자 메시지에 넣을, 번호 매긴 뜻풀이 후보 목록(원어 그대로). */
export function buildSenseListText(senses: NumberedSense[]): string {
  return senses
    .map((s) => {
      const label = s.posRaw ?? s.pos
      const tag = label ? `[${label}] ` : ''
      const gloss = s.gloss.join('; ')
      const ex = s.examples?.[0] ? ` (예: "${s.examples[0]}")` : ''
      return `${s.index}. ${tag}${gloss}${ex}`
    })
    .join('\n')
}

export interface SelectedSense {
  sense: NumberedSense
  /** LLM 이 문맥에 맞게 자연스러운 한국어로 옮긴 뜻풀이 */
  translatedGloss: string
  /** 후보에 예문이 있었을 때만 LLM 이 함께 번역한 예문 */
  translatedExample?: string
}

/** LLM 응답에서 "번호: N\n번역: ...\n예문번역: ..." 블록(들, "---" 로 구분)을 파싱한다.
 *  "번호: 0"(해당 없음)이나 파싱 실패 블록, 목록에 없는 번호는 조용히 걸러낸다. */
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
    const exampleMatch = block.match(/예문\s*번역\s*[:：]\s*(.+)/)
    out.push({
      sense,
      translatedGloss: glossMatch[1].trim(),
      translatedExample: exampleMatch?.[1]?.trim(),
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
export function formatDictionaryAnswer(
  headword: string,
  source: DictionarySourceId,
  selected: SelectedSense[],
): string {
  if (!selected.length) return `**${headword}**\n\n문맥에 맞는 뜻을 찾지 못했습니다.`

  const lines: string[] = []

  // sense 마다 발음·품사가 다를 수 있어(예: bank 명사 vs bank 동사) 표제어 줄 자체를
  // sense 블록 단위로 반복한다 — 선택된 sense 가 하나뿐인 보통의 경우엔 한 줄만 나온다.
  for (const { sense, translatedGloss, translatedExample } of selected) {
    const label = (sense.pos && POS_KO[sense.pos]) ?? sense.posRaw
    const idiomTag = sense.isIdiom ? ' (관용구)' : ''
    const posSuffix = label ? ` · ${label}${idiomTag}` : ''
    const pronSuffix = sense.pronunciation ? ` [${sense.pronunciation}]` : ''
    lines.push(`**${headword}**${pronSuffix}${posSuffix}`)
    // 활용형은 예문이 아니라 단어 자체에 딸린 정보라 표제어 줄 바로 아래(예문과는 분리된
    // 자리)에 둔다.
    if (sense.irregularForms?.length) lines.push(`활용형: ${sense.irregularForms.join(', ')}`)
    // 원문·번역을 둘 다, 각각 다른 줄에 보여준다 — 원문만으론 영어 학습에 안 맞고,
    // 번역만으론 사전 원문 표현을 확인할 수가 없다.
    lines.push(sense.gloss.join('; '))
    lines.push(translatedGloss)
    if (sense.examples?.[0]) {
      lines.push(`> ${sense.examples[0]}`)
      if (translatedExample) lines.push(`> ${translatedExample}`)
    }
    if (sense.usageTags?.length) lines.push(`_${sense.usageTags.join(', ')}_`)
    if (sense.usageNote) lines.push(sense.usageNote)
    lines.push('')
  }

  lines.push(`_출처: ${SOURCE_LABELS[source]}_`)
  // 마크다운은 줄바꿈 하나(\n)만으론 같은 문단으로 합쳐 렌더링하므로(예: 원문/번역이
  // 한 줄로 붙어버림), 줄 끝에 공백 2개를 붙여 강제 줄바꿈(hard break)으로 만든다.
  return lines.join('  \n').trim()
}
