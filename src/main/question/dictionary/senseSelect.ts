import type { CanonicalPos, DictionaryEntry } from '@shared/types'

// 담당 B — 사전 뜻(sense) 번호 매기기 + LLM 판정 결과 서식화 (PLAN.md §4.2-2)
// DictionaryEntry[] 를 LLM 프롬프트에 넣을 번호 매긴 평면 목록으로 바꾸고,
// 사용자가 원한 것도 이 형태다: LLM 은 번호만 고르고, 실제로 채팅창에 보여줄
// 뜻풀이·예문 등은 여기서 만든 원본 사전 데이터를 그대로 서식화해서 쓴다.

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

/** LLM 프롬프트의 사용자 메시지에 넣을, 번호 매긴 뜻풀이 후보 목록. */
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

/** LLM 응답 텍스트에서 골라낸 번호를 파싱한다. "2", "1,3", "1, 3", "0"(해당 없음) 등을
 *  허용하고, 목록에 없는 번호나 파싱 실패는 조용히 걸러낸다. */
export function parseSelectedIndexes(reply: string, senses: NumberedSense[]): number[] {
  const valid = new Set(senses.map((s) => s.index))
  const nums = [...reply.matchAll(/\d+/g)].map((m) => Number(m[0]))
  const selected = nums.filter((n) => n !== 0 && valid.has(n))
  return [...new Set(selected)]
}

/** 최종적으로 채팅창에 보여줄 마크다운. 선택된 sense 들을 원본 headword 기준 사전 형식으로
 *  묶어서 서식화한다 — LLM 출력이 아니라 사전 데이터를 그대로 가공한 텍스트다. */
export function formatDictionaryAnswer(headword: string, selected: NumberedSense[]): string {
  if (!selected.length) return `**${headword}**\n\n문맥에 맞는 뜻을 찾지 못했습니다.`

  const pronunciation = selected.find((s) => s.pronunciation)?.pronunciation
  const lines: string[] = []
  lines.push(pronunciation ? `**${headword}** [${pronunciation}]` : `**${headword}**`)
  lines.push('')

  for (const s of selected) {
    const label = s.posRaw ?? s.pos
    const idiomTag = s.isIdiom ? ' (관용구)' : ''
    lines.push(`${label ? `**${label}${idiomTag}**` : ''}`.trim())
    lines.push(`${s.gloss.join('; ')}`)
    if (s.examples?.length) lines.push(`> ${s.examples[0]}`)
    if (s.usageTags?.length) lines.push(`_${s.usageTags.join(', ')}_`)
    if (s.usageNote) lines.push(s.usageNote)
    if (s.irregularForms?.length) lines.push(`활용형: ${s.irregularForms.join(', ')}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}
