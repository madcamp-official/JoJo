import type { DictionarySourceId, DictionarySourceOption, Language } from '@shared/types'

// 담당 공동 — 사전 어댑터 병렬 구현 중 디버깅용 "소스 선택" 드롭다운의 자동 감지 기반
// (2026-07-28 임시 도입). en/ja/zh 어댑터가 각자 다른 워크트리에서 병렬로
// `question/dictionary/{merriamWebster,oewn,daijisen,jmdict,hanyu,guoyuCidian,cccedict,wiktionary}.ts`
// 파일로 구현되고 있다 — 어느 브랜치가 먼저 머지되든, 이 파일이 재등록 없이도 자동으로
// 알아채야 하므로 "그 파일이 실제로 존재하는가"를 Vite 의 `import.meta.glob`(빌드 타임에
// 디렉터리를 스캔, 없는 파일을 나열해도 에러 안 남 — 나중에 파일이 생기면 다음 빌드/
// dev 재시작 때 자동으로 포함됨)으로 감지한다. **실제 폴백 오케스트레이션은
// `question/dictionary.ts`의 `FALLBACK_CHAINS`로 구현 완료(2026-07-28)** — 이 파일은
// 여전히 "무엇이 구현돼 있는지 알아내서 드롭다운에 보여주는" 역할만 하고, 팝업의 "직접
// 선택" 토글을 켰을 때만 여기서 감지한 소스를 강제 호출하는 데 쓰인다(꺼져 있으면
// 드롭다운 선택과 무관하게 정식 폴백 체인이 실행됨).
//
// **한계**: 파일이 존재하면 "구현됨"으로 간주한다 — 파일은 있지만 아직 미완성인 경우까지는
// 구분 못 함(디버깅용 임시 기능이라 이 정도 단순화로 결정).

interface SourceMeta {
  id: DictionarySourceId
  label: string
  /** 언어별 폴백 순위(1 이 최우선) — TODO.md/DICTIONARY_SOURCES.md 에 확정된 폴백 순서 그대로. */
  priority: Partial<Record<Language, number>>
}

/** 파일 베이스네임(확장자 제외) → 소스 메타데이터. 실제 폴백 순서는 en: MW>OEWN,
 *  ja: daijisen(デジタル大辞泉)>JMdict, zh-Hans: 汉典>CC-CEDICT,
 *  zh-Hant: guoyu-cidian(教育部重編國語辭典)>汉典>CC-CEDICT, 공통 최종 폴백 Wiktionary. */
const SOURCE_META: Record<string, SourceMeta> = {
  merriamWebster: { id: 'merriam-webster', label: 'Merriam-Webster', priority: { en: 1 } },
  oewn: { id: 'wordnet', label: 'Open English WordNet', priority: { en: 2 } },
  daijisen: { id: 'daijisen', label: 'デジタル大辞泉', priority: { ja: 1 } },
  jmdict: { id: 'jmdict', label: 'JMdict', priority: { ja: 2 } },
  hanyu: { id: 'hanyu-dict', label: '汉典', priority: { 'zh-Hans': 1, 'zh-Hant': 2 } },
  guoyuCidian: { id: 'guoyu-cidian', label: '教育部重編國語辭典', priority: { 'zh-Hant': 1 } },
  cccedict: { id: 'cc-cedict', label: 'CC-CEDICT', priority: { 'zh-Hans': 2, 'zh-Hant': 3 } },
  wiktionary: { id: 'wiktionary', label: 'Wiktionary', priority: { en: 3, ja: 3, 'zh-Hans': 3, 'zh-Hant': 4 } },
}

// 명시적 파일 목록만 검사(디렉터리 전체 `*.ts` 와일드카드가 아님) — 같은 디렉터리에 올
// 수 있는 어댑터 전용 헬퍼 파일(예: mw.ts 가 쓰는 mwToIpa.ts/senseSelect.ts, 이 registry.ts
// 자신)이 소스 목록에 잘못 섞여 들어가는 것을 막는다. 나열된 파일이 지금 존재하지
// 않아도 에러 없이 그냥 빠진다 — 나중에 그 브랜치가 머지되면 다음 빌드에서 자동 포함.
const adapterModules = import.meta.glob(
  [
    './merriamWebster.ts',
    './oewn.ts',
    './daijisen.ts',
    './jmdict.ts',
    './hanyu.ts',
    './guoyuCidian.ts',
    './cccedict.ts',
    './wiktionary.ts',
  ],
  { eager: false },
)

/** 지금 이 언어에 대해 실제로 구현돼 있는(=파일이 존재하는) 소스를, 폴백 순위대로
 *  정렬해 돌려준다(0번째가 최우선순위 = 기본 선택값). 아무것도 없으면 빈 배열. */
export function listAvailableDictionarySources(language: Language): DictionarySourceOption[] {
  return Object.keys(adapterModules)
    .map((path) => path.replace(/^\.\//, '').replace(/\.ts$/, ''))
    .map((base) => SOURCE_META[base])
    .filter((meta): meta is SourceMeta => meta !== undefined && meta.priority[language] !== undefined)
    .map((meta) => ({ id: meta.id, label: meta.label, priority: meta.priority[language]! }))
    .sort((a, b) => a.priority - b.priority)
}
