import type {
  DictionaryEntry,
  DictionarySourceId,
  Language,
  QuestionResult,
  SelectionContext,
} from '@shared/types'
import { getApiKey } from '@main/keyStore'
import { tokenizeJapanese } from '@main/nlp/japanese'
import { getSettings } from '@main/settingsStore'
import { DEFAULT_MODELS } from '@shared/providers'
import { getLanguageName, isFullLanguage } from '@shared/languages'
import { fetchCcCedictEntry } from './dictionary/cccedict'
import { fetchDaijisenEntry, DaijisenHttpError } from './dictionary/daijisen'
import { fetchHanyuEntry, HanyuHttpError } from './dictionary/hanyu'
import { fetchJmdictEntry } from './dictionary/jmdict'
import { fetchGuoyuCidianEntry, GuoyuCidianHttpError } from './dictionary/guoyuCidian'
import { fetchMerriamWebsterEntry, MerriamWebsterHttpError } from './dictionary/merriamWebster'
import { fetchOewnEntry } from './dictionary/oewn'
import { fetchWiktionaryEntry, WiktionaryHttpError } from './dictionary/wiktionary'
import {
  buildSenseListText,
  formatDictionaryAnswer,
  numberSenses,
  parseJudgeReply,
  SOURCE_LABELS,
} from './dictionary/senseSelect'
import { buildContextBlock, createClient, getActiveProvider } from './llm/adapter'
import { classifyLlmError } from './llm/errors'
import { renderPrompt } from './prompts/template'
import dictionaryPromptTemplate from './prompts/dictionary.txt?raw'
import { buildErrorResult } from './errors'

// 담당 B — 사전 검색 (PLAN.md §5.2-2)
// 언어별 정식 폴백 체인(FALLBACK_CHAINS, 아래)으로 원어 뜻(sense) 후보를 모으고, LLM 에
// "문맥상 몇 번인지" 판정과 그 뜻풀이·예문의 한국어 번역을 함께 맡긴다(PLAN.md §6:
// 사전 API는 원어 뜻만 제공, 한국어 설명·번역은 LLM 담당). 채팅창에 보일 최종 텍스트는
// 그 번역 결과와 사전 원본 데이터(품사·출처·활용형 등)를 조합해 여기서 직접 구성한다.
//
// 다중 단어 선택 폴백(TODO.md 참고, en/ja/zh 전부 적용, 2026-07-30 ja/zh로 확장):
// 선택 텍스트 전체를 표제어로 먼저 조회하고("kick the bucket" 같은 관용구는 통째로
// 사전에 있을 수 있음), 못 찾으면 단어 단위로 쪼개(splitIntoDictionaryWords — en 은
// 공백/하이픈, ja/zh 는 형태소 분석기) 각각 독립적으로 같은 폴백 체인
// (lookupThroughFallbackChain)을 병렬 호출한다. 단어별 뜻은 서로 무관해 하나의
// 프롬프트/판정으로 억지로 합칠 필요가 없어 이 구조를 택함 — 단, 체인 호출이 단어
// 수만큼 늘어나므로 MAX_FALLBACK_WORDS 로 상한을 둔다. forceSource(사전 소스 직접 선택,
// 정식 기능)도 동일한 분해 로직을 공유한다(lookupForcedSourceOnce) — "직접 선택"은 소스
// 하나만 고정한다는 뜻이지, 그 소스 내부의 단어 분해 폴백까지 건너뛴다는 뜻이 아니다.
//
// 진행 상황 실시간 표시(2026-07-31): 사전 조회는 소스를 순서대로 때리고 그때마다 LLM
// 판정까지 도는 구조라 최종 결과가 나오기까지 수 초가 걸리는데, 그 사이 채팅창이 완전히
// 비어 있어 "지금 뭘 하는 중인지 / 왜 오래 걸리는지"를 알 수 없다는 사용자 피드백으로
// ProgressFn 을 체인 전 구간에 배선했다 — 어느 사전에서 검색 중인지, 결과가 없어 다음
// 사전으로 폴백했는지, 사전엔 있었는데 LLM 이 문맥에 맞는 뜻을 못 골랐는지를 한 줄씩
// onChunk(meta.progress) 로 흘려보낸다. 이 청크는 답변 본문(content)이 아니라 렌더러가
// 따로 쌓아 두는 진행 로그이고, 최종 결과가 도착하면 통째로 지워진다(PopupScreen.tsx
// onQuestionStream / Chat.tsx bubble-progress).

const DICTIONARY_JUDGE_TEMPERATURE = 0.2
const DICTIONARY_JUDGE_MAX_TOKENS = 500
/** 폴백 시 개별 조회할 단어 수 상한 — MW 무료 티어(일 1,000회)와 LLM 호출 비용 보호용.
 *  이보다 길게 드래그하면 폴백 없이 "찾지 못했습니다"로 처리한다. */
const MAX_FALLBACK_WORDS = 5

/** 정식 폴백 순서(TODO.md/DICTIONARY_SOURCES.md 에 확정된 순서 그대로) — 앞 소스가
 *  못 찾거나 실패하면 조용히 다음으로 넘어간다. */
const FALLBACK_CHAINS: Record<Language, DictionarySourceId[]> = {
  en: ['merriam-webster', 'wordnet', 'wiktionary'],
  ja: ['daijisen', 'jmdict', 'wiktionary'],
  'zh-Hans': ['hanyu-dict', 'cc-cedict', 'wiktionary'],
  'zh-Hant': ['guoyu-cidian', 'hanyu-dict', 'cc-cedict', 'wiktionary'],
}

/** 이 파일 전체는 tier1(LLM 사전 지원 언어) 전용이다 — tier2/3는 팝업 UI가 애초에 "사전"
 *  버튼 자체를 안 보여주므로(Toolbar.tsx) 정상 경로로는 여기 안 들어오지만, 방어적으로
 *  lookupDictionary 진입 시 한 번 좁혀서 그 아래 모든 헬퍼가 Language(4개)만 다루도록
 *  한다 — SelectionContext.language 가 tier2까지 포함하는 AnyLanguage 로 넓어졌기
 *  때문에(2026-07-30) 필요해진 타입. */
type DictSelectionContext = Omit<SelectionContext, 'language'> & { language: Language }

export async function lookupDictionary(
  rawCtx: SelectionContext,
  forceSource: DictionarySourceId | undefined,
  onChunk: (chunk: QuestionResult) => void,
): Promise<QuestionResult> {
  // tier2/3(AnyLanguage 중 Language 4개가 아닌 나머지)는 여기서 한 번만 걸러낸다 — 이
  // 아래로는 전부 DictSelectionContext(language: Language 로 좁혀짐)만 다닌다.
  if (!isFullLanguage(rawCtx.language)) {
    return emit(onChunk, { kind: 'dictionary', content: '이 언어는 아직 사전 검색을 지원하지 않습니다.' })
  }
  const ctx: DictSelectionContext = { ...rawCtx, language: rawCtx.language }
  const progress = createProgressEmitter(onChunk)

  // ============================================================================
  // 사전 소스 직접 선택 — 정식 기능(2026-07-30 격상, 팝업 드롭다운+토글, registry.ts 와
  // 한 세트). 사용자가 팝업의 "폴백/직접 선택" 토글을 "직접 선택"으로 켰을 때만
  // forceSource 가 채워져 들어온다(기본값은 토글 꺼짐=정식 폴백, PopupScreen.tsx 참고) —
  // 이 경로는 정식 폴백 체인 대신 사용자가 고른 소스 하나만 호출한다(다중 단어 분해 등
  // 나머지 동작은 lookupForcedSourceOnce 가 정식 폴백과 동일하게 공유).
  if (forceSource) {
    return emit(onChunk, await lookupForcedSource(forceSource, ctx, progress))
  }
  // ============================================================================

  const chain = FALLBACK_CHAINS[ctx.language]
  if (!chain.length) {
    return emit(onChunk, { kind: 'dictionary', content: '이 언어는 아직 사전 검색을 지원하지 않습니다.' })
  }

  const word = ctx.selectedText.trim()
  if (!word) {
    return emit(onChunk, { kind: 'dictionary', content: '선택된 표현이 없습니다.' })
  }

  const provider = getActiveProvider()
  if (!provider) {
    return emit(onChunk, buildErrorResult('dictionary', 'no_active_provider'))
  }
  const llmKey = getApiKey(provider)
  if (!llmKey) {
    return emit(onChunk, buildErrorResult('dictionary', 'no_api_key', provider))
  }

  const settings = getSettings()
  const client = createClient(provider, { apiKey: llmKey })
  const model = settings.models[provider] || DEFAULT_MODELS[provider]
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const llm: LlmDeps = { client, model, cacheableContext }

  const whole = await lookupChainWithJudge(word, ctx, llm, progress)
  if (whole.formatted) {
    return emit(onChunk, {
      kind: 'dictionary',
      content: whole.formatted,
      meta: { provider, source: whole.sourceId },
    })
  }
  if (whole.llmError) {
    return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(whole.llmError), provider))
  }

  // 통째 조회가 체인 끝까지 실패 — 단어 단위로 쪼개 각각 같은 체인을 재시도한다
  // (2026-07-30, en 전용이던 걸 ja/zh 로 확장 — "popup 이 이미 원자 단위로 선택해줘서
  // 재분할이 의미 없다"는 예전 가정은, 드래그로 여러 단어/문장 범위를 잡을 수 있다는
  // 걸 놓친 것이었다. "must have been exorbitant" 류 다중 단어 사전 못 찾음 제보로 발견).
  // 단어 분해는 여기서 다시 하지 않고 ctx.words 를 그대로 쓴다(2026-07-30) — 팝업이
  // 선택 범위를 확정할 때 이미 같은 분해(popup/selection.ts tokenizeAtoms — 영어/라틴
  // 하이픈 분리, 일본어 조사·조동사 병합, 중국어 세그멘터)를 거쳐뒀으므로, 여기서 en은
  // 공백/하이픈 정규식으로, ja/zh 는 형태소 분석기를 다시 호출해 별도 기준으로 쪼개면
  // 팝업에서 보인 단어 단위와 사전 조회 단위가 어긋날 수 있었다.
  //
  // 단어별 폴백은 "체인 어디에도 없음"뿐 아니라 "사전엔 있었지만 어느 소스에서도 문맥에
  // 맞는 뜻이 없었음"(whole.noContextMatch)일 때도 시도한다(2026-07-31) — 후자도 통째
  // 표제어로는 답을 못 준 것이므로 단어별로 쪼개보는 게 그냥 포기하는 것보다 낫다.
  const words = ctx.words.map((w) => w.text)
  if (words.length > 1 && words.length <= MAX_FALLBACK_WORDS) {
    progress(`통째로는 답을 못 찾아 단어별로 다시 검색합니다: ${words.join(', ')}`)
    const perWordResults = await Promise.allSettled(
      words.map((w) => lookupSingleWordThroughChain(w, ctx, llm, progress)),
    )
    const outcomes = perWordResults.map((r) => (r.status === 'fulfilled' ? r.value : null))

    const formattedBlocks = outcomes
      .filter((o): o is { formatted: string } => o !== null && 'formatted' in o)
      .map((o) => o.formatted)

    if (formattedBlocks.length) {
      return emit(onChunk, {
        kind: 'dictionary',
        content: formattedBlocks.join('\n\n---\n\n'),
        meta: { provider },
      })
    }
    // 단어 전부가 사전에 없는 것과, LLM 호출 자체가 전부 실패한 것(잘못된 모델 등)은
    // 원인이 다르다 — 후자를 "사전에서 못 찾음"으로 뭉개면 사용자가 엉뚱한 곳을
    // 의심하게 되므로, 있었으면 그걸 그대로 보여준다(개별 소스 조회 실패는 체인 내부에서
    // 이미 다음 소스로 흡수되므로 여기까지 올라오지 않는다 — lookupChainWithJudge 참고).
    const llmError = outcomes.find((o): o is { llmError: unknown } => o !== null && 'llmError' in o)
    if (llmError) {
      return emit(onChunk, buildErrorResult('dictionary', classifyLlmError(llmError.llmError), provider))
    }
  }

  // 사전에는 있었지만 어느 소스에서도 문맥에 맞는 뜻을 못 골랐다면, 마지막 수단으로
  // 체인에서 가장 우선순위가 높았던 소스의 안내문(뜻 후보 자체는 있었다는 사실)을 보여준다.
  if (whole.noContextMatch) {
    return emit(onChunk, {
      kind: 'dictionary',
      content: whole.noContextMatch.formatted,
      meta: { provider, source: whole.noContextMatch.source },
    })
  }
  if (words.length > MAX_FALLBACK_WORDS) {
    // 긴 속담/관용구는 사용자가 실제로 드래그한 표면형(대명사·부속어 포함)으로는 통째
    // 조회가 거의 항상 실패하지만(실측: "don't count your chickens before they hatch" 등),
    // MW 가 정규화된 표제어를 suggestions 로 이미 알려주는 경우가 많아(실측: "count one's
    // chickens (before they hatch)") 단어별 폴백보다 이게 더 쓸모 있다 — 버리지 않고 보여준다.
    const suggestion = whole.suggestions?.length
      ? ` (제안: ${whole.suggestions.slice(0, 5).join(', ')})`
      : ''
    return emit(onChunk, {
      kind: 'dictionary',
      content: `선택 범위가 너무 넓어 사전 검색을 건너뜁니다(단어 ${words.length}개, 최대 ${MAX_FALLBACK_WORDS}개).${suggestion}`,
    })
  }
  return emit(onChunk, notFoundResult(word, whole.suggestions))
}

// ---- 진행 상황(채팅창 실시간 표시) --------------------------------------------

/** 진행 상황 한 줄을 채팅창으로 흘려보내는 콜백 — 사전 체인 전 구간이 공유한다. */
type ProgressFn = (text: string) => void

/** meta.progress 가 붙은 청크는 답변 본문이 아니라 "지금 무엇을 하는 중인지"를 알리는
 *  진행 로그다 — 렌더러가 말풍선 위에 회색 줄로 쌓아 두고, 최종 결과(질문 IPC 의 반환값)가
 *  도착하는 순간 통째로 지운다(PopupScreen.tsx). content 를 누적(meta.streaming)하는
 *  LLM 델타와 달리 본문에는 절대 섞이지 않는다. */
function createProgressEmitter(onChunk: (chunk: QuestionResult) => void): ProgressFn {
  return (text) => onChunk({ kind: 'dictionary', content: text, meta: { progress: true } })
}

/** 진행 로그 한 줄의 접두사 — 단어별 폴백은 여러 단어의 조회가 동시에 진행돼 로그가
 *  뒤섞이므로 어느 단어 얘기인지 앞에 붙여준다(통째 조회 경로는 빈 문자열). */
function progressTag(word: string | undefined): string {
  return word ? `[${word}] ` : ''
}

// ---- 폴백 체인 실행 -----------------------------------------------------------

interface ChainJudgeOutcome {
  /** 문맥에 맞는 뜻까지 골라낸 최종 서식 결과 — 이게 있으면 성공. */
  formatted?: string
  sourceId?: DictionarySourceId
  suggestions?: string[]
  /** LLM 호출 자체가 실패(잘못된 모델·키 등) — "사전에 없음"과 구분해야 한다. */
  llmError?: unknown
  /** 사전엔 뜻이 있었지만 LLM 이 문맥에 맞는 뜻을 못 고른 경우(2026-07-31) — 이제 여기서
   *  멈추지 않고 다음 사전으로 계속 폴백하되, 체인이 끝까지 다 실패했을 때 보여줄
   *  "문맥에 맞는 뜻을 찾지 못했습니다" 안내문은 가장 우선순위가 높았던 소스 것으로 남겨둔다. */
  noContextMatch?: { formatted: string; source: DictionarySourceId }
}

/** judgeAndFormat 에 필요한 LLM 호출 재료 묶음 — 체인/단어별 폴백 전 구간에 그대로 전달된다. */
interface LlmDeps {
  client: ReturnType<typeof createClient>
  model: string
  cacheableContext: string
}

/** ja 전용 — 조회 후보 목록(표면형 + 있으면 활용형 기본형)을 만든다. daijisen·JMdict가
 *  전부 활용형을 원형으로 자동 변환해주지 않아서(TODO.md 131번 항목), 표면형만으로는
 *  둘 다 "못 찾음"으로 끝나 버리는데, 이 상태로 다음 소스(Wiktionary)까지 넘어가면
 *  안 된다 — Wiktionary는 활용형 자체에도 "conjunctive form of 歩く" 같은 한 줄짜리
 *  굴절 안내 페이지를 갖고 있어(실측: 歩いて/食べた) daijisen/JMdict가 원형으로는
 *  풍부하게 줄 수 있는 뜻풀이 대신 이 얇은 한 줄로 조용히 만족해버리기 때문. 그래서
 *  daijisen/JMdict **각각**이 표면형에 이어 기본형까지 시도해보고, 그래도 둘 다 못
 *  찾을 때만 Wiktionary로 넘어가게 후보를 소스보다 안쪽 루프에 둔다(아래
 *  lookupThroughFallbackChain 참고). 표면형을 항상 먼저 두는 이유는 "犬も歩けば棒に
 *  当たる" 같은 관용구는 활용형 변환 없이 표면형 그대로가 정답이라, 기본형을 먼저
 *  시도하면 이런 경우를 깨뜨리기 때문. */
async function japaneseWordCandidates(word: string, ctx: DictSelectionContext): Promise<string[]> {
  const baseForm = await toJapaneseDictionaryBaseForm(word, ctx).catch(() => null)
  return baseForm && baseForm !== word ? [word, baseForm] : [word]
}

/** en 전용 — 규칙동사/규칙명사 활용형의 원형 후보를 추측한다(WordNet Morphy 알고리즘의
 *  detachment rule 일부를 재구현, 별도 라이브러리 없이 접미사 규칙만). MW는 자체
 *  교차참조(uros/stems)로, OEWN은 formIndex(비정규 활용형 위주)로 각자 활용형을 어느
 *  정도 처리하지만, **OEWN의 formIndex는 정규 활용(-ed/-ing/-s)을 거의 안 담고 있어서**
 *  (실측: "close"/"want"/"walk"/"look" 전부 `form: null`) "walked"/"looked" 같은 흔한
 *  규칙동사 과거형은 OEWN 단독으로 못 찾는다(2026-07-28 확인) — MW 키가 없으면 이
 *  간극이 그대로 Wiktionary의 얇은 굴절 안내 한 줄("simple past and past participle of
 *  walk")로 이어진다. 정확한 철자 규칙 판별(사전 대조) 없이 후보를 여러 개 만들어
 *  전부 시도하는 방식이라(예: "closed" → "clos"/"close"/"clos" 자음축약 등) 틀린
 *  후보는 각 소스에서 조용히 "못 찾음"으로 끝나 무해하다. */
function guessEnglishBaseForms(word: string): string[] {
  const lower = word.toLowerCase()
  if (lower === word && lower.length < 4) return []
  if (/['’]/.test(word)) return [] // 축약형("they're" 등)은 stripContraction이 따로 처리
  const candidates = new Set<string>()

  const maybeUndoubleAndAdd = (stem: string) => {
    candidates.add(stem)
    candidates.add(`${stem}e`)
    const last = stem.at(-1)
    const secondLast = stem.at(-2)
    if (last && last === secondLast && !'aeiou'.includes(last)) candidates.add(stem.slice(0, -1))
  }

  if (lower.endsWith('ied') && lower.length > 4) candidates.add(`${lower.slice(0, -3)}y`)
  else if (lower.endsWith('ed') && lower.length > 3) maybeUndoubleAndAdd(lower.slice(0, -2))

  if (lower.endsWith('ing') && lower.length > 4) maybeUndoubleAndAdd(lower.slice(0, -3))

  if (lower.endsWith('ies') && lower.length > 4) candidates.add(`${lower.slice(0, -3)}y`)
  else if (lower.endsWith('es') && lower.length > 3) candidates.add(lower.slice(0, -2))
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) candidates.add(lower.slice(0, -1))

  candidates.delete(word)
  candidates.delete(lower)
  return [...candidates]
}

/** en 축약형("they're"/"isn't" 등)의 원래 단어 후보를 뽑는다 — 실사용 중 발견(2026-07-29):
 *  "they're"를 MW로 조회하면 `posRaw: "contraction", gloss: ["they are"]` 한 줄짜리
 *  얇은 답만 나오는데(문법적 설명일 뿐, 대명사 "they" 자체의 뜻풀이가 아님), 정작
 *  유용한 답은 "they"(대명사, "누구를 가리키는지" 등 실제 뜻풀이 여러 개)에 있다.
 *  "n't"(isn't/don't/won't 등)는 어미를 통째로 떼야 하고("aren't"→"are", 어간+"n't"
 *  분리가 아님), "won't"/"can't"는 규칙과 다른 불규칙 축약이라 따로 처리한다. 나머지
 *  ('re/'ve/'ll/'d/'m/'s)는 어퍼스트로피 앞부분을 그대로 쓰면 된다.
 *
 *  입력은 normalizeApostrophes 를 거친 ASCII 어퍼스트로피 표기를 전제한다. */
function stripContraction(word: string): string | null {
  const lower = word.toLowerCase()
  if (lower === "won't") return 'will'
  if (lower === "can't") return 'can'
  if (lower.endsWith("n't") && lower.length > 3) return word.slice(0, -3)
  for (const suffix of ["'re", "'ve", "'ll", "'d", "'m", "'s"]) {
    if (lower.endsWith(suffix)) return word.slice(0, -suffix.length)
  }
  return null
}

/** 활자용 어퍼스트로피(’ U+2019, ‘ U+2018, ʼ U+02BC)를 ASCII `'` 로 통일한다 —
 *  실사용 중 발견(2026-07-31): EPUB/웹 본문은 대부분 `’`를 쓰는데(실측: "hadn’t"),
 *  토크나이저(`WORD_ATOM_PATTERN`)는 `['’]` 둘 다 단어에 포함시키는 반면 축약형 판정은
 *  ASCII `'` 기준이라, "hadn’t"가 축약형으로 인식되지 않아 원래 단어("had")를 아예
 *  후보에 넣지 못하고 표면형 통짜로만 조회됐다(→ Wiktionary의 "축약형" 한 줄 설명만 나옴). */
function normalizeApostrophes(word: string): string {
  return word.replace(/[‘’ʼ]/g, "'")
}

function englishWordCandidates(word: string): string[] {
  const candidates: string[] = []
  const add = (c: string): void => {
    if (c && !candidates.includes(c)) candidates.push(c)
  }

  add(word)
  // 표면형과 별개로 ASCII 표기도 후보에 둔다 — 사전에 따라 `’` 표제어를 못 찾을 수 있다.
  const normalized = normalizeApostrophes(word)
  add(normalized)

  for (const base of guessEnglishBaseForms(normalized)) add(base)
  const contractionBase = stripContraction(normalized)
  if (contractionBase) add(contractionBase)
  return candidates
}

/** FALLBACK_CHAINS 를 앞에서부터 순서대로 시도해 sense 가 하나라도 있는 첫 소스에서
 *  멈춘다("앞 소스가 못 찾을 때만 다음으로" — TODO.md/DICTIONARY_SOURCES.md 확정 순서).
 *  개별 소스 실패(네트워크 에러 등)도 "여기선 못 찾음"과 동일하게 다음 소스로 넘어간다 —
 *  폴백 체인은 중간 실패를 사용자에게 구구절절 보여주기보다 끝까지 시도해보고 그래도
 *  안 되면 그때 "찾지 못함"으로 뭉뚱그린다(개별 에러는 진단용으로 console.warn 만 남김).
 *  ja/en 은 소스 하나당 여러 후보 표면형(japaneseWordCandidates/englishWordCandidates)을
 *  안쪽에서 전부 시도한 뒤에야 다음 소스로 넘어간다 — "daijisen/JMdict/OEWN이 활용형
 *  이라 못 찾은 것"과 "이 단어 자체가 그 소스엔 아예 없는 것"을 구분해, 전자면
 *  Wiktionary로 넘어가기 전에 상위 소스 안에서 기본형으로 먼저 구제한다.
 *
 *  **후보 전부를 시도하고 결과를 합친다(첫 성공에서 멈추지 않음)** — 처음엔 후보 중
 *  하나라도 성공하면 바로 반환했는데, 실측으로 발견: OEWN에 "closed"를 그대로 물으면
 *  그 자체로 형용사 표제어("not open")가 있어 "성공"으로 끝나버려서, 뒤에 이어 시도할
 *  "close"(동사, "닫다") 후보를 아예 안 물어보게 된다 — 문맥이 동사 용법("She closed
 *  the door")이어도 LLM 후보 목록에 동사 뜻 자체가 없어 고를 수가 없었다. 표면형과
 *  추측 후보가 서로 다른 뜻일 수 있으니(동형이의어), 소스 하나 안에서는 후보 전부를
 *  시도해 나온 entries 를 전부 합쳐 LLM 후보 목록에 넣는다. **트레이드오프**: ja 관용구
 *  ("犬も歩けば棒に当たる")도 첫 토큰("犬")이 그 자체로 유효한 표제어라 관용구 자체의
 *  뜻과 "犬"(개) 단독의 여러 뜻이 함께 후보에 섞인다 — 틀린 답이 되는 건 아니고
 *  후보만 늘어나는 정도라 감수하기로 함(2026-07-29). */
async function wordCandidatesFor(word: string, ctx: DictSelectionContext): Promise<string[]> {
  if (ctx.language === 'ja') return japaneseWordCandidates(word, ctx)
  if (ctx.language === 'en') return englishWordCandidates(word)
  return [word]
}

/** 폴백 체인을 앞에서부터 돌면서 소스마다 "조회 → LLM 판정/번역"까지 끝내고, 문맥에 맞는
 *  뜻을 실제로 고른 첫 소스에서 멈춘다.
 *
 *  **판정을 체인 안으로 들여왔다(2026-07-31)** — 예전엔 "sense 가 하나라도 있는 첫 소스"에서
 *  체인을 끝내고 그 뒤에 판정을 한 번만 돌려서, 사전엔 뜻이 있는데 LLM 이 "문맥에 맞는 게
 *  없다"(번호: 0)고 답하면 거기서 그냥 끝나버렸다 — 뒤에 남아 있는 사전들은 시도조차 안 했다.
 *  이제는 그 경우도 "이 소스는 실패"로 보고 다음 소스로 계속 폴백한다(사용자 요청). 체인이
 *  끝까지 다 실패하면 그 중 가장 앞선 소스의 안내문을 noContextMatch 로 돌려준다. */
async function lookupChainWithJudge(
  word: string,
  ctx: DictSelectionContext,
  llm: LlmDeps,
  progress: ProgressFn,
  /** 단어별 폴백에서 여러 조회가 동시에 돌 때 진행 로그를 구분하기 위한 접두사용 단어. */
  tagWord?: string,
): Promise<ChainJudgeOutcome> {
  const chain = FALLBACK_CHAINS[ctx.language]
  const candidates = await wordCandidatesFor(word, ctx)
  const tag = progressTag(tagWord)
  let suggestions: string[] | undefined
  let noContextMatch: ChainJudgeOutcome['noContextMatch']

  for (const [i, source] of chain.entries()) {
    const label = SOURCE_LABELS[source]
    const nextNote = i === chain.length - 1 ? ' (더 시도할 사전 없음)' : ' → 다음 사전으로'
    progress(`${tag}${label}에서 "${word}" 검색 중...`)

    const collectedEntries: DictionaryEntry<Language>[] = []
    const matchedCandidates: string[] = []
    for (const candidate of candidates) {
      try {
        const result = await fetchSourceEntries(source, ctx, candidate)
        suggestions ??= result.suggestions
        if (result.entries?.length) {
          collectedEntries.push(...result.entries)
          matchedCandidates.push(candidate)
        }
      } catch (err) {
        console.warn(`[dictionary] ${source}(${candidate}) 조회 실패, 다음으로 폴백:`, err)
      }
    }

    const senses = collectedEntries.length ? numberSenses(collectedEntries) : []
    if (!senses.length) {
      progress(`${tag}${label}: 결과 없음${nextNote}`)
      continue
    }

    progress(`${tag}${label}: 뜻 ${senses.length}개 발견 — 문맥에 맞는 뜻 고르는 중...`)
    const matchedWord = matchedCandidates.includes(word) ? word : (matchedCandidates[0] ?? word)
    const sourceId = collectedEntries[0].source
    const outcome = await judgeAndFormat({ word: matchedWord, source: sourceId, senses, ctx, ...llm })
    if (!outcome.ok) return { llmError: outcome.error, suggestions }

    const formatted = withDebugCountsLine(outcome.formatted, collectedEntries, senses.length, outcome.selected) // TEMP DEBUG
    if (outcome.selected.length) return { formatted, sourceId, suggestions }

    progress(`${tag}${label}: 문맥에 맞는 뜻 없음${nextNote}`)
    // 체인이 전부 실패했을 때 보여줄 안내문은 **가장 앞선(우선순위 높은)** 소스 것으로 —
    // 뒤로 갈수록 얇은 뜻풀이(Wiktionary 굴절 안내 등)라 사용자에게 덜 쓸모 있다.
    noContextMatch ??= { formatted, source: sourceId }
  }
  return { suggestions, noContextMatch }
}

/** 단어 하나를 폴백 체인 조회 → LLM 판정/번역까지 끝내 서식화된 마크다운으로 돌려준다.
 *  단어별 폴백 경로 전용 — "사전에 없는 단어"(null)와 "LLM 호출 자체가 실패함"(llmError)을
 *  구분해 돌려준다. 개별 소스 조회 실패는 lookupChainWithJudge 안에서 이미 다음 소스로
 *  흡수되므로 여기서 따로 구분할 필요가 없다. 체인 전체가 "문맥에 맞는 뜻 없음"으로 끝난
 *  경우엔 그 안내문이라도 블록으로 실어 보낸다 — 다른 단어는 답이 나왔는데 이 단어만
 *  통째로 사라지면 왜 빠졌는지 알 수 없기 때문. */
async function lookupSingleWordThroughChain(
  word: string,
  ctx: DictSelectionContext,
  llm: LlmDeps,
  progress: ProgressFn,
): Promise<{ formatted: string } | { llmError: unknown } | null> {
  const outcome = await lookupChainWithJudge(word, ctx, llm, progress, word)
  if (outcome.formatted) return { formatted: outcome.formatted }
  if (outcome.llmError) return { llmError: outcome.llmError }
  if (outcome.noContextMatch) return { formatted: outcome.noContextMatch.formatted }
  return null
}

interface JudgeAndFormatArgs {
  word: string
  source: DictionarySourceId
  senses: ReturnType<typeof numberSenses>
  ctx: DictSelectionContext
  client: ReturnType<typeof createClient>
  model: string
  cacheableContext: string
}

type JudgeAndFormatResult =
  | { ok: true; formatted: string; selected: ReturnType<typeof parseJudgeReply> }
  | { ok: false; error: unknown }

/** LLM 에 뜻풀이 후보를 판정+번역 요청한 뒤 채팅창용 마크다운으로 서식화한다 —
 *  통째 조회 경로와 단어별 폴백 경로가 공유하는 핵심 로직. */
async function judgeAndFormat(args: JudgeAndFormatArgs): Promise<JudgeAndFormatResult> {
  const { word, source, senses, ctx, client, model, cacheableContext } = args
  const system = renderPrompt(dictionaryPromptTemplate, { language: getLanguageName(ctx.language) })
  const prompt = `[선택된 표현]: ${word}\n\n[뜻풀이 후보]\n${buildSenseListText(senses)}`

  let reply: string
  try {
    // 판정+번역 전용 호출 — 델타를 onChunk 로 흘리지 않는다. 채팅창에 보일 최종 텍스트는
    // LLM 이 쓴 문장을 그대로 쓰는 게 아니라, formatDictionaryAnswer 가 그 번역 결과와
    // 사전 원본 데이터(품사·출처·활용형 등)를 조합해 직접 구성한다.
    reply = await client.stream(
      {
        system,
        cacheableContext,
        messages: [{ role: 'user', content: prompt }],
        model,
        maxTokens: DICTIONARY_JUDGE_MAX_TOKENS,
        temperature: DICTIONARY_JUDGE_TEMPERATURE,
      },
      () => {},
    )
  } catch (err) {
    // classifyLlmError가 'unknown'(원인불명)으로 분류하는 에러는 UI엔 뭉뚱그려 보여도
    // 콘솔엔 실제 원인을 남겨야 진단이 가능하다(2026-07-30, llm/adapter.ts streamLlm과
    // 동일 근거 — Claude "temperature is deprecated" 400 에러가 이 로그 덕에 잡혔음).
    console.error('[dictionary] judgeAndFormat LLM 호출 실패:', err)
    return { ok: false, error: err }
  }

  const selected = parseJudgeReply(reply, senses)
  return { ok: true, formatted: formatDictionaryAnswer(word, source, selected, ctx.language), selected }
}

/** ja 활용형(동사/형용사/な형용사+だ, 명사+する 복합동사 등) 표면형 → 사전 기본형 변환
 *  — 통째 표면형 조회가 실패했을 때만 호출된다(lookupDictionary 참고). 형태소 분석
 *  (main/nlp/japanese.ts, JA_ENGINE 설정값)의 첫 토큰만 본다 — ja/zh 는 팝업이 이미
 *  원자 단위로 선택돼 있어 "여러 단어"가 아니라 "하나의 활용된 단어"라는 전제(TODO.md
 *  131번 항목의 en 다중 단어 폴백과 다른 축).
 *  - 첫 토큰 자체가 활용됐으면(baseForm ≠ surface, 실측: 歩いた→歩く, 大きかった→大きい,
 *    静かだ→静か, はしゃぎ→はしゃぐ) 토큰 개수와 무관하게 그 기본형을 쓴다 — **활용된
 *    단어가 항상 토큰 2개(어간+활용어미)로 쪼개지는 건 아니다**(2026-07-29 실측 발견:
 *    "はしゃぎ"(동사 連用形이 그대로 명사처럼 쓰인 형태)는 단일 토큰인데도 baseForm이
 *    "はしゃぐ"로 이미 채워져 있음 — 예전엔 `tokens.length < 2`로 이런 단일 토큰 활용형을
 *    전부 걸러내 daijisen/JMdict 둘 다 표면형만으로 조회를 시도하다 실패했다).
 *  - 첫 토큰은 안 변했는데 뒤에 토큰이 더 있으면(명사+する 복합동사, 실측: 勉強する→
 *    勉強+する 2토큰, "勉強する"는 404지만 "勉強" 단독은 정상 조회됨) 첫 토큰의 표면형만
 *    따로 조회한다 — 뒤에 붙은 する/조사 등을 뗀 값.
 *  - 토큰이 하나뿐이고 활용도 없으면(이미 원형이거나 명사 등) null.
 *
 *  **재분석 없이 popup 이 이미 계산해둔 결과를 우선 재사용한다**(TODO.md 239번, 2026-07-30) —
 *  팝업이 원문 문맥의 atom 을 병합할 때(popup/selection.ts) 이미 이 word 전체를 형태소
 *  분석해뒀고, 그 결과 첫 atom 의 기본형이 ctx.words[0].baseForm 에 그대로 실려 온다
 *  (shared/nlp/ja.ts·ja-unidic.ts combine() 가 baseForm 을 보존하도록 수정). ctx.words[0]
 *  이 word 의 접두(prefix)와 일치할 때만 이 값을 신뢰하고, 그렇지 않으면(선택 범위가
 *  atom 경계와 어긋난 예외 상황 등) 예전처럼 word 를 다시 형태소 분석한다. */
async function toJapaneseDictionaryBaseForm(
  word: string,
  ctx: DictSelectionContext,
): Promise<string | null> {
  const first = ctx.words[0]
  if (first && word.startsWith(first.text)) {
    if (first.baseForm && first.baseForm !== first.text) return first.baseForm
    return ctx.words.length >= 2 ? first.text || null : null
  }
  const tokens = await tokenizeJapanese(word)
  const firstToken = tokens[0]
  if (!firstToken) return null
  if (firstToken.baseForm && firstToken.baseForm !== firstToken.surface) return firstToken.baseForm
  return tokens.length >= 2 ? firstToken.surface || null : null
}

function notFoundResult(word: string, suggestions?: string[]): QuestionResult {
  const suggestion = suggestions?.length ? ` (제안: ${suggestions.slice(0, 5).join(', ')})` : ''
  return { kind: 'dictionary', content: `사전에서 "${word}"를 찾지 못했습니다.${suggestion}` }
}

function emit(onChunk: (chunk: QuestionResult) => void, result: QuestionResult): QuestionResult {
  onChunk(result)
  return result
}

// ============================================================================
// TEMP DEBUG — LLM에 넘긴 entry/reading/sense 개수를 결과 맨 윗줄에 표시(임시, 제거
// 예정). 제거할 때는 이 함수 하나 + 호출부의 `// TEMP DEBUG` 표시가 붙은 줄들만
// 지우면 된다(각 호출부는 `withDebugCountsLine(outcome.formatted, ...)` →
// `outcome.formatted` 로 되돌리면 끝, 다른 로직은 안 건드려도 됨).
// ============================================================================
/**
 * UI 노출 스위치(2026-07-31, 사용자 요청 — "코드는 없애지 말고 UI에서만 안 보이게").
 * 조사할 일이 생기면 이 상수만 true 로 되돌리면 디버그 줄이 다시 채팅창 맨 위에 뜬다.
 * 아래 조립 로직과 호출부는 그대로 살아 있다.
 */
const SHOW_DEBUG_COUNTS_LINE = false

function withDebugCountsLine(
  formatted: string,
  entries: DictionaryEntry<Language>[] | undefined,
  senseCount: number,
  selected: ReturnType<typeof parseJudgeReply>,
): string {
  if (!SHOW_DEBUG_COUNTS_LINE) return formatted
  const entryCount = entries?.length ?? 0
  const readingCount = entries?.reduce((sum, e) => sum + e.readings.length, 0) ?? 0
  // LLM이 "대응어:" 줄을 실제로 줬는지 — combineTranslation이 길이 비율로 걸러내
  // 최종 번역에서는 대응어가 안 보일 수 있어(senseSelect.ts 참고), "LLM이 아예 안
  // 줬는지" vs "줬는데 로컬에서 걸렀는지"를 구분할 방법이 없다는 사용자 피드백으로
  // 추가(2026-07-29). 없으면 명시적으로 "없음"이라고 표시한다.
  const counterparts = selected
    .map((s) => `${s.sense.index}번: ${s.rawCounterpart ? `"${s.rawCounterpart}"` : '없음'}`)
    .join(', ')
  return `_[DEBUG] entries: ${entryCount} / readings: ${readingCount} / senses: ${senseCount} / 대응어(LLM 원본) — ${counterparts || '없음'}_\n\n${formatted}`
}

// ---- 소스별 조회 디스패치 — 폴백 체인과 forceSource 디버깅 경로가 공유 ----------------

/** API 키가 필요한데 없는 소스(현재 MW 뿐) — 폴백 체인에선 "이 소스 건너뜀"으로,
 *  forceSource 에선 "키를 입력해 주세요" 안내로 각자 소비한다. */
class MissingDictionaryApiKeyError extends Error {
  constructor(public source: DictionarySourceId) {
    super(`${source}: api key missing`)
  }
}

/** 언어 전용 소스를 그 언어가 아닌데 강제로 호출했을 때(forceSource 전용 케이스 — 정식
 *  폴백 체인은 FALLBACK_CHAINS 자체가 언어별로 이미 걸러져 있어 이 경로를 안 탄다). */
class UnsupportedLanguageDictionaryError extends Error {
  constructor(
    public source: DictionarySourceId,
    message: string,
  ) {
    super(message)
  }
}

/** 아직 어댑터가 이 디스패치에 안 붙은 소스. */
class SourceNotImplementedError extends Error {
  constructor(public source: DictionarySourceId) {
    super(`${source}: not implemented`)
  }
}

/** 소스 하나를 실제로 조회해 entries 를 뽑아온다 — 폴백 체인과 forceSource 디버깅 경로가
 *  공유하는 유일한 진입점(어댑터별 반환 모양이 다 달라 여기서 한 번만 흡수한다). 어댑터가
 *  던지는 에러(네트워크 실패 등)는 그대로 다시 던진다 — "이 소스만 건너뛰고 다음으로"
 *  (폴백 체인)와 "에러를 그대로 보여주기"(forceSource)를 호출부가 각자 판단하게 한다.
 *  MW만 suggestions 를 준다(나머지는 항상 undefined). */
async function fetchSourceEntries(
  source: DictionarySourceId,
  ctx: DictSelectionContext,
  word: string,
): Promise<{ entries?: DictionaryEntry<Language>[]; suggestions?: string[] }> {
  switch (source) {
    case 'merriam-webster': {
      if (ctx.language !== 'en') {
        throw new UnsupportedLanguageDictionaryError(source, 'Merriam-Webster는 영어 전용 사전입니다.')
      }
      const key = getApiKey('mw')
      if (!key) throw new MissingDictionaryApiKeyError(source)
      const lookup = await fetchMerriamWebsterEntry(word, key)
      return { entries: lookup.entries, suggestions: lookup.suggestions }
    }
    case 'wordnet': {
      if (ctx.language !== 'en') {
        throw new UnsupportedLanguageDictionaryError(source, 'OEWN은 영어 전용 사전입니다.')
      }
      return { entries: (await fetchOewnEntry(word)).entries }
    }
    case 'wiktionary': {
      const lookup = await fetchWiktionaryEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'daijisen': {
      if (ctx.language !== 'ja') {
        throw new UnsupportedLanguageDictionaryError(source, 'daijisen(デジタル大辞泉)은 일본어 전용 사전입니다.')
      }
      const lookup = await fetchDaijisenEntry(word)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'jmdict': {
      if (ctx.language !== 'ja') {
        throw new UnsupportedLanguageDictionaryError(source, 'JMdict는 일본어 전용 사전입니다.')
      }
      return { entries: (await fetchJmdictEntry(word)).entries }
    }
    case 'hanyu-dict': {
      if (ctx.language !== 'zh-Hans' && ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, '汉典은 중국어 전용 사전입니다.')
      }
      const lookup = await fetchHanyuEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'guoyu-cidian': {
      if (ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, '教育部重編國語辭典(萌典)은 중국어(번체) 전용 사전입니다.')
      }
      const lookup = await fetchGuoyuCidianEntry(word)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    case 'cc-cedict': {
      if (ctx.language !== 'zh-Hans' && ctx.language !== 'zh-Hant') {
        throw new UnsupportedLanguageDictionaryError(source, 'CC-CEDICT는 중국어 전용 사전입니다.')
      }
      const lookup = await fetchCcCedictEntry(word, ctx.language)
      return { entries: lookup.entry ? [lookup.entry] : undefined }
    }
    default:
      throw new SourceNotImplementedError(source)
  }
}

/** MW 요청 실패를 사람이 읽을 수 있는 메시지로 바꾼다. MW는 provider(LlmProvider)가
 *  아니라 classifyLlmError 대상이 아니고, 실측 확인(2026-07-28, 무효 키 직접 호출)한
 *  MW 특유의 함정도 있다 — 키가 무효해도 HTTP 200을 그대로 주고 본문에 "Invalid API
 *  key. Not subscribed for this reference." 같은 평문만 담아 보낸다(JSON 이 아니라
 *  파싱도 실패함). 이걸 구분 안 하면 죄다 "네트워크 오류"로 뭉뚱그려져 실제로는 키가
 *  잘못된 건데 사용자가 인터넷 연결을 의심하게 된다. */
function describeMerriamWebsterError(err: MerriamWebsterHttpError): string {
  const lower = err.body.toLowerCase()
  if (err.status === 401 || err.status === 403 || lower.includes('invalid api key')) {
    return 'Merriam-Webster API 키가 유효하지 않습니다. 설정에서 키를 다시 확인해 주세요.'
  }
  if (err.status === 429) {
    return 'Merriam-Webster 요청이 너무 많습니다(무료 티어 일일 한도를 초과했을 수 있습니다). 잠시 후 다시 시도해 주세요.'
  }
  if (err.status >= 500) {
    return 'Merriam-Webster 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
  }
  return 'Merriam-Webster 사전 조회에 실패했습니다.'
}

/** fetchSourceEntries 가 던진 에러를 forceSource(사전 소스 직접 선택) 전용으로 사람이
 *  읽을 메시지로 바꾼다 — 폴백 체인은 이 함수를 쓰지 않고 에러를 그냥 흡수한다(위
 *  lookupThroughFallbackChain 참고). 개별 소스 실패 원인을 사용자에게 바로 보여줘야
 *  하는 건 forceSource 뿐이라 여기 몰아뒀다. */
function describeSourceError(source: DictionarySourceId, err: unknown): string {
  if (err instanceof UnsupportedLanguageDictionaryError) return err.message
  if (err instanceof SourceNotImplementedError) {
    return `"${source}" 어댑터는 아직 직접 선택 기능에 연결되지 않았습니다.`
  }
  if (err instanceof MissingDictionaryApiKeyError) {
    return 'Merriam-Webster 사전 API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.'
  }
  if (err instanceof MerriamWebsterHttpError) return describeMerriamWebsterError(err)
  if (
    err instanceof DaijisenHttpError ||
    err instanceof HanyuHttpError ||
    err instanceof GuoyuCidianHttpError ||
    err instanceof WiktionaryHttpError
  ) {
    if (err.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
    if (err.status >= 500) return '사전 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
    return '사전 조회에 실패했습니다.'
  }
  return '네트워크 연결에 문제가 있어 사전 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

// ============================================================================
// 사전 소스 직접 선택 구현부 — 정식 기능(2026-07-30 격상, 위 forceSource 블록과 한 세트).
// fetchSourceEntries(위, 정식 폴백 체인과 공유)로 고른 소스 하나만 호출하고, 그 뒤(sense
// 번호매김 → LLM 판정/번역 → 서식화)는 정식 폴백 플로우와 완전히 같은 judgeAndFormat/
// numberSenses(senseSelect.ts)를 그대로 재사용한다 — 로직을 복붙하지 않기 위함. 다중 단어
// 분해(splitIntoDictionaryWords)도 정식 폴백과 동일하게 적용된다(lookupForcedSourceOnce).
// ============================================================================
interface ForcedSourceOnceResult {
  formatted?: string
  /** 사전엔 뜻이 있었지만 LLM 이 문맥에 맞는 뜻을 못 고른 경우의 안내문(2026-07-31) —
   *  성공(formatted)과 구분해야 이 경우에도 단어별 분해 재시도로 넘어갈 수 있다. 강제
   *  소스 경로는 소스가 하나로 고정돼 있어 정식 체인처럼 "다음 사전"으로는 못 넘어간다. */
  noContextFormatted?: string
  entries?: DictionaryEntry<Language>[]
  suggestions?: string[]
  firstCandidateError?: unknown
  llmError?: unknown
}

/** 강제 소스 선택 한 단어(또는 phrase) 조회 — lookupForcedSource가 통째 조회와 en 단어별
 *  폴백(아래) 양쪽에서 공유한다. */
async function lookupForcedSourceOnce(
  source: DictionarySourceId,
  ctx: DictSelectionContext,
  word: string,
  llm: LlmDeps,
  progress: ProgressFn,
  /** 단어별 폴백에서 여러 조회가 동시에 돌 때 진행 로그를 구분하기 위한 접두사용 단어. */
  tagWord?: string,
): Promise<ForcedSourceOnceResult> {
  // 활용형→기본형 후보(japaneseWordCandidates/englishWordCandidates)를 전부 시도해
  // entries 를 합친다(2026-07-29) — 이전엔 표면형 하나만 쿼리해서 "行って"(行く의 て형)처럼
  // daijisen/JMdict/Wiktionary 어느 소스를 골라도 항상 "못 찾음"이었다. 후보 중 하나가 그
  // 자체로도 표제어일 수 있어도(실측: "食べられる"가 JMdict에 가능형 "to be able to eat"으로
  // 직접 등재돼 있음) 첫 성공에서 멈추지 않고 기본형("食べる") 후보까지 마저 시도해 entries
  // 를 합친다 — 그래야 LLM 후보 목록에 원형 타동사 "먹다" 뜻도 함께 들어가 문맥에 맞게 고를
  // 수 있다(체인 쪽 "closed"/"close" 사례와 동일한 이유, 위 lookupThroughFallbackChain
  // 주석 참고). 표면형(첫 후보) 조회 실패만 설정 문제(키 미설정 등)일 수 있어 그대로
  // 보여주고, 그 다음 후보들의 실패는 체인과 동일하게 조용히 다음 후보로 넘어간다.
  const candidates = await wordCandidatesFor(word, ctx)
  const tag = progressTag(tagWord)
  const label = SOURCE_LABELS[source]
  progress(`${tag}${label}에서 "${word}" 검색 중...`)
  const collectedEntries: DictionaryEntry<Language>[] = []
  const matchedCandidates: string[] = []
  let suggestions: string[] | undefined
  let firstCandidateError: unknown
  for (const [i, candidate] of candidates.entries()) {
    try {
      const r = await fetchSourceEntries(source, ctx, candidate)
      suggestions ??= r.suggestions
      if (r.entries?.length) {
        collectedEntries.push(...r.entries)
        matchedCandidates.push(candidate)
      }
    } catch (err) {
      if (i === 0) firstCandidateError = err
      else console.warn(`[dictionary] ${source}(${candidate}) 강제 조회 실패, 다음 후보로:`, err)
    }
  }

  const senses = collectedEntries.length ? numberSenses(collectedEntries) : []
  if (!senses.length) {
    progress(`${tag}${label}: 결과 없음`)
    return { suggestions, firstCandidateError }
  }

  progress(`${tag}${label}: 뜻 ${senses.length}개 발견 — 문맥에 맞는 뜻 고르는 중...`)
  const outcome = await judgeAndFormat({
    word: matchedCandidates.includes(word) ? word : (matchedCandidates[0] ?? word),
    source: collectedEntries[0].source,
    senses,
    ctx,
    ...llm,
  })
  if (!outcome.ok) return { llmError: outcome.error, entries: collectedEntries }
  const formatted = withDebugCountsLine(outcome.formatted, collectedEntries, senses.length, outcome.selected) // TEMP DEBUG
  if (!outcome.selected.length) {
    progress(`${tag}${label}: 문맥에 맞는 뜻 없음`)
    return { noContextFormatted: formatted, entries: collectedEntries, suggestions }
  }
  return { formatted, entries: collectedEntries }
}

async function lookupForcedSource(
  source: DictionarySourceId,
  ctx: DictSelectionContext,
  progress: ProgressFn,
): Promise<QuestionResult> {
  const word = ctx.selectedText.trim()
  if (!word) {
    return { kind: 'dictionary', content: '선택된 표현이 없습니다.' }
  }

  const provider = getActiveProvider()
  if (!provider) return buildErrorResult('dictionary', 'no_active_provider')
  const llmKey = getApiKey(provider)
  if (!llmKey) return buildErrorResult('dictionary', 'no_api_key', provider)

  const settings = getSettings()
  const client = createClient(provider, { apiKey: llmKey })
  const model = settings.models[provider] || DEFAULT_MODELS[provider]
  const cacheableContext = buildContextBlock(ctx, settings.contextBytesBefore, settings.contextBytesAfter)

  const llm: LlmDeps = { client, model, cacheableContext }

  const whole = await lookupForcedSourceOnce(source, ctx, word, llm, progress)
  if (whole.formatted) {
    return {
      kind: 'dictionary',
      content: whole.formatted,
      meta: { provider, source: whole.entries?.[0]?.source },
    }
  }
  if (whole.llmError) return buildErrorResult('dictionary', classifyLlmError(whole.llmError), provider)
  if (whole.firstCandidateError) {
    return { kind: 'dictionary', content: describeSourceError(source, whole.firstCandidateError) }
  }

  // 정식 폴백(lookupDictionary)과 동일하게 다중 단어는 단어 단위로 쪼개 강제 소스를
  // 각각 재시도한다(2026-07-30) — 이 강제 소스 선택 경로엔 원래 이 분해 로직이 아예
  // 없어서 "must have been exorbitant" 같은 phrase가 (표제어가 아니니 당연히) 통째로
  // "못 찾음" 처리됐다. "직접 선택" 토글 기본값이 켜져 있어(Toolbar.tsx) 실사용에서도
  // 이 경로를 자주 타므로 정식 경로와 동작을 맞춘다. "강제"는 소스 하나만 고정한다는
  // 뜻이지 그 소스 내부 폴백(단어 분해 포함)까지 건너뛴다는 뜻이 아니다.
  //
  // 정식 체인과 마찬가지로(2026-07-31) "사전엔 있었지만 문맥에 맞는 뜻이 없음"도 통째
  // 조회 실패로 보고 단어별 분해까지 마저 시도한다 — 소스가 하나로 고정된 경로라 "다음
  // 사전"은 없지만, 단어 단위 재조회는 그대로 남은 수단이다.
  const words = ctx.words.map((w) => w.text)
  if (words.length > 1 && words.length <= MAX_FALLBACK_WORDS) {
    progress(`통째로는 답을 못 찾아 단어별로 다시 검색합니다: ${words.join(', ')}`)
    const perWordResults = await Promise.allSettled(
      words.map((w) => lookupForcedSourceOnce(source, ctx, w, llm, progress, w)),
    )
    const formattedBlocks = perWordResults
      .map((r) => (r.status === 'fulfilled' ? (r.value.formatted ?? r.value.noContextFormatted) : undefined))
      .filter((f): f is string => Boolean(f))

    if (formattedBlocks.length) {
      return {
        kind: 'dictionary',
        content: formattedBlocks.join('\n\n---\n\n'),
        meta: { provider, source },
      }
    }
    const llmErrorResult = perWordResults.find(
      (r): r is PromiseFulfilledResult<ForcedSourceOnceResult> =>
        r.status === 'fulfilled' && r.value.llmError !== undefined,
    )
    if (llmErrorResult) {
      return buildErrorResult('dictionary', classifyLlmError(llmErrorResult.value.llmError), provider)
    }
  }

  if (whole.noContextFormatted) {
    return {
      kind: 'dictionary',
      content: whole.noContextFormatted,
      meta: { provider, source: whole.entries?.[0]?.source ?? source },
    }
  }
  if (words.length > MAX_FALLBACK_WORDS) {
    const suggestion = whole.suggestions?.length
      ? ` (제안: ${whole.suggestions.slice(0, 5).join(', ')})`
      : ''
    return {
      kind: 'dictionary',
      content: `선택 범위가 너무 넓어 사전 검색을 건너뜁니다(단어 ${words.length}개, 최대 ${MAX_FALLBACK_WORDS}개).${suggestion}`,
    }
  }
  return notFoundResult(word, whole.suggestions)
}
