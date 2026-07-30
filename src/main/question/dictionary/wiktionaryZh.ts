import type { DictionaryEntry, DictionaryReading, DictionarySense, Language, UsageTag } from '@shared/types'
import { dedupe, fetchWikitext } from './wiktionary'
import type { WiktionaryLookupResult } from './wiktionary'

// 담당 B — Wiktionary zh 전용 로직 (wiktionary.ts 에서 분리, 2026-07-28)
// 1. 표준중국어(Mandarin) 발음 추출({{zh-pron|m=...}})
// 2. REST API 가 zh 언어 데이터를 아예 못 줄 때(단일 한자 표제어 등)의 wikitext 직접
//    파싱 fallback
// 실측 근거는 DICTIONARY_SOURCES.md "Wiktionary" 절 참고.

/** zh 표준중국어(Mandarin) 병음(들) — {{zh-pron|m=병음|...}} 의 m= 파라미터만 뽑는다(다른
 *  방언 파라미터 c=광둥어/h=객가어/mn=민난어 등은 DICTIONARY_SOURCES.md 방침대로 버림).
 *  실측 확인(2026-07-28, 你好/中國/一/打/謝謝/打算/水/的/了/麼/嗎 11개 표제어 직접 wikitext
 *  조회) 결과 이 파라미터엔 두 가지 함정이 있었다:
 *  1. **값이 콤마로 여러 개 이어질 수 있고, 그중 일부는 실제 병음이 아니라 콤마로 덧붙는
 *     수식 플래그**다 — 예: "打算"→"m=dǎsuàn,tl=y"(tl=톤 산디 플래그), "水"→"m=shuǐ,er=y"
 *     (er=얼화 플래그), "的"→"m=de,dì,2tl=y,1nb=unstressed,2nb=stressed"(앞 2개는 실제
 *     복수 병음 — "de"/"dì" 둘 다 진짜 발음이라 둘 다 채택, 뒤 3개는 번호 붙은 플래그).
 *     콤마로 나눈 뒤 "=" 가 들어간 세그먼트(플래그)만 걸러내고 남는 건 전부 병음으로
 *     채택한다 — 첫 번째만 쓰던 이전 방식에서 2026-07-28 변경(DictionaryReading.
 *     pronunciations 가 배열이라 전부 담을 수 있음).
 *  2. **일부 블록은 m= 값 자체가 병음이 아니라 한자 표제어 그대로**인 경우가 있다(실측:
 *     "一"/"打" 일부 블록 → "m=一"/"m=打" — 정확한 의미는 불명, 아마 "문자 자체의 별도
 *     항목을 보라"는 플레이스홀더로 추정). 이런 값은 한자만 포함해 병음처럼 안 보이므로
 *     한자(CJK 통합 한자) 포함 여부로 걸러낸다.
 *  3. **표제어에 zh-pron 블록이 여러 개 있고(다의어·이독), 일부 블록엔 아예 m= 자체가
 *     없을 수 있다**(실측: "一" 세 번째 블록 — 민난어/객가어 전용, m= 없음) — 이 경우
 *     그 블록만 건너뛰고 m= 가 있는 다른 블록은 계속 수집한다. */
export function extractZhMandarinFromWikitext(wikitext: string): string[] {
  const blockRegex = /\{\{zh-pron\b[^}]*?\|m=([^|\n}]+)/g
  const values: string[] = []
  for (const m of wikitext.matchAll(blockRegex)) {
    const candidates = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('=') && !/[㐀-鿿豈-﫿]/.test(s))
    values.push(...candidates)
  }
  return dedupe(values)
}

// ---- zh 단일 한자 REST API 누락 대응(wikitext 직접 파싱 fallback) --------------

/** REST API definition 엔드포인트가 zh 언어 블록 자체를 안 주는 경우(실측: 水/一/打/
 *  大/小/人/火/山 8개 단일 한자 표제어 전부 재현, DICTIONARY_SOURCES.md "아직 미확인
 *  항목" 참고) — 이 표제어들은 품사 전용 헤더(`===Noun===` 등) 대신 범용 `====
 *  Definitions====` 헤더를 쓰는 위키 편집 관례를 따르는데, REST API 가 이 헤더를 못
 *  알아보고 그 언어 전체를 건너뛰는 것으로 추정된다. `====Definitions====` 안의 "# 뜻풀이"
 *  줄만 정규식으로 뽑아 최소한의 gloss 라도 채운다.
 *
 *  **en 위키텍스트 전체를 직접 파싱하지 않기로 한 결정(wiktionary.ts stripWiktionaryHtml/
 *  REST API 선택 근거 참고: {{lb|...}}/{{ux|...}}/{{cot|...}} 같은 수백 종류 템플릿 확장이
 *  필요해 리스크가 큼)과 모순돼 보일 수 있지만, 실측(水→"# {{senseid|zh|Q283}} [[water]]
 *  {{zh-mw|...}}", 一→"# [[one]]", 打→"# to [[hit]]; to [[strike]]", 大→"# of great
 *  size; [[big]]; [[large]]" 등)해보면 zh 단일 한자의 gloss 줄은 위키링크 나열+세미콜론
 *  구분 정도로 훨씬 단순하다 — {{senseid|...}}(식별자, 무시)/{{zh-mw|...}}(양사 정보,
 *  무시) 정도만 나오고 en 처럼 뜻풀이 자체가 복잡한 서식 템플릿에 감싸여 있지 않다. 그래서
 *  "REST API가 아예 응답을 안 주는 예외 케이스에서, 단순한 패턴만 처리하는 좁은
 *  fallback"으로 스코프를 한정해 리스크를 낮췄다 — en/ja 전체를 이 방식으로 바꾸자는
 *  얘기가 아니다. */
/** 한 줄의 뜻풀이 원문(`#`/`##` 제거된 나머지)을 정리한다 — HTML 주석 제거, `{{n-g|...}}`/
 *  `{{gl|...}}`(nongloss 보조설명 템플릿, 인자 안 위키링크 파이프에 안 잘리게 인자 전체를
 *  그대로 씀 — 실측: "一" "{{n-g|With the [[verb]] [[modify|modified]] ...}}"를 첫 `|`
 *  에서 잘라버리는 버그가 있었음), 나머지 템플릿은 통째로 제거(얕은 중첩 대비 2회 반복),
 *  위키링크 평문화 순으로 처리한다.
 *
 *  **2026-07-28 사용자 피드백으로 추가 정리 3건**(실측: 水/人):
 *  1. `''이탤릭''`(홑따옴표 2개) 마크업이 안 지워지는 버그 — `'''?`(정확히 2~3개만 매칭)
 *     로는 `''{{템플릿}}''`에서 템플릿이 지워져 홑따옴표 4개(`''''`)가 붙어버리면 3개+3개로
 *     안 나뉘어 1개가 찌꺼기로 남았다(실측: "water, one of the five elements of ' ()").
 *     `/'{2,}/g`(2개 이상이면 개수 상관없이 전부 제거)로 교체.
 *  2. 템플릿을 지운 자리에 감싸던 괄호만 빈 채로 남는 경우(실측: 위 예시의 `()`) — 정리
 *     마지막 단계에서 빈 괄호를 제거.
 *  3. `{{gl|...}}`(괄호 보충설명 템플릿, 뜻풀이 자체인 `{{n-g|...}}`와 달리 원래 렌더링도
 *     괄호 안에 들어감)를 `{{n-g|...}}`와 같이 인자만 이어붙이면 "wave event; rush"처럼
 *     구두점 없이 붙어버린다(실측: "# {{lb|zh|Cantonese|figurative}} [[wave]] {{gl|event}};
 *     [[rush]]") — `{{gl|...}}`만 따로 떼어 인자를 괄호로 감싸 넣는다("wave (event); rush").
 *  4. 안전장치 — 위 정리를 다 거쳐도 맨 앞에 콜론만 남는 경우(실측: "# {{lb|zh|classical}}
 *     {{short for|zh|水曜日}}: Wednesday" → 앞의 두 템플릿이 통째로 지워지고 ": Wednesday"만
 *     남음)가 있어, 결과 맨 앞의 `:`(+공백)는 마지막에 한 번 더 잘라낸다.
 *
 *  **2026-07-28 사용자 피드백으로 정보 손실 3건 추가 보강**:
 *  1. `{{w|...}}`(위키백과 링크) — 위키링크(`[[...]]`)와 똑같이 표시 텍스트를 살려야
 *     하는데 지금까진 통째로 지워서 "# {{w|Sui people}}"(뜻풀이 전체가 이 링크 하나뿐인
 *     sense, 실측: "水"의 "수이족" 뜻) 같은 경우 sense 자체가 통으로 사라졌다. named
 *     인자(`lang=zh` 등, `=` 포함)는 제외하고 남은 positional 인자 중 마지막 것을 표시
 *     텍스트로 채택(실측: `{{w|Sui people}}` → "Sui people", `{{w|lang=zh|梁左}}` → "梁左"
 *     — 후자는 named 인자 뒤에 오는 실제 이름이 표시 대상).
 *  2. `{{surname|zh}}` — 인자 자체엔 표시 텍스트가 없고 템플릿 이름 자체에 "성씨로 쓰인다"는
 *     뜻이 고정으로 담겨있어(실측: "水"의 성씨 뜻이 이 템플릿 하나뿐인 sense였음) 고정
 *     문자열 "surname"으로 대응.
 *  둘 다 다른 템플릿처럼 나중에 통째로 지워지면 안 되므로, 일반 템플릿 제거보다 먼저
 *  처리한다. */
function cleanZhGlossText(body: string): string {
  let text = body
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/\{\{w\|([^{}]*)\}\}/g, (_m, args: string) => {
    const positional = args
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('='))
    return positional[positional.length - 1] ?? ''
  })
  text = text.replace(/\{\{surname\|zh\}\}/g, 'surname')
  text = text.replace(/\{\{n-g\|([^{}]*)\}\}/g, '$1')
  text = text.replace(/\{\{gl\|([^{}]*)\}\}/g, '($1)')
  text = text.replace(/\{\{[^{}]*\}\}/g, '')
  text = text.replace(/\{\{[^{}]*\}\}/g, '')
  text = text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[link|표시]] → 표시
  text = text.replace(/\[\[([^\]]*)\]\]/g, '$1') // [[link]] → link
  text = text
    .replace(/'{2,}/g, '') // ''이탤릭''/'''볼드''' 등 홑따옴표 서식 전부 제거
    .replace(/\(\s*\)/g, '') // 템플릿 제거 후 빈 채로 남은 괄호
    .replace(/\s+/g, ' ')
    .trim()
  return text.replace(/^:\s*/, '') // 앞선 템플릿이 통째로 사라지고 콜론만 남는 경우
}

/** `{{lb|zh|라벨1|라벨2|...}}`(사용역/방언 라벨 템플릿)에서 라벨들을 뽑아 `UsageTag[]`로
 *  돌려준다 — 실측 확인: "{{lb|zh|Cantonese}} money"(광둥어 방언 전용 속어)처럼 이 라벨이
 *  없으면 "이 뜻이 표준중국어인지 방언인지" 신호가 통째로 사라진다(스키마에 이미
 *  `DictionarySense.usageTags` 자리가 있고 JMdict/CC-CEDICT 등 다른 소스는 이미 채우고
 *  있는데 이 fallback만 안 채우고 있었음). `kind`(register/dialect/...) 분류는 라벨이
 *  "Cantonese"/"classical"/"mainly"/"Singapore" 처럼 방언명·격식·연결어·지역명이 뒤섞여
 *  있어(실측: `{{lb|zh|colloquial|mainly|Singapore|Malaysia}}`) 잘못 분류하는 리스크가
 *  분류 안 하는 것보다 커 보류 — 원문 라벨만 그대로 담는다(다른 소스의 `kind` 분류표처럼
 *  정식 룩업 테이블이 필요하면 그때 추가). 텍스트 정리(cleanZhGlossText)와 별개 패스로
 *  동작하므로 `{{lb|...}}` 자체는 거기서 그대로 지워진다(중복 처리 아님 — 값만 여기서
 *  먼저 뽑아두는 것). */
function extractZhUsageTags(body: string): UsageTag[] | undefined {
  const tags: UsageTag[] = []
  for (const m of body.matchAll(/\{\{lb\|zh\|([^{}]*)\}\}/g)) {
    for (const raw of m[1].split('|')) {
      const text = raw.trim()
      if (text) tags.push({ text })
    }
  }
  return tags.length ? tags : undefined
}

interface ZhGlossLine {
  text: string
  usageTags?: UsageTag[]
}

function extractZhDefinitionsGloss(content: string): ZhGlossLine[] {
  // 1차: "# 뜻풀이" 줄만 깊이(#의 개수)와 원문을 보존한 채 모은다 — 예문(#:)·인용(#*)
  // 줄은 여기서 제외(하위 sense 의 것(##:/##*)도 포함해서 걸러야 한다 — 실측 확인
  // "一": `/^#[:*]/`(# 정확히 1개)로만 짜면 "##* {{zh-q|...}}" 같은 긴 고문 인용이
  // 걸러지지 않고 뜻풀이처럼 섞여 들어가는 버그가 있었음).
  const rawLines: { depth: number; body: string }[] = []
  for (const raw of content.split('\n')) {
    if (/^#+[:*]/.test(raw)) continue
    const m = raw.match(/^(#+)\s*(.+)$/)
    if (!m) continue
    rawLines.push({ depth: m[1].length, body: m[2] })
  }

  // 2차: 하위(`##`) sense 를 거느린 "그룹 헤더" 줄을 걸러낸다 — 실측 확인(2026-07-28,
  // "打"): "# {{n-g|Used as a dummy verb to make a verbal phrase from a noun, including
  // but not limited to:}}" 아래 "to get; to fetch"/"to buy..." 등 30개 가까운 진짜 뜻이
  // `##`로 붙는데, 이 헤더 줄 자체는 뜻이 아니라 "다음부터 나오는 뜻들에 공통되는 문법적
  // 설명"이다. 그런데도 평탄화해서 다른 진짜 뜻과 나란히 보여주면 사용자가 이걸 하나의
  // 독립된 뜻으로 오해한다(2026-07-28 사용자 피드백). Wiktionary 는 이런 "뜻이 아닌 설명"
  // 줄을 `{{n-g|...}}`("non-gloss definition") 템플릿으로 명시적으로 표시해두므로, **줄
  // 전체가 이 템플릿 하나뿐이고 + 바로 다음 줄이 더 깊은 하위 sense 일 때만** 그 줄을
  // 버리고 하위 sense 만 남긴다. 템플릿으로 안 감싸인 줄(예: "water, one of the five
  // elements..." 아래 "Wednesday" 하위 sense가 붙는 경우)은 그 자체로 독립된 진짜 뜻이라
  // 자식이 있어도 그대로 남긴다 — "자식이 있으면 무조건 버린다"는 휴리스틱은 이런 진짜
  // 계층 사례(MW sdsense 와 같은 축)까지 지워버려서 안 된다.
  const isPureNongloss = (body: string) => /^\{\{(?:n-g|gl)\|[^{}]*\}\}$/.test(body.trim())

  const lines: ZhGlossLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const { depth, body } = rawLines[i]
    const next = rawLines[i + 1]
    const hasDeeperChild = next !== undefined && next.depth > depth
    if (hasDeeperChild && isPureNongloss(body)) continue
    const text = cleanZhGlossText(body)
    if (text) lines.push({ text, usageTags: extractZhUsageTags(body) })
  }
  return lines
}

interface FallbackDefinitionsGroup {
  lines: ZhGlossLine[]
  pronunciations: string[]
  groupId: number
}

/** REST API가 이 언어를 아예 안 줄 때만 타는 경로 — 헤더를 등장 순서대로 걸으며
 *  Pronunciation(wiktionary.ts assignPerBlockPronunciations 와 같은 zh 명명 규칙)과
 *  Definitions 헤더를 짝짓는다. REST API 블록이 없으니 그 블록 배열과 순서를 맞출 필요가
 *  없어 assignPerBlockPronunciations 보다 단순하다 — Definitions 헤더를 만날 때마다 그
 *  직전 Pronunciation 값을 그대로 붙인다. */
function extractZhFallbackGroups(wikitext: string, languageName: string): FallbackDefinitionsGroup[] {
  const sectionRegex = new RegExp(`==${languageName}==([\\s\\S]*?)(?=\\n==[A-Za-z][^=\\n]*==\\n|$)`)
  const sectionMatch = wikitext.match(sectionRegex)
  if (!sectionMatch) return []
  const section = sectionMatch[1]

  const headingRegex = /^(=+)\s*(.+?)\s*\1\s*$/gm
  const headings: { text: string; start: number; end: number }[] = []
  for (const m of section.matchAll(headingRegex)) {
    const start = m.index ?? 0
    headings.push({ text: m[2].trim(), start, end: start + m[0].length })
  }

  const groups: FallbackDefinitionsGroup[] = []
  let currentPron: string[] = []
  let currentGroupId = -1
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const contentEnd = i + 1 < headings.length ? headings[i + 1].start : section.length
    const content = section.slice(h.end, contentEnd)

    if (/^Pronunciation(\s+\d+)?$/.test(h.text)) {
      currentPron = extractZhMandarinFromWikitext(content)
      currentGroupId++
      continue
    }
    if (h.text === 'Definitions') {
      const lines = extractZhDefinitionsGloss(content)
      if (lines.length) groups.push({ lines, pronunciations: currentPron, groupId: currentGroupId })
    }
  }
  return groups
}

/** REST API가 이 표제어에 대해 zh 언어 데이터를 아예 못 줄 때(둘 다 실측 확인,
 *  2026-07-28) 시도하는 wikitext 직접 파싱 fallback:
 *  1. definition 엔드포인트가 HTTP 200을 주지만 응답에 zh 키/블록이 없는 경우(水/一/大/
 *     小/人/火/山 — 위 extractZhDefinitionsGloss 주석의 "Definitions" 헤더 원인).
 *  2. definition 엔드포인트 자체가 **HTTP 404**(`{"status":404,"type":"Internal error"}`)
 *     로 응답하는 경우(打 — 실측 확인) — 404 라고 표제어가 실제로 없는 게 아니라, wikitext
 *     (action=parse)로는 정상 조회되는 걸 확인했다. REST API(Parsoid 렌더링)가 이 특정
 *     페이지를 렌더링하다 내부 오류를 내는 것으로 추정 — MW 어댑터의 "무효 키인데 200
 *     응답" 같은 REST API 고유의 함정 케이스. */
export async function tryZhDefinitionsFallback<L extends Language>(
  word: string,
  language: L,
  langName: string,
): Promise<WiktionaryLookupResult<L>> {
  const wikitext = await fetchWikitext(word)
  if (!wikitext) return {}
  const groups = extractZhFallbackGroups(wikitext, langName)
  if (!groups.length) return {}

  const fallbackReadings: DictionaryReading<L>[] = []
  let lastGroupId = -1
  for (const group of groups) {
    const senses = group.lines.map((l) => ({ gloss: [l.text], usageTags: l.usageTags }) as DictionarySense<L>)
    const prev = fallbackReadings[fallbackReadings.length - 1]
    if (prev && group.groupId === lastGroupId) {
      prev.senses.push(...senses)
    } else {
      fallbackReadings.push({
        pronunciations: group.pronunciations.length ? group.pronunciations.map((value) => ({ value })) : undefined,
        senses,
      })
    }
    lastGroupId = group.groupId
  }
  if (!fallbackReadings.length) return {}

  return {
    entry: {
      language,
      headword: [word],
      readings: fallbackReadings,
      source: 'wiktionary',
    } as DictionaryEntry<L>,
  }
}
