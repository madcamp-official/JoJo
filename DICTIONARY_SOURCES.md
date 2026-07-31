# 사전 소스별 응답 형식 정리

en/ja/zh 8개 사전 소스(MW·OEWN·Wiktionary·daijisen·JMdict·汉典·萌典·CC-CEDICT)가 실제로 어떤 형식으로 응답을 주는지, 그리고 그 원본 필드가 통일 스키마(`src/shared/types.ts`의 `DictionaryEntry`/`DictionaryReading`/`DictionarySense`)의 어느 필드로 매핑되는지 정리한다. 소스 채택 근거·폴백 순서는 [PLAN.md §6](PLAN.md#6-사전-api-구성) 참고. 어댑터 구현·폴백 오케스트레이션은 [TODO.md](TODO.md)의 "사전" 항목에 기록된 대로 모두 완료됐다.

**실측 이력**: 최초 작성 시점엔 `TODO.md`/`types.ts`에 이미 있던 과거 실측 기록을 소스 기준으로 재배열만 했었다. **2026-07-28에 이 문서 작성자가 직접 재실측**(공개 API 호출 — jisho.org/en.wiktionary.org REST API/dictionaryapi.dev/moedict.tw API, `resources/cedict.u8` 원본 파일 직접 grep, 웹 검색으로 정확한 페이지 URL 확보 후 재스크래핑)해 아래 내용을 갱신했다. 이 재실측으로 **바로잡은 오류**와 **접근 불가로 확인 못 한 부분**은 각 섹션에 `[2026-07-28 재실측]` 표시와 함께 명시한다 — MW(API 키 없음)와 OEWN(JSON 릴리스가 zip 압축이라 이 세션에서 다운로드 못 함)의 세부 필드 구조는 이번에 재검증하지 못해 기존 기록을 그대로 이어받았다.

## 목차

- [영어(en)](#영어en)
  - [Merriam-Webster (MW)](#merriam-webster-mw)
  - [OEWN (Open English WordNet)](#oewn-open-english-wordnet)
- [일본어(ja)](#일본어ja)
  - [daijisen](#daijisen)
  - [JMdict](#jmdict)
- [중국어(zh)](#중국어zh)
  - [CC-CEDICT](#cc-cedict)
  - [汉典 (zh-Hans)](#汉典-zh-hans)
  - [萌典 (zh-Hant)](#萌典-zh-hant)
- [Wiktionary (공용 — en/ja/zh 최종 폴백)](#wiktionary-공용--enjazh-최종-폴백)
- [공통 스키마 결정 사항](#공통-스키마-결정-사항)

---

## 영어(en)

### Merriam-Webster (MW)

**접근**: Collegiate Dictionary API(키 등록, 무료 개인용 티어). REST GET, JSON 응답. **[API 키가 없어 2026-07-28에 실제 호출로 재검증하지 못함]** — 대신 공식 문서 페이지(dictionaryapi.com/products/json)에 실린 예시 스키마로 필드명만 교차 확인.

**원본 구조 특징**:
- 표제어 하나에 여러 entry(품사별)가 올 수 있고, entry 안에 `sseq`(sense sequence, 중첩 배열) → `dt`(defining text) → `text`/`vis`(예문) 구조로 깊게 중첩됨. 공식 스키마 문서에서 이 중첩 구조와 필드명(`meta`/`hom`/`hwi`/`fl`/`lbs`/`sls`/`ins`/`cxs`/`def`/`uros`/`dros`/`et`/`usages`/`syns`/`shortdef` 등)을 재확인함(2026-07-28).
- `prs.mw` 필드가 발음이지만 **IPA가 아니다** — 매크론(ā/ē/ī/ō/ū 등)을 쓰는 MW 자체 표기법. IPA 필드 자체가 응답에 없고, variety(지역) 구분도 없음(단일 값).
- **`r`/`ɹ` 표기 차이(2026-07-29, 사용자 확인)**: `merriamWebsterToIpa.ts`가 MW 표기를 IPA 근사치로 바꿀 때 `r`을 그대로 통과시켜(SINGLE 매핑에 없음), 화면엔 항상 평문 `r`로 나온다. 반면 OEWN(아래 절)은 언어학 자료(WordNet 계열) 원본 IPA를 그대로 가져오므로 영어 r 소리를 엄밀한 IPA 기호인 `ɹ`(U+0279, LATIN SMALL LETTER TURNED R, 치경 접근음)로 표기한다 — 엄밀한 IPA에서 평문 `r`은 전동음(스페인어 rr류)을 가리키는 별개 음이라 구분해서 쓰는 것. 둘 다 각자 소스의 정상적인 표기 관행(MW·Cambridge·Oxford 같은 대중용 사전은 관행적으로 `/r/`, WordNet·CMU dict 같은 언어학 자료는 `/ɹ/`)이라 **오류가 아니며, 통일하지 않기로 결정**(2026-07-29 사용자 결정) — 필요해지면 그때 재검토.
- `fl`(functional label)이 품사; `"phrase"`면 관용구 표제어(예: "kick the bucket").
- `sls`(status label sequence) — 격식/사용역 라벨(예: "ain't" → `["informal"]`).
- `def[].vd`("verb divider") — 타동사/자동사 구분(실측, 2026-07-28: "arrive" → def 1개, `vd: "intransitive verb"`; "devour" → def 1개, `vd: "transitive verb"`; "run" → **def 2개**로 갈려 하나는 `vd: "intransitive verb"`, 하나는 `vd: "transitive verb"`). `entry.fl`이 아니라 `def` 레벨(=`sseq`와 같은 층)에 있고, 그 def 블록 전체(여러 sense 묶음)에 적용되는 라벨이라 어댑터가 그 안의 모든 sense에 전파해야 함 — `lbs`(entry 최상위 → 모든 sense에 복제)와 같은 패턴.
- ~~화용론적 사용법 설명 필드명이 `uns`인지 `usages`인지 API 키 없이는 확정 불가~~ → **확정(2026-07-28, `.env`의 실제 API 키로 "ain't hay" 직접 호출)**: sense 레벨 필드명은 **`uns`가 맞다** — `dt` 배열(태그된 튜플 시퀀스, `["text", ...]`/`["vis", [...]]`와 같은 자리) 안에 `["uns", [[["text", "used to say that an amount (of money) is a lot "], ["vis", [...]]]]]` 형태로 옴. `usages`(entry 최상위 usage discussion)는 별개의 상위 레벨 필드로 공존 가능 — sense 단위 자유 서술은 `uns`, 어댑터는 이걸 `usageNote`로 매핑. **정정(2026-07-28, "the"/"a"/"close" 재실측)**: "ain't hay" 예시는 사실 `dt`가 `uns` 블록 하나로만 채워진 경우(같은 dt 안에 진짜 `text` 튜플이 따로 없음)였다 — 이땐 `uns` 안 내용이 "보충 설명"이 아니라 그 sense의 **유일한 뜻풀이**다(같은 패턴이 "the"/"a" 같은 관사 정의에서도 재확인됨: 정관사·부정관사 정의 자체가 `uns`로만 옴). 무조건 `usageNote`로만 흡수하면 이런 sense가 `gloss` 없이 통째로 버려지는 실제 버그로 이어졌었다 — 어댑터는 `dt`에 진짜 `text` 튜플이 있을 때만 `uns`를 `usageNote`로 보충 흡수하고, 없으면 `uns` 내용을 `gloss`/`examples`로 승격해야 한다. **진짜 "보충 설명" 용례**는 `close`(동사)에서 재확인: 뜻풀이 `text`="to suspend or stop the operations of" 옆에 `uns`="often used with down"이 별도로 붙음.
- `ins`(inflections) — 불규칙 활용형(예: run → "ran"). 반쯤 자유 텍스트.
- `uros`(Undefined Run-Ons, 파생어 목록) — 조회한 표면형이 파생 접사가 붙은 형태(예: "photosynthesizing")면 **최상위 응답이 항상 원 표제어(예: "photosynthesis")로 돌아온다**(실측 확인). 질의어를 원형으로 미리 바꿔("photosynthesize") 검색해도 동일하게 원 표제어로 돌아옴 — 질의 단계 원형화로는 안 풀림. `uros[]`의 `ure`(파생어 표기, 중점 제거 후 비교)가 조회 표면형과 일치하는 항목을 찾아 그 `fl`/발음으로 보정해야 하고, 뜻풀이는 `uros`에 없으므로 원 표제어의 `def`를 그대로 쓴다.
- `cxs`(cross-reference) — 변형 철자를 가리키는 포인터 전용 엔트리. 실측: "colour" 조회 시 `def`/`shortdef`가 전부 비어있고 `cxs: [{ "cxl": "chiefly British spelling of", "cxtis": [{ "cxt": "color" }] }]`만 옴. `DictionarySense.gloss`가 필수 필드라 안 거르면 어댑터가 막힌다 — 처리안은 (1) `cxl`+`cxt` 합성해 gloss로 대체(추가 호출 없음) 또는 (2) `cxt`로 재조회해 실제 정의 병합(호출 1회 추가, 더 정확) 둘 중 택1, 스키마 필드 추가는 불필요.
- ~~전문분야 라벨 — `lbs`가 `sls`와 별도로 전문분야(컴퓨터/의학 등)를 담는 자리인지 확정 불가~~ → **정정(2026-07-28, `.env` API 키로 "deco" 직접 호출)**: `lbs`는 전문분야 라벨이 **아니다** — 공식 문서·실측 둘 다 "General Labels"로, 실제 값은 `["often attributive"]`(예: "deco")처럼 **표기 관례**(자주 대문자화됨/자주 관형적으로 쓰임 등) 라벨이다. entry 최상위(`fl` 옆)에 `lbs: string[]`로 오는 것도 실측 확인. 전문분야(컴퓨터/의학 등) 구분용 필드는 MW 스키마에 별도로 없음 — `lbs`는 성격상 `sls`(사용역)에 가까워 `usageTags`로 흡수하는 게 맞고, `domain`은 MW 소스에서 항상 undefined로 취급.

**스키마 매핑**:

| MW 원본 필드 | 통일 스키마 필드 |
|---|---|
| `sseq[].dt[].text` | `DictionarySense.gloss[]` |
| `sseq[].dt[].vis` | `DictionarySense.examples[]` |
| `fl` (`"phrase"`) | `DictionaryEntry.isIdiom` |
| `prs.mw` | `DictionaryReading.pronunciations[].value` (variety 없음) |
| `sls` | `DictionarySense.usageTags[]` (`kind: 'register'`) |
| `uns` | `text` 튜플이 dt에 따로 있으면 `DictionarySense.usageNote`, `uns`가 dt의 유일한 내용이면 `DictionarySense.gloss[]`/`examples[]`로 승격 (위 참고) |
| `def[].vd` | `DictionarySense.transitive` |
| `fl`(`"definite article"`/`"indefinite article"`, 실측: "the"/"a"/"an") | `DictionarySense.definite` — **en 3개 소스 비교(2026-07-28)**: MW만 이렇게 구조화된 필드로 구분 가능. OEWN은 관사 표제어 자체가 없음(GitHub Releases `entries.json` 확인: "the" 키 없음, "a"는 명사(알파벳) 뜻만 있음). Wiktionary REST API는 `partOfSpeech`가 그냥 "Article"이고 정관사/부정관사 구분이 definition 산문 텍스트에만 자연어로 섞여 있어(예: "the"의 정의 텍스트 안 "The definite grammatical article...") 구조화된 필드가 아님 — 두 소스 다 `definite`를 채우지 않고 undefined 로 두어 UI가 "관사"로만 표시하게 함. |
| `lbs`(entry 최상위, 실측: "deco" → `["often attributive"]`) | `DictionarySense.usageTags[]` (`kind: 'convention'`) — **레벨이 다름**(entry 전체 vs sense 단위)이라, 어댑터가 entry의 senses 전부에 복제해 `sls`(`kind: 'register'`)와 합쳐 넣는다(값 자체가 드물고 가벼운 표기 관례라 이 정도 단순화로 결정, 2026-07-28). 전문분야(컴퓨터/의학 등) 라벨이 아니므로 `domain`엔 매핑 안 함. |
| `ins` | `DictionarySense.irregularForms` |
| `cxs`/`uros` | (파싱 로직에서만 처리, 전용 스키마 필드 없음) |

### OEWN (Open English WordNet)

**접근**: 공식 GitHub 저장소(`globalwordnet/english-wordnet`)의 JSON 릴리스를 받아 로컬 번들. **`en-word.net/static/...` 정적 다운로드 링크는 2026-07-28 재실측 결과 503 Service Unavailable로 죽어있었으나, 같은 파일의 GitHub Releases 직접 다운로드 URL(`https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip`)은 같은 날 실측으로 HTTP 200/9.98MB 정상 다운로드 확인됨** — 그래서 다운로드 경로를 en-word.net 정적 링크가 아니라 GitHub Releases 에셋 URL로 확정한다. 별도 미러 저장소(`x-englishwordnet/json`)는 불필요 — 공식 GitHub Releases만으로 충분히 안정적이라 폴백 없이 이거 하나로 확정(이전에 검토했던 미러 폴백 방침은 폐기). 라이브 API(`en-word.net/api/...`)는 **2026-07-28에 재호출해도 여전히 503 Service Unavailable로 불안정함을 재확인** — API 대신 데이터 파일 번들 방침 유지(정적 파일 링크 자체도 en-word.net 도메인은 불안정하니, 다운로드는 항상 GitHub Releases 쪽에서). 원본 Princeton WordNet(2011년 이후 갱신 없음, 발음 정보 없음) 대신 이 커뮤니티 후속판(CC-BY 4.0) 채택.

**원본 구조 특징**(`run`/`kick the bucket`으로 실측 — **2026-07-28, GitHub Releases 에셋을 실제로 받아 압축 해제 후 파일 직접 열람으로 재검증 완료**, 이전 세션엔 못 열어봐서 기존 기록만 승계했던 상태였음):
- `pronunciation[]`에 지역별 발음이 여러 개(각각 `variety` 태그) 붙을 수 있음(실측 확인: `Bach` 항목이 `variety: "US"`/`"GB"` 2개, `Balinese`는 `"GB"` 등 — 태그 값은 "미국"/"영국" 같은 한글 라벨이 아니라 `US`/`GB`/`NZ` 같은 짧은 코드 원문 그대로) — 실제 IPA(예: run(v) → "ɹʌn", 엄밀한 IPA 기호 `ɹ` 사용 — MW와의 표기 차이는 위 "Merriam-Webster (MW)" 절 `r`/`ɹ` 항목 참고).
- synset이 패러프레이즈 대안 정의를 여러 개 가질 수 있음(실측: `81484980-r` synset이 정의 3개: "quickly and without warning" / "happening unexpectedly" / "on impulse; without premeditation").
- ~~`tagcount`(SemCor 코퍼스 실사용 빈도수, sense마다 다름 — 실측: run(v) "달리다" 뜻 tagcount=106)~~ → **정정(2026-07-28, GitHub Releases `english-wordnet-2025-json.zip`을 실제로 받아 압축 해제 후 전수 검사)**: 이 필드는 이 JSON 릴리스에 **존재하지 않는다** — `grep -r "tagcount"` 결과 0건, sense 객체가 실제로 갖는 키 전체(26종: `id`/`synset`/`derivation`/`sent`/`agent`/`also`/`antonym`/`similar`/`pertainym`/`subcat` 등 프레임 의미 정보 위주)를 전수 확인해도 빈도 관련 필드가 없다. 예전 Princeton WordNet WNDB 배포판의 `index.sense`(`tag_cnt`)에 있던 개념으로 추정되나, 이 GitHub JSON 릴리스로는 가져올 수 없다 — **`DictionarySense.tagCount` 필드는 이 데이터 소스로 채울 수 없으므로 폐기하거나 다른 소스(WNDB 원본 파일을 별도로 받는 등)를 찾아야 한다.**
- entry의 `form` 필드가 불규칙 활용형을 배열로 제공(예: run(v) → `["ran", "running"]`) — MW의 반쯤 자유 텍스트 `ins`보다 구조가 깔끔함. ~~원시 synset 데이터 자체엔 활용형이 없지만 WNDB 배포판 포맷에 포함된 Morphy(형태소 처리기)가 처리 — 사용할 라이브러리가 Morphy를 감싸고 있는지 확인 필요~~ → **정정(2026-07-28, 어댑터 구현 중 실측)**: Morphy 자체를 감싸는 라이브러리가 **불필요했다** — `entries-*.json`의 각 표제어 레코드에 이미 `form[]`이 채워져 있어(GitHub Releases JSON 릴리스 기준, WNDB 배포판과 달리 활용형 계산이 끝난 결과물이 그대로 들어있음) 그 필드를 표제어별로 모아 "활용형→원형" 역인덱스만 만들면 됐다(`question/dictionary/oewn.ts` `formIndex`). 형태소 분석기 연동 자체가 스코프에서 사라짐.

**스키마 매핑**:

| OEWN 원본 필드 | 통일 스키마 필드 |
|---|---|
| synset 정의 (복수 가능) | `DictionarySense.gloss[]` |
| `pronunciation[].value` | `DictionaryReading.pronunciations[].value` (실제 IPA) |
| `pronunciation[].variety` | `DictionaryReading.pronunciations[].variety` |
| ~~`tagcount`~~ | ~~`DictionarySense.tagCount`~~ — **이 JSON 릴리스엔 필드 자체가 없어 채울 수 없음(2026-07-28 확인), 폐기 검토 대상** |
| `form` | `DictionarySense.irregularForms` |

**활용형 처리 버그 발견 및 수정(2026-07-29)**:
- `resolveLemmas`(표면형 → entries 키 해석)가 표면형 자체가 직접 표제어를 가지면
  (예: "closed"의 형용사 표제어 "not open or affording passage") 바로 반환해버려서,
  활용형 역인덱스(`formIndex`)를 아예 확인하지 않는 버그가 있었다 — "running"/
  "closed"/"better" 조회 시 동사/원형 해석(run/close/good·well)이 후보에서 통째로
  빠지고 무관한 형용사 뜻만 나왔다. 직접 표제어와 활용형 후보를 항상 합쳐서 반환
  하도록 수정 — "running"→running+run 2개, "better"→better+good+well 3개로 개선.
- **남은 데이터 한계**: OEWN의 `form[]` 필드가 불규칙 활용 위주로만 채워져 있고
  규칙동사 활용(-ed/-s 등)은 거의 비어 있다(실측: `close`/`want`/`walk`/`look`
  entries 전부 `form: null`) — "walked"/"looked" 같은 흔한 규칙동사 과거형은
  OEWN 데이터 자체에 매핑이 없어 이 필드만으론 못 찾는다.
- **`dictionary.ts`에 en 전용 활용형 추측 로직 추가**(`guessEnglishBaseForms`) —
  WordNet Morphy 알고리즘의 detachment rule 일부를 재구현(별도 라이브러리 없이
  접미사 규칙만): -ed/-ing/-s/-es/-ies 활용형에서 원형 후보를 여러 개 만든다(자음
  축약·e 복원 포함, 예: "walked"→walk, "closed"→close, "running"→run,
  "studied"→study). 표면형+추측 후보를 daijisen/JMdict와 동일한 "소스 하나당 전부
  시도" 구조(`lookupThroughFallbackChain`)로 시도해, MW 키가 없어 OEWN이 이어받는
  상황에서도 Wiktionary의 얇은 굴절 안내 한 줄(예: "walked"→"simple past and past
  participle of walk")로 새지 않고 OEWN 자체에서 "walk"를 찾아낸다.
- **후보 전부를 시도하고 합친다(첫 성공에서 멈추지 않음)** — 처음엔 후보 중 하나만
  성공해도 바로 반환했는데, "closed"를 표면형 그대로 물으면 그 자체로 형용사
  표제어가 있어 "성공"으로 끝나버려서 뒤이어 시도할 "close"(동사) 후보를 아예
  안 물어보는 문제가 있었다 — 문맥이 동사 용법("She closed the door")이어도
  LLM 후보 목록에 동사 뜻 자체가 없어 고를 수 없었음. 소스 하나 안에서는 후보
  전부를 시도해 나온 entries를 전부 합쳐 LLM 후보 목록에 넣도록 변경(표면형과
  추측 후보가 서로 다른 뜻일 수 있는 동형이의어 문제) — 재검증 결과 "closed"
  조회 시 이제 closed(형용사)+close(동사) 둘 다 후보로 나옴.

---

## 일본어(ja)

### daijisen

**소스 식별자 결정(2026-07-28, 리네임)**: 이 ja 소스의 `DictionarySourceId`/파일명/식별자는 원전(原典) 기준 `daijisen`(デジタル大辞泉)으로 확정한다 — 아래 "원본 구조 특징"에서 보듯 하나의 표제어 페이지에 여러 사전이 `<article>`로 동시에 붙는데, kotobank.jp는 그 여러 사전을 서비스하는 **경유 플랫폼**일 뿐이고 실제 뜻풀이 원전은 デジタル大辞泉이다 — 그래서 "kotobank.jp"가 아니라 원전 이름을 소스 식별자·표시 라벨(`デジタル大辞泉`, 로마자 아님)로 쓴다. **精選版日本国語大辞典(nikkokuseisen)은 구조를 실측만 했을 뿐 실제로 채택하지 않았다** — 아래 실측 기록은 참고용으로 남겨두되, 이 앱의 어댑터는 daijisen slug 하나만 쓴다.

**접근**: 스크래핑(공식 API 없음), `kotobank.jp` 경유. `kotobank.jp/word/{표제어}-{ID}` 형식이라 ID를 짐작해서 URL을 만들면 엉뚱한 페이지가 뜬다(`花-460388`처럼 잘못 짐작한 ID는 "学振" 같은 전혀 다른 표제어로 연결됨) — 다만 **어댑터 구현 시 재확인(2026-07-28): ID 없이 `kotobank.jp/word/{표제어}`로 직접 접근해도 검색 없이 정확한 ID 페이지(`花-115580` 등)로 자동 리다이렉트됨**을 花/食べる/犬/美しい 4개 표제어로 확인해, 별도 검색 API 호출 없이 이 방식으로 구현했다. 존재하지 않는 표제어는 HTTP 404.

**구현 완료(2026-07-28, `feat/daijisen-adapter`)**: `question/dictionary/daijisen.ts`. 위 리다이렉트 방식으로 조회 후 daijisen article만 정규식으로 잘라낸다. 그 안에서 동형이의 하위 항목(`<div class="ex cf">`, 花 페이지의 한자항목「か【花】［漢字項目］」・곡명「はな【花】［曲名］」 등)이 여러 개면 **전부** 별도 `DictionaryReading`으로 만들어 후보에 넣는다(처음엔 첫 번째만 채택했으나, 이 앱이 애초에 "사전이 후보를 주면 LLM이 문맥상 맞는 걸 고른다"는 구조라는 걸 감안해 MW의 동형이의어(hom) 처리와 같은 패턴으로 수정 — 필터링은 LLM에 맡기고 어댑터는 후보만 넉넉히 제공). headword는 모든 항목의 한자 표기 합집합, 각 항목의 읽기(`<h3>` 대괄호 앞부분)는 그 reading의 `pronunciations`로 채운다. 번호매김(`<b>N</b>`→`㋐㋑㋒`, U+32D0~U+32FE)은 `parentIndex`로 표현하되, 뜻풀이 없이 하위만 묶는 "그룹 헤더"(실측: 食べる sense 3 — `<b>３</b><br>㋐…㋑…`, ３ 자체는 텍스트 없음)는 MW sdsense 처리(`merriamWebster.ts`)와 동일 방침으로 빈 부모를 만들지 않고 그 하위를 곧바로 parentIndex 없는 독립 sense로 승격한다.

**구현 중 새로 발견한 함정**:
0. **article 경계 탐지 버그**(가장 심각) — 다음 article 시작을 `indexOf('<article class="dictype')` 같은 고정 문자열로 찾으면 절대 안 된다. 실제 마크업은 `<article itemscope itemtype="..." id="..." class="dictype cf ...">`처럼 `<article`과 `class=` 사이에 다른 속성이 끼어 있어(모든 article이 동일 순서라 항상 실패), 경계를 못 찾고 daijisen 이후 페이지 전체(다른 사전 7개+광고+관련어 위젯)를 통째로 삼켜버린다(실측: "花" — article 길이가 정상 19458자 대신 228181자, ex-cf 블록이 3개가 아니라 21개로 잡힘). 정규식(`<article[^>]*class="dictype`)으로 속성을 건너뛰어야 한다.
1. **품사 그룹마다 번호가 1부터 재사용됨** — 犬 실측: 표제어 하나에 ［名］(명사)/［接頭］(접두어) 두 그룹이 있고, 각 그룹이 독립적으로 `<b>１</b>`부터 다시 매긴다. `[類語]`는 항상 **첫 번째(주 품사) 그룹**의 번호를 가리키므로, "번호→sense" 매핑을 마지막 값으로 덮어쓰면(overwrite) 뒤 그룹의 번호가 앞 그룹 매핑을 지워버려 유의어가 엉뚱한 sense(예: "스파이" 뜻에 "개 품종" 유의어)에 붙는 버그가 실제로 났다 — **first-write-wins**(먼저 채운 번호는 덮어쓰지 않음)으로 해결.
2. **`[類語]（N）...／（M）...` 체이닝** — 食べる 실측: 한 `[類語]` 블록 안에 "（1）…／（2）…"처럼 "／"로 여러 sense 번호 그룹이 이어질 수 있음(뒤 그룹엔 `[類語]` 라벨이 안 붙고 바로 번호만 나옴). 블록 전체를 먼저 잘라낸 뒤 안에서 번호 경계로 다시 나누는 2단계 파싱으로 처리.
3. **`[類語]` 라벨 자체가 평문/링크 혼재** — 花는 평문 `[類語]`, 食べる는 `[<a>類語</a>]`(링크로 감싸짐). 정규식이 둘 다 받아들이게 처리.
4. **「…」의 이중 용도** — 実측용례(headword 자리를 "―"로 표기, 예: 「生で―・べる」)와 정의문 안에서 다른 단어를 인용하는 상호참조(예: 「食う」「飲む」の謙譲語 — 예문이 아니라 "食う/飲む의 겸양어"라는 뜻풀이 그 자체)가 섞여 있음. "―" 포함 여부로 구분(포함 시 examples로, 아니면 괄호만 벗기고 gloss 본문에 남김).
5. **`[補説]`(용법 보충 설명)** — `usageNote` 필드로 분리(食べる/美しい 실측 확인).
6. **가타카나 외래어는 【】 브래킷 자체가 없음** — 実측: "コンピューター（computer）"처럼 원어 병기가 【】가 아니라 전각 괄호 （）로 붙는다. 【】 필수로 파싱하던 초기 코드는 이 표기를 못 뽑아 daijisen article이 실제로 있는데도 entry 전체가 통째로 드롭됐다 — 브래킷이 없으면 h3 텍스트 자체(끝의 원어 병기 괄호는 제거)를 headword로 쓰도록 수정.
7. **조회어와 무관한 페이지로 리다이렉트될 수 있음** — 実측: 한자 없이 순수 히라가나로 상용 동사를 조회하면(예: "なる") kotobank.jp가 전혀 다른 가타카나 표제어("ナル", 발음만 같은 별개 단어로 추정)로 리다이렉트한다(한자로 "成る"를 조회하면 정상 동작). 걸러내지 않으면 완전히 무관한 뜻을 조회어의 뜻인 것처럼 조용히 반환하게 되므로(빈 값 반환보다 훨씬 나쁨), 조회어가 headword 중 하나에 포함되거나 reading과 일치할 때만 채택하는 관련성 확인을 추가(MW `isRelevantEntry`와 동일 목적). **정확히 일치가 아니라 포함 관계로 비교**해야 함 — 実측(水): "もい〔もひ〕【▽水】"처럼 희귀/방언 읽기를 나타내는 "▽" 마커가 브래킷 안에 붙는 진짜 이표기가 있어서, 정확 일치로 비교하면 이런 것까지 걸러진다(포함 관계로 완화해 해결). する/ある 같은 순수 히라가나 상용 동사·조동사는 kotobank.jp 자체가 HTTP 404를 주거나(する) daijisen article이 아예 없는 페이지로 리다이렉트되어(ある→アル) 정상적으로 빈 값을 반환하고 다음 폴백(JMdict)으로 넘어간다 — 이건 daijisen/kotobank.jp의 근본적인 커버리지 한계로, 어댑터가 고칠 수 있는 부분이 아니다.

8. **오쿠리가나 괄호 생략형 표제어는 표준 표기 URL이 404** `[2026-07-29 실측, "落とす"]` — 大辞泉 표기가 「おと・す【落（と）す】」처럼 생략 가능한 오쿠리가나를 전각 괄호로 감싼 표제어는 kotobank URL 슬러그도 생략형(`/word/落す-453451`)이라, 표준 표기("落とす")로 `/word/` 직접 접근하면 리다이렉트 없이 HTTP 404가 난다(기존 실측 표본 花/食べる/犬/美しい에는 이 케이스가 없어 그동안 안 걸렸음). 두 갈래로 대응: (1) 404일 때만 `kotobank.jp/search?q={조회어}` 검색 결과에서 조회어의 오쿠리가나 생략 변형(같은 첫 글자 + 히라가나만 빠진 부분수열, `isOkuriganaOmittedVariant`)에 해당하는 `/word/` 링크를 찾아 최대 3개 재시도(`searchFallback` — 404가 아닌 무관 리다이렉트까지 검색으로 넓히면 なる→ナル류 오탐이 다시 생길 수 있어 넓히지 않음. 검색 결과 링크엔 `#w-{ID}` 프래그먼트가 붙어 있어 정규식에서 떼어내야 함), (2) 표제어 파싱에서 괄호만 벗긴 표준 표기("落とす")를 headword(화면 표시)로, 괄호째 지운 생략형("落す")까지 포함한 `matchForms`를 관련성 확인용으로 분리 — 예전엔 "落（と）す"가 그대로 headword로 들어가 위 7번 관련성 확인에서 정상 항목까지 걸러졌다.
9. **예문의 "―"(표제어 대용 기호)를 실제 표제어로 복원** `[2026-07-29 사용자 피드백, "君"]` — 예문 원문은 표제어 자리를 "―"(U+2015)로 표기해(명사: 「わが―」=わが君, 활용어: 「生で―・べる」=生で食べる) 그대로 내보내면 예문에 표제어가 아예 안 보인다. 활용어는 "―"가 표제어 전체가 아니라 **어간**(오쿠리가나 앞부분)을 대신하므로, `<h3>` 읽기의 "・" 어간 경계에서 오쿠리가나("べる")를 얻어 headword 끝에서 뗀 어간("食")으로 "―・" 통째를 치환한다(`restoreHeadwordPlaceholders`, [補説] usageNote에도 적용).

품사(pos)는 기존 방침대로 daijisen 마커가 불안정해 채우지 않음(JMdict 1순위 유지). `FALLBACK_CHAINS`(`dictionary.ts`) ja 배열 맨 앞에 등록 완료.

**원본 구조 특징** `[2026-07-28, 花 페이지 재실측]`:
- 한 표제어 페이지에 여러 사전 소스가 `<article>`로 나란히 붙는 구조는 재확인됨. "花" 페이지에서 실제로 확인된 소스는 **daijisen(デジタル大辞泉, 채택)/nikkokuseisen(精選版日本国語大辞典, 실측만·미채택)/sekaidaihyakka(改訂新版世界大百科事典)/nipponica(日本大百科全書)/jitsu(普及版字通)/britannica(ブリタニカ国際大百科事典)/mypedia(百科事典マイペディア)/daijisenplus(デジタル大辞泉プラス)/animalsandplants(動植物名よみかた辞典)** 9개 — "138개 사전 통합"은 kotobank.jp 전체가 보유한 사전 총수이고, 표제어 하나에 실제로 붙는 소스 수는 이보다 훨씬 적다(9개, 표제어 성격에 따라 가변적일 것으로 추정).
- 국어사전/백과사전/한자어원사전/고유명사·전문용어사전 등 여러 종류가 섞여 있어, 품사 태그 유무만으로는 국어사전식만 못 거른다 — **daijisen만 쓰려면 slug 화이트리스트**(`daijisen`)로 거르는 게 텍스트 파싱보다 안정적이라는 기존 판단 유지(nikkokuseisen은 미채택이라 화이트리스트에서 제외).
- **デジタル大辞泉**: 뜻풀이 번호매김(`<b>１</b>` 등)·유의어(類語) 섹션·같은 article 안 한자 표제어(`か【花】`, 漢字項目) 3가지는 재확인됨.
- **精選版日本国語大辞典**(참고, 미채택): `[ 一 ]`→`①②③`→`(イ)(ロ)` 다단 번호매김은 재확인됨. **단, "精選版엔 類語 섹션이 없다"는 기존 기록은 이번 재실측으로 틀린 것으로 확인됨** `[정정, 2026-07-28]` — 花 페이지에서는 daijisen뿐 아니라 nikkokuseisen에도 類語 섹션이 나타났다. 표제어에 따라 있고 없고가 갈릴 가능성이 있어(花는 있음, 원래 기록의 근거였던 단어는 달랐을 수 있음) 완전히 없다고 단정하지 말고 **"사전마다가 아니라 표제어마다 있을 수도 없을 수도 있다"로 정정**.
- 품사 마커(`<span class="hinshi">`)의 불일치 사례(동사/형용사 태그 결합 방식 차이, 명사 무표시, とても가 `連語`로 나오는 것)는 기존 기록 유지(이번 재실측 대상은 아님) — 여전히 **품사 판정은 JMdict 1순위** 방침 유지.
- 활용형 자동 원형 변환이 안 되는 점(형태소 분석 전처리 필요)은 기존 기록 유지.
- `慣用句`(4자성어 이외의 일반 관용구) 태그 유무 확인 — 실제 관용구 페이지("猫の手も借りたい")를 스크래핑해보니 그런 카테고리 라벨 자체가 페이지에 없음(4자성어 전용 `四字熟語` 라벨과 달리, 일반 관용구는 평문 정의만 있고 별도 태그가 없음). `isIdiom` 판정은 이 소스에 기대지 않고 JMdict(`exp`/"Yojijukugo")·MW(`fl:"phrase"`) 위주로 확정.

**스키마 매핑**: (daijisen 기준, 실제 채택) 番号 뜻풀이 → `gloss[]`, 類語 → `synonyms`. **(精選版 기준, 참고·미채택)** `〘 品詞 〙` → `posRaw`/`pos`, `[初出の実例]` → `examples[]`, (있는 경우) 類語 → `synonyms`.

### JMdict

**접근**: 로컬 데이터셋 번들(jmdict-simplified 등) 예정, 라이브 조회는 jisho.org API로 대체 검증. **2026-07-28, 아래 항목 전부 jisho.org API를 실제로 호출해 재확인함** — 기존 기록과 전부 일치, 정정 사항 없음.

**구현 완료(2026-07-28)**: TODO.md 결정대로 jisho.org API가 아니라 jmdict-simplified `eng`(full) 변형 로컬 JSON 번들로 구현됨 — `scripts/build-jmdict-bundle.py`(GitHub Releases 원본 117MB → `resources/jmdict/{words,index,tags}.json` 3파일, 약 62MB로 트리밍) + `question/dictionary/jmdict.ts`(조회 어댑터, 네트워크 호출 없음). 실측(一人/高い/らしい/薔薇/レジスター/しどい)으로 아래 스키마 매핑 전부 검증 완료. 원본 misc 코드 기준 register/convention 분류는 다음 두 집합으로 확정: **register** = `sl`/`m-sl`/`net-sl`/`derog`/`col`/`hon`/`hum`/`pol`/`arch`/`obs`/`dated`/`rare`/`joc`/`vulg`/`sens`/`fam`/`poet`/`form`/`euph`/`male`/`fem`/`chn`/`hist`, **convention** = `uk`/`abbr`, 나머지(`yoji`/`proverb`/`id`/이름류 태그 등)는 `other`. `dialect` 필드는 misc와 별도라 `usageTags`에 `kind: 'dialect'`로 바로 매핑(원본 방언 코드는 `tags.json` 룩업으로 사람이 읽는 문자열로 변환). `conjugationClass`는 `v1`/`v5*`/`v2*-k`/`v2*-s`/`adj-i`/`adj-na` 등 활용 코드를 정규식+룩업 테이블로 디코딩(예: `v5k`→"五段(く)", `v2g-k`→"上二段(g행, 고어)"). `isIdiom`은 `partOfSpeech`에 `exp` 또는 `misc`에 `yoji`가 있으면 true. 가나만 있는 표제어(예: らしい)는 `headword`를 가나 배열로 대체, 같은 표기가 여러 word 엔트리로 갈리는 동형이의어는 `DictionaryEntry[]` 배열로 전부 반환.

**원본 구조 특징**(jisho.org API 실측 기준, 원본은 jmdict-simplified 스키마):
- 활용형을 원형으로 자동 변환해주지 않음(daijisen과 동일) — 형태소 분석 전처리 필요.
- 품사 판정이 daijisen보다 훨씬 안정적 — `parts_of_speech` 배열에 일관되게 나옴(명사도 명시적으로 "Noun") → **품사 판정 1순위 소스로 확정**.
- **sense 배열을 인덱스로 매칭해 daijisen gloss + JMdict pos를 섞으면 안 됨** — 두 소스가 sense를 나누는 기준 자체가 다름.
- 한 sense 안에 품사가 2개 동시에 붙는 경우 있음(실측: 元気/自由 → `["Na-adjective (keiyodoshi)", "Noun"]` 동시 태깅) — `pos`는 단일값이라 더 대표적인 쪽 하나만, 원본 조합은 `posRaw`에 보존.
- `らしい` 재확인 결과: sense1 `parts_of_speech: ["I-adjective (keiyoushi)", "Auxiliary adjective"]`, `info: "after the plain form of a verb or adjective, or a noun; expresses judgement based on evidence, reason or trustworthy hearsay"` / sense2 `parts_of_speech: ["Suffix", "I-adjective (keiyoushi)"]`, `info: "after a noun, adverb or adj. stem"` — 조동사/접미사 성격이 `info`에 문장으로 풀어 설명돼 있음을 재확인, `conjugationClass`에 이런 취지를 요약해 넣는 기존 방침 유지.
- `is_common`이 entry(reading 그룹) 최상위에만 있고 sense들이 공유하는 구조는 기존 기록대로.
- `synonyms` 키 자체가 응답에 없음(재확인). 대신 `見よ:` 형태의 `see_also` — `synonyms`가 아니라 `seeAlso`로 분리.
- `antonyms` 필드는 있음(재확인: "高い"→"低い", sense1에만).
- **`tags` 필드가 misc(사용역)와 field(전문분야)를 한 배열에 뭉쳐 노출하는 것을 재확인**: レジスター의 3번째 sense(컴퓨팅 register 뜻)에서 `tags: ["Computing"]`(sense1/2는 tags 빈 배열, → `domain`). しどい는 `tags: ["Slang"]`(→ `usageTags`, `kind: 'register'`). 薔薇 sense1은 `tags: ["Usually written using kana alone"]`(→ `usageTags`, `kind: 'convention'`) — 격식이 아니라 표기 관례라 `usageTags`로 개명한 기존 판단이 정확했음을 재확인, 이번엔 `kind`로 한 걸음 더 분리(2026-07-28). JMdict `misc` 값 자체가 어떤 게 register/convention인지는 값마다 다르므로(예: `sl`=slang/`derog`=derogatory/`col`=colloquial/`hon`=honorific/`hum`=humble/`arch`=archaism 등은 register, `uk`=주로 가나로만 표기/`ateji`=아테지/`ik`=이형 가나 등은 convention) 어댑터가 원본 JMdict misc 코드 기준 룩업 테이블로 분류해야 함 — jisho.org의 영문 설명(`tags`)만 보고는 이 구분이 항상 명확하진 않아 로컬 jmdict-simplified 번들(원본 misc 코드 보존)에서 분류하는 게 더 안전.
- `info`(パン sense1 → `"originally written 麺麭 or 麪包"`)가 MW `uns`(sense 레벨 확정, "ain't hay" 실측 확인)와 같은 "gloss/examples 어디에도 안 들어가는 자유 서술" 역할이라는 것도 재확인 → `usageNote`.

**스키마 매핑**:

| JMdict/jisho.org 원본 필드 | 통일 스키마 필드 |
|---|---|
| `senses[].english_definitions` | `DictionarySense.gloss[]` |
| `parts_of_speech` | `DictionarySense.pos`/`posRaw` |
| `is_common` (entry 최상위) | `DictionaryReading.isCommon` |
| `see_also` | `DictionarySense.seeAlso[]` (`kind: 'related'`) |
| `antonyms` | `DictionarySense.antonyms` |
| `field`(로컬 데이터셋) | `DictionarySense.domain` |
| `misc`/`tags`(jisho.org) | `DictionarySense.usageTags[]` — 값별로 `kind` 분류 필요(아래 참고) |
| `info` | `DictionarySense.usageNote` |
| `v1`/`vt` 등 자동사/타동사 코드 | `DictionarySense.transitive` |
| (해당 없음, synonyms 키 없음) | `DictionarySense.synonyms` — 항상 undefined |

---

## 중국어(zh)

언어 판별 단계에서 zh-Hans/zh-Hant를 스크립트 기준으로 먼저 분리해 조회(변환 없이 네이티브 라우팅). zh-Hans는 汉典 → CC-CEDICT, zh-Hant는 萌典 → 汉典 → CC-CEDICT, 공통 최종 폴백은 Wiktionary.

### CC-CEDICT

**접근**: 로컬 데이터셋(`resources/cedict.u8` 원본 파일, 저장소에 실제로 존재). **2026-07-28, 파일을 직접 grep해 전체 재검증** — 이전 기록의 라벨 빈도 수치가 부정확했던 것을 여기서 바로잡는다.

**원본 구조 특징**:
- 포맷 자체가 `번체 간체 [pinyin] /뜻1/뜻2/.../` — 슬래시 구분 뜻 목록 안에 실제 정의뿐 아니라 사용역 라벨·전문분야 라벨·교차참조·발음 변이가 전부 비정형 평문으로 뒤섞여 있음. **어댑터가 슬래시 세그먼트마다 정규식으로 분류해 올바른 필드로 라우팅**해야 하는 파싱 문제.
- 사용역/전문분야 라벨 빈도 `[2026-07-28 재실측, 이전 수치 정정]`(전체 124,732개 항목 중, `grep -c` 기준). **정정(2026-07-28): 아래 두 그룹은 성격이 달라 스키마 필드도 나뉘어야 하는데, 기존 기록이 전부 `usageTags` 하나로 뭉뚱그려 놨었다** — `domain`(JMdict `field`용으로 이미 만들어 둔 전문분야 필드, `types.ts` 참고) 설계 의도상 전문분야 라벨은 여기로 가야 정합이 맞음:

  **사용역/표기 관례 라벨(→ `DictionarySense.usageTags`, `kind` 분류는 2026-07-28 결정)**:

  | 라벨 | 빈도(재실측) | 이전 기록 | `kind` |
  |---|---|---|---|
  | `(coll.)` | 911 | 950 | `register` |
  | `(slang)` | 536 | 545 | `register` |
  | `(derog.)` | 93 | 94 | `register` |
  | `(archaic)` | 182 | 188 | `register` |
  | `(literary)` | 1,152 | 1,331 | `register` |
  | `(dialect)` | 548 | 576 | `dialect` |
  | `(loanword)` | 842 | 849 | `other`(격식·방언 어느 쪽도 아닌 어원 설명) |
  | `(bound form)` | 536 | 772 | `other`(형태 결합 제약 표시, 격식·방언과 무관) |

  **전문분야 라벨(→ `DictionarySense.domain`, JMdict `field`와 동일 필드로 통합)**:

  | 라벨 | 빈도(재실측) | 이전 기록 |
  |---|---|---|
  | `(math.)` | 520 | 524 |
  | `(computing)` | 479 | 483 |
  | `(chemistry)` | 359 | 360 |
  | `(medicine)` | 251 | 251 |
  | `(TCM)` | 175 | 176 |
  | `(Buddhism)` | 155 | 156 |
  | `(law)` | 114 | 115 |
  | `(finance)` | 108 | 110 |

  `(bird species of China)`(1,443회, 재확인 일치)는 위 어느 쪽도 아님 — 아래 별도 항목 참고.

  **`(idiom)`(5,703회)은 정정(2026-07-28): 위 두 표 어디에도 넣지 않는다** — `usageTags`에
  문자열로 흡수하면 "관용구인지 아닌지"라는 entry 단위 구조적 신호가 그냥 태그 더미에 묻혀버린다.
  MW(`fl:"phrase"`), JMdict(`exp`/"Yojijukugo")와 동일한 축의 신호이므로 CC-CEDICT의 `(idiom)`도
  `DictionaryEntry.isIdiom = true`로 매핑해야 한다 — 기존엔 이 라벨을 다른 사용역 라벨과
  똑같이 취급해 `usageTags`로만 흘려보내고 있었다.

  `(bound form)`은 편차가 커서(536 vs 772) 이전 집계 방식이 달랐을 가능성이 있음 — 위 표의 재실측 수치가 `grep -c "(bound form)" resources/cedict.u8`로 직접 센 값. (괄호 텍스트를 그대로 넣을지, 소스 간 통일 어휘로 정규화할지는 두 그룹 모두 미정.)
- 교차참조 포인터(`variant of`, `old variant of`, `erhua variant of`, `abbr. for`, `see also`, `used in`, `also written`) → `DictionarySense.seeAlso[]`. 실측 재확인(`grep -n "^一族 "`): `一族 一族 [yi1 zu2] /social group/subculture/family/clan/see also 族[zu2]/` — **뜻 세그먼트가 4개(social group/subculture/family/clan) + see also 1개** `[정정 — 기존 기록은 "정의 3개+see also 1개"로 오기재돼 있었음]`. `一個勁兒` → `erhua variant of 一個勁|一个劲[yi1 ge4 jin4]`(재확인, 정확). MW의 `cxs`(포인터 전용 엔트리가 정의를 통째로 대체)와 달리 CC-CEDICT는 **같은 슬래시 리스트 안에 실제 정의와 포인터가 섞여** 있어 세그먼트별로 골라내 `gloss`가 아니라 `seeAlso`로 보내는 필터링이 필요. **`kind` 분류(2026-07-28 결정)**: `variant of`/`old variant of`/`also written` → `variant`(표기 변이, 시대 차이 포함), `erhua variant of` → `dialectVariant`(음운/儿化 변이), `abbr. for` → `abbreviation`, `used in` → `usedIn`, `see also` → `related`.
- `Taiwan pr. [...]`(재확인: `行`(xing2) → `.../behavior; conduct (Taiwan pr. [xing4])/...`, 그 외 `下頦`→`Taiwan pr. [xia4hai2]`, `中焙`→`Taiwan pr. [zhong1pei4]`, `中用`→`Taiwan pr. [zhong4 yong4]` 등 다수 확인) → `DictionaryPronunciation.variety: "Taiwan"`.
- 동자이음(異音字, 재확인: `都` → `Du1(surname Du)`/`dou1(all; both...)`/`du1(capital city)` 정확히 3줄, `行` → `hang2`/`heng2`/`xing2` 정확히 3줄) → `DictionaryReading[]` 배열 구조에 자연스럽게 대응.
- `CL:`(양사) 재확인 — 단일 분류사(`CL:件[jian4]`)와 복수 분류사(`CL:個|个[ge4],位[wei4]`, `CL:份[fen4],頓|顿[dun4]`, `CL:件[jian4],樁|桩[zhuang1],回[hui2]` 등) 둘 다 실제 존재 확인. **`DictionarySense.classifiers[]` 필드는 2026-07-28 폐기됨(아래 "스키마 매핑" 절 참고)** — `CL:` 세그먼트는 이제 파싱 시 그냥 버린다.
- 병음 첫 글자 대문자(재실측: 정확히 20,266/124,732줄 = 16.2%, 예: `丁`→"surname Ding", `三`→"surname San")로 고유명사(성씨/지명) 구분 신호가 있음 — **결정(2026-07-28): 전용 `isProperNoun` 필드는 추가하지 않는다.** `surname X`/`place name` gloss 텍스트만으로 충분한 수준으로 남겨두고 신호 존재만 기록.
- `(bird species of China)` 태그 1,443회(재확인, 일치) — 조류 라틴학명 엔트리가 대량 포함돼 일반 단어 조회 결과에 노이즈가 될 수 있음(어댑터 필터링 검토 대상).

**스키마 매핑**: 슬래시 세그먼트를 분류 후 `gloss[]`/`usageTags`/`domain`/`seeAlso`/`pronunciations[].variety`/`isIdiom`(`(idiom)` 라벨 전용)로 라우팅. `pos` 필드 자체가 없어 항상 undefined.

**2026-07-28 정정 — 세그먼트 하나 = sense 하나로 재설계.** 어댑터 초기 구현은 한 발음(pinyin) 줄의 슬래시 세그먼트 전부를 sense 하나의 `gloss[]` 배열로 합쳤었는데, 실측 결과 이러면 두 가지 문제가 있었다: (1) CC-CEDICT가 라벨을 세그먼트마다 반복해서 붙이는 포맷이라(예: "行"(hang2) → "(bound form) row; line/(bound form) line of business; .../...", 같은 "(bound form)"이 4개 세그먼트에 나란히 붙음) 세그먼트 순회 중 뽑은 라벨이 sense 하나의 `usageTags`에 그대로 중복 적재됐다. (2) "打"(dǎ, da3)의 실측 확인 사례처럼 라벨이 실제로는 마지막 세그먼트 하나("(coll.) from; since ...")에만 걸리는데도 합쳐진 sense 전체에 붙어, "이 라벨이 정확히 어느 뜻에 해당하는지"라는 정보가 사라졌다. → 세그먼트(CL:/교차참조 세그먼트 제외) 하나당 `DictionarySense` 하나를 만드는 쪽으로 변경(라벨은 그 세그먼트에서만 뽑음, 중복·오귀속 문제 둘 다 해소). **트레이드오프**: "確定"(que4ding4)처럼 13개 세그먼트가 사실상 2~3개 뜻의 근의어 나열인 경우, 쪼개면 LLM 판정 단계(`numberSenses`)에 근의어 13개가 별개 후보로 뜨는 과분할이 생긴다 — CC-CEDICT 원본에 세그먼트를 몇 개씩 묶어야 하는지 판단할 근거(정식 sense 번호 등)가 없어 감수하기로 결정(라벨-뜻풀이 매칭 정확도를 우선). `seeAlso`는 세그먼트 하나가 아니라 그 줄(발음) 전체에 걸리는 포인터라(예: "一族" → "see also 族[zu2]") 그 줄에서 split된 모든 sense에 동일하게 복제한다.

**`classifiers` 필드 폐기(2026-07-28).** CC-CEDICT의 `CL:`(양사) 세그먼트는 표제어 전체 중 주로 명사 뜻 하나에만 해당하는 정보인데, 세그먼트=sense로 쪼개는 위 변경 이후로는 여러 split sense 중 어디에 귀속시켜야 할지 원본에 구조적 근거가 없어졌다(억지로 마지막 sense에 붙이는 것도 부정확). 원래도 `senseSelect.ts`/LLM 프롬프트 어디서도 이 필드를 읽지 않던 미사용 필드였고 사실상 CC-CEDICT 1개 소스 전용이었던 터라(`shared/types.ts` 결정 사항 참고), `CL:` 세그먼트는 이제 그냥 버리고(gloss/sense 어디에도 안 들어감) 스키마에서 `DictionarySense.classifiers` 자체를 제거했다.

**병음 발음 표기 버그 발견 및 수정(2026-07-29).** CC-CEDICT 원본은 병음을 `[da3 suan4]`처럼 **숫자 성조**로 담고 있는데(汉典/萌典은 스크래핑 시점에 이미 발음 구별 부호 형태로 나와 이 문제가 없음, 이 소스만 예외), 이 값이 변환 없이 그대로 UI에 노출되고 있었다 — 사용자가 실제 앱 화면에서 발견. 표준 병음 성조 규칙(a>e>o>나머지 i/u/ü 중 마지막 글자, 단 "iu"/"ui"는 뒤 글자)을 재구현해(`cccedict.ts` `numberedPinyinToDiacritic`) 변환 후 표시하도록 수정. **ü 표기 확인**: CC-CEDICT는 ü를 흔히 쓰이는 "v"가 아니라 **"u:"**로 표기한다(실측: `nu:4`=衄, `yi1 lu:4`=一律) — 다른 로마자 입력기 관례와 다르니 혼동 주의. 구현 중 자체 버그도 발견해 수정: 'o' 판정을 "ou" 부분 문자열 포함 여부로만 하면 "guo2"(国)의 'o'를 못 찾아 'u'에 잘못 부호가 붙거나("gúo", 틀림), "zhong1"(中)처럼 'o'가 있어도 "ou"가 아니면 부호가 아예 안 붙는 문제가 있어 — 'o' 존재 여부로만 판정하도록 수정(guó/zhōng 재검증 통과). 재검증: 打算→dǎ suàn, 中国→Zhōng guó, 女→nǚ, 九→jiǔ(iu 조합), 会议→huì yì(ui 조합), 北京→Běi jīng(고유명사 대문자 보존), 先生/谢谢/月亮/小姐→둘째 음절 경성 정상적으로 부호 없이 표시.

### 汉典 (zh-Hans)

**접근**: 스크래핑, `/hans/`(간체)·`/hant/`(번체, zh-Hant 폴백용으로도 확인됨) 경로. WebFetch 도구는 실제 존재하는 페이지도 여전히 HTTP 404를 반환하지만, 일반 브라우저 User-Agent + 리다이렉트 추적(Node `fetch` 기본 동작)만으로 정적 SSR HTML이 200으로 온다.

**⚠️ 2차 재실측 정정(2026-07-28, "zh-Hans 1순위 소스가 대만 国语辞典 데이터를 참조해도 되는가" 논의 이후 — 한자/단어/성어 20여 개를 폭넓게 표본 조사).** 애초 `#gyjs` 하나만 채택했던 결정을 재검토한 결과 뒤집혔다: `#gyjs`(国语辞典)는 이름 그대로 **萌典과 같은 대만 교육부 계열 데이터**라, zh-Hans 1순위 소스가 실질적으로 대만 규범 콘텐츠를 쓰는 문제가 있고, zh-Hant 폴백 체인(萌典→汉典→CC-CEDICT)에서도 汉典의 `#gyjs`가 萌典과 같은 원천이라 2번째 폴백이 사실상 중복이 되는 문제가 있다. **결론: `#jbjs`(基本解释) → `#xxjs`(词语解释/详细解释) → `#gyjs`(国语辞典) 순서의 엔트리 단위 폴백으로 변경** — 앞 두 섹션이 이 사이트에서 실제로 대륙(mainland) 규범 콘텐츠를 담당하는 것으로 판단되고(근거는 아래), 뜻풀이를 하나라도 뽑을 수 있으면 그걸로 확정하고 `#gyjs`는 건드리지 않는다(같은 sense를 서로 다른 문장으로 중복 표기하는 문제를 피하기 위해 섹션 간 병합은 하지 않음 — sense 단위 병합이 아니라 섹션 단위 우선순위).

**섹션별 재실측 결과**:

- **`#jbjs`(基本解释, "기본 해석") — 한자 단독 표제어에만 존재.** 단어/성어 표제어(`打算`/`桌子`/`守株待兔` 등, 20여 개 표본 전수)에는 이 섹션 자체가 없음. 구조: `.jbjs-reading`(발음 그룹, 다음자면 여러 개 — `重`: zhòng/chóng 2개, `打`: dǎ/dá 2개 확인) 안에 `ol.jbjs-list` > `li.jbjs-item` > `.jbjs-item__def`(뜻풀이, `<span>`) + `.jbjs-item__eg`(용례구, "如：" 없이 그냥 "～负. ～荷." 식). **품사·근의어/반의어·인용 전부 없음**(`jbjs-pos`/`syn-tag`/`xxjs-also` 클래스 전수 조사 결과 0건) — 가장 단순하고 짧은 판본.
- **`#xxjs`("详细解释"/"词语解释") — 표제어 종류에 따라 완전히 다른 두 템플릿을 쓴다(같은 섹션 id인데 내용 구조가 다름, 실측으로 처음 확인):**
  - **단어/성어 템플릿**(`打算`/`桌子`/`苹果`/`守株待兔` 등): 발음 그룹 래퍼 없이 `.xxjs-reading-head`(단일 병음) 바로 뒤에 `ol.xxjs-list` 하나. `li.xxjs-item`(단일 뜻이면 `xxjs-item--nonum` 수식자 붙음) > `.xxjs-item__def`(뜻풀이, 빈 문자열일 수 있음 — 이 경우 그 li 는 버림, 실측: `打算` 1번 항목이 def 없이 `.xxjs-english`만 있는 요약용 더미 항목) + 선택적 `.xxjs-also`(label `--also`, "如：..." 예문) + 선택적 `.xxjs-english`(영어 번역, 스키마에 대응 필드 없어 미반영 — 기존 翻译 섹션 미반영 결정과 동일 근거). **근의어/반의어·품사·고전 인용 없음**(전수 조사: `xxjs-block-label--syn`/`--ant`가 이 템플릿에서 0건).
  - **한자 템플릿**(`爱`/`重`/`人`/`走`/`打` 등, `#jbjs`와 항상 공존): `.xxjs-reading`(발음 그룹, 다음자면 여러 개) 안에 `<section class="xxjs-pos-section">`(품사 배지 `.xxjs-pos-badge` — `#gyjs`의 `gy-pos__badge`와 동일 글자셋) + `ol.xxjs-list`. `.xxjs-item__def` 안에 영어 대역어가 `<span class="encs">[love]</span>` 식으로 **인라인으로 섞여 옴**(별도 필드 아님 — 태그만 벗기면 "对人或事物有深厚真挚的感情 [love]"처럼 원문 뒤에 붙는 형태). **⚠️ 알려진 이슈(미수정, 2026-07-28 대화 중 발견): 어댑터가 이 `.encs` span을 별도로 안 걷어내서 "[love]" 같은 영어 잔재가 그대로 `gloss`에 섞여 LLM 프롬프트·UI까지 전달된다** — 원래 이 사이트의 단어용 영어 번역 필드(`.xxjs-english`)는 스키마에 대응 필드가 없어 의도적으로 버리기로 했는데, 같은 성격의 정보가 이 인라인 케이스에서만 새는 것이라 일관성이 깨진 상태. **다만 이 경로(`#xxjs` 한자 템플릿)는 `#jbjs`가 없는 한자에서만 실제로 쓰이는데, 실측한 한자 6개 전부 `#jbjs`를 갖고 있어 발생 빈도가 낮다고 판단해 지금은 고치지 않기로 결정** — 나중에 `#jbjs`가 없는 한자 사례가 실제로 문제되면 `.encs` span을 gloss 추출 전에 제거하는 한 줄 수정으로 고칠 수 있음. **고전 인용이 `.xxjs-citation`(`.xxjs-citation__text`+`.xxjs-citation__dash`+`.xxjs-citation__source`로 저자·출전이 이미 구조적으로 분리돼 있음 — 기존에 "인용은 비구조화 텍스트"라 스코프 보류했던 전제가 틀렸음, 인용 자체는 파싱하기 쉽다. 다만 여전히 채택 안 함(아래 미반영 항목).** 첫 항목이 어원 설명("形声。从心，旡(jì)声。本义:亲爱;喜爱")일 때가 있어 이 경우도 사실상의 gloss로 그대로 채택(어원/뜻풀이 구분 마커 없음).
  - **실측 결과 `#jbjs`가 있는 한자는 예외 없이 `#xxjs`도 같이 있었다**(爱/给/人/重/走/打, 6/6) — 즉 어댑터에서 `#jbjs`를 우선하면 `#xxjs`의 한자 템플릿(품사·인용 포함)은 실질적으로 도달하지 않는 죽은 경로에 가깝다. 그래도 방어적으로 파싱은 되게 구현(향후 `#jbjs`만 없는 한자가 나올 가능성 대비).
- **`#gyjs`(国语辞典) — 모든 한자가 갖고 있는 건 아님.** `爱`/`给`(단순 한자, 다음자 아님)는 `#gyjs` 섹션 자체가 없음(반면 `打`/`人`/`重`/`走`는 있음) — 다음자 여부와 무관하게 커버리지가 들쭉날쭉. 반대로 신조어(`点赞`, 인터넷 유행어 "좋아요 누르다")는 `#xxjs`(단어 템플릿)는 있는데 `#gyjs`는 없음 — 대만 국어사전이 이런 신조어를 안 다루기 때문으로 추정. **`#jbjs`/`#xxjs`가 전부 실패했을 때만 마지막 폴백으로 사용**(순서 변경 전과 파싱 로직 자체는 동일 — `.gy-reading`/`gy-pos`/`.gy-sense`/`xxjs-also` 구조, 이전 기록 그대로 유효).
- **부가 발견 — `#cy`(成语, "성어") 전용 섹션.** 일부 성어(`守株待兔`/`狐假虎威`, 8개 표본 중 2개)에만 `id="cy" class="idiom-section"`로 별도 섹션이 있고, `解释`(뜻풀이)/`出处`(전고 출전)/`示例`(용례, 저자·서명 포함)/`语法`(문법 기능+사용역, 예: "连动式；作宾语、定语；含贬义" — "含贬义"=부정적 뉘앙스라는 사용역 신호까지 포함)로 완전히 정형화돼 있어 **`isIdiom` 판정에 가장 신뢰도 높은 신호**가 될 수 있다. 다만 표본 8개 중 2개(25%)에서만 존재해 커버리지가 낮고, 이번 구현 스코프(엔트리 단위 3섹션 폴백)엔 넣지 않음 — **차후 검토 과제로 기록만 해둠**(`isIdiom` 신호를 더 늘리고 싶을 때 1순위 후보).
- **부가 발견 — 한자 단위 번체 대응형 병기 메커니즘.** 기존 기록엔 단어/성어 표제어의 "一石二鸟（一石二鳥）" 병기만 있었는데, 한자 단독 표제어도 `#jbjs`의 `.jbjs-ftz`(이미지 아이콘+번체자)와 `#xxjs`의 `.xxjs-reading__fan`(번체자 텍스트만)으로 각각 병기됨을 확인. 여전히 미반영(헤드워드 이표기 스코프 재검토 항목과 동일 사유).
- **다단계(계층형) 뜻 구조 없음 — `#jbjs`/`#xxjs`도 재확인.** 두 섹션 다 `li`가 항상 형제 노드 나열이라 `DictionarySense.parentIndex`는 이 세 섹션 전부에서 항상 undefined로 유지.
- **`CL:`(양사) 마커 여전히 미확인** — `#jbjs`/`#xxjs`/`#gyjs` 어디에서도 CC-CEDICT식 명시적 양사 태그는 안 보임.
- **이번 구현에서 미반영(스코프 밖)은 기존과 동일**: 고전 인용 출전 메타데이터(구조 자체는 위에서 확인했듯 파싱 가능하나 en/ja/zh 공통 스코프 결정 보류 축과 동일해 계속 유보) · 상용 词组 · 다국어 翻译(`xxjs-english` 포함) · 간체/번체 대응형 병기 · 부수/획수/자형 · "同音词" · `#cy` 성어 전용 섹션(위 항목).

**스키마 매핑**: `#jbjs` → `#xxjs` → `#gyjs` 순서로 엔트리 단위 폴백(뜻풀이가 하나라도 나오면 그 섹션에서 확정, 다음 섹션은 안 봄). `.jbjs-item__def`/`.xxjs-item__def`/`.gy-sense__def` → `gloss[]`, `*-reading__py` → `pronunciations[].value`, `.xxjs-pos-badge`/`.gy-pos__badge` → `pos`+`posRaw`(둘 다 있는 한자는 `#jbjs`가 먼저 걸려 사실상 `#gyjs`로 폴백했을 때만 `pos`가 채워짐 — `#jbjs`/`#xxjs` 단어 템플릿은 애초에 pos 없음), `.jbjs-item__eg`/`.xxjs-also__text`(label `--also`)/`.gy-sense__eg-text` → `examples`, `#gyjs`의 `.xxjs-also`(label `--syn`/`--ant`)의 `.syn-tag` → `synonyms`/`antonyms`(**`#jbjs`/`#xxjs`로 확정된 엔트리는 이 필드들이 항상 undefined** — 근반의어 데이터는 `#gyjs`에만 있고 `#gyjs`는 앞 두 섹션이 전부 실패했을 때만 쓰이므로, 대다수 일반 표제어는 synonyms/antonyms를 못 받는 트레이드오프를 감수한 것). `isIdiom`은 여전히 항상 undefined(`#cy` 신호를 안 쓰기로 했으므로).

### 萌典 (zh-Hant)

**소스 식별자 결정(2026-07-28, 리네임)**: 이 소스의 `DictionarySourceId`/파일명/식별자는 원전(原典) 기준 `guoyu-cidian`(教育部重編國語辭典)으로 확정한다 — moedict.tw(萌典)는 이 사전을 서비스하는 **경유 플랫폼**일 뿐이고 실제 뜻풀이 원전은 教育部重編國語辭典이라, "moedict"가 아니라 원전 이름을 소스 식별자·표시 라벨(`教育部重編國語辭典`, 로마자 아님)로 쓴다.

**접근**: `moedict.tw` 경유 — 스크래핑이 아니라 **공개 JSON API**(`https://www.moedict.tw/uni/{글자}` 또는 `/a/{글자}.json`)로 확인됨, 대만 교육부 편찬(번체 네이티브, 대만식 표준 어휘는 汉典보다 강함 — 실측: 捷運 등 대만 인프라 용어).

**원본 구조 특징** `[2026-07-28, 行/蟑螂 API 직접 호출로 재실측]`:
- `definitions[].type` 필드로 품사 제공(名/動/形 재확인, 副/連/介/代/助/歎 나머지는 초기 조사만 있고 이번엔 재확인 안 함). 양사(量詞)는 별도 type 값이 없고 `名`(명사) 안에 "量詞："라는 평문으로만 표시되는 것도 기존 기록 유지(이번 재확인 대상 아님).
- `heteronyms`(복수) — 동자이음. **"行" 실측(JSON 직접 파싱, `len(heteronyms)`)으로 4개(háng/hàng/xíng/xìng) 재확인** `[재정정 — 직전 재실측 기록이 "3개, hàng 없음"이라 적어놨던 건 curl 출력이 터미널에서 중간에 잘려 보인 것 때문의 착오였고, 원래 초기 기록(4개)이 맞았다]`. 각 heteronym이 다른 병음에 다른 뜻풀이 세트를 가짐 → `DictionaryReading[]`으로 매핑하는 방침은 유지.
- `link` 필드(관련어 참조) — **"蟑螂" 실측: `definitions[0].link: ["也稱為「蜚蠊」。"]`로 정확히 재확인됨.** 단, 기존 기록엔 없던 사실이 하나 확인됨: **`link`는 문자열 하나가 아니라 문자열 배열**(`string[]`) `[세부 정정]` — 값 자체("也稱為「蜚蠊」")는 정확히 일치. `DictionarySense.seeAlso[]`(`kind: 'related'`)로 매핑하는 방침은 유지, 다만 어댑터가 `link[]` 배열 전체를 순회해야 함.
- `definitions[].example`(현대 용례, `如：「...」` 형태)과 `definitions[].quote`(고전 문헌 인용 + 출처, `《左傳．成公二年》：「屬當戎行，無所逃隱。」` 형태)가 **서로 다른 필드로 별도 존재**함을 실측 확인(`行`/`大`/`遊`/`裡` 등 다수) — 기존 기록(`shared/types.ts` `DictionarySense.examples` 주석)이 "萌典은 예문 자체가 없는 포맷"이라 적어놓은 건 틀림, `example` 필드는 있다. **`quote`는 스키마에 반영하지 않기로 결정**(2026-07-28) — 고문 인용은 현대 학습자용 예문과 성격이 달라(어려운 문어체, 출처 표기가 원문 안에 통짜로 섞여 있어 구조화하려면 별도 파싱 필요) 이 앱의 사전 조회 기능(현대어 뜻풀이·용례 확인)에 실익이 낮다고 판단, `example`만 `DictionarySense.examples`로 매핑하고 `quote`는 버린다.
- 표제어 최상위에 `radical`(부수)/`stroke_count`(총획수)/`non_radical_stroke_count`(부수 제외 획수) 필드 존재 확인(예: `貓` → `radical:"豸", stroke_count:16, non_radical_stroke_count:9`; 다만 성어처럼 여러 글자로 된 표제어는 `radical:""/stroke_count:0`으로 비어 있음, 실측: `一石二鳥`). **이 정보도 스키마에 반영하지 않기로 결정**(2026-07-28) — 이 앱엔 부수·획수를 보여주는 UI/기능이 없어(한자 쓰기 학습 도구가 아니라 화면에서 선택한 표현의 뜻/발음을 묻는 앱) 담을 실익이 없다고 판단, `DictionaryEntry`에 필드 추가 없이 버린다.
- 발음 표기가 heteronym마다 `bopomofo`(주음부호, 예: `ㄏㄤˊ`)·`pinyin`(한어병음, 예: `háng`)·`bopomofo2`(주음부호를 로마자로 옮긴 표기 — 한어병음과 다른 체계라 값이 갈릴 수 있음, 실측: `捷運` → `pinyin: "jié yùn"` vs `bopomofo2: "jié ǜn"`) 3종으로 온다. **결정(2026-07-28): `bopomofo`/`bopomofo2`는 쓰지 않고 `pinyin`(표준 한어병음)만 `DictionaryReading.pronunciations`에 채운다** — 이 앱의 발음 표기 기준을 汉典·CC-CEDICT와 동일한 한어병음으로 통일하기 위함(주음부호는 대만 학교 교육에서만 쓰이는 체계라 汉典/CC-CEDICT 어느 쪽에도 대응 표기가 없어 다른 zh 소스와 나란히 비교·폴백하기 어려움).
- `zh-pron`(방언별 발음) 관련 정보는 萌典 자체엔 없음(Wiktionary 원문 전용) — 아래 Wiktionary 공용 섹션 참고.

---

## Wiktionary (공용 — en/ja/zh 최종 폴백)

**en/ja/zh 세 언어 모두 en.wiktionary.org(영어판) 하나만 쓴다** — ja.wiktionary.org/zh.wiktionary.org 같은 네이티브판은 실측 결과 커버리지가 더 약해 미채택(위키미디어 접근 제한 등으로 추정). 이전 버전 문서는 이걸 언어별로 "Wiktionary (ja 항목)"/"Wiktionary (zh 항목)"로 나눠 마치 서로 다른 사이트 3개를 쓰는 것처럼 보이게 써놨었는데, 실제로는 **하나의 데이터 소스를 언어 태그로 걸러 쓰는 것**이라 이번에 하나의 섹션으로 통합했다.

**접근 경로 자체가 완전히 다른 응답 형식을 주는 2가지로 갈린다는 게 2026-07-28 재실측으로 새로 명확해졌다** — 이전 기록은 이 둘을 뭉뚱그려 썼다:

1. **en.wiktionary.org 공식 REST API**(`GET /api/rest_v1/page/definition/{word}`, 무료, 키 불필요) — 실측(`ate`, `捷運`): 최상위가 언어 코드 키(`en`/`ja`/`zh`/... 맵) 구조이고, 언어별 배열 원소는 `partOfSpeech`+`definitions[]`(각 `definition`은 위키링크 HTML이 그대로 섞인 문자열이라 텍스트 정제 필요, 종종 `parsedExamples`/`examples` 포함). **`phonetic` 필드도, meaning 단위 `synonyms`/`antonyms` 필드도 여기엔 없음.** `捷運`(zh) 실측 결과 `{{zh-pron}}` 같은 방언별 발음 정보도 이 API엔 전혀 없음 — 아래 3번(raw wikitext)에서만 나온다.
2. **dictionaryapi.dev**(서드파티, en.wiktionary.org 데이터를 재가공, **en 전용 — ja/zh 커버리지 없음**) — 실측(`ate`): `word`/`phonetic`(최상위, 실제 IPA `"/eɪt/"`)/`phonetics[]`/`meanings[]` 구조. `meanings[].definitions[]`엔 `definition`/`example`/`synonyms`/`antonyms`가 있지만, **synonyms/antonyms는 실제로는 definitions 개별 항목이 아니라 그 상위 `meanings[]`(품사 그룹) 레벨에만 채워져 있음을 재확인**(실측: "ate"의 meaning-level `synonyms` = "bother, disturb, worry, consume, swallow, breakfast, chow down, dine, dinner, feed one's face, lunch, supper, tea") — 어댑터가 같은 meaning 안의 모든 sense에 복제해 채워야 한다는 기존 방침 그대로 확정.
3. **raw wikitext**(`action=parse` 등) — REST API/dictionaryapi.dev 둘 다 못 주는 정보(ja 활용 템플릿, zh 방언 발음 블록)가 여기에만 있음. 아래 언어별 항목 참고.

**언어별 최종 폴백 특이사항**:
- **en**: 활용형(ran/went/ate 등)이 원형과 교차 연결돼 있어 그대로 조회해도 정상 동작(실측 확인) — ja/zh와 달리 형태소 분석 전처리 불필요. 관용구 표시 자체가 없음 — "kick the bucket"도 REST API 기준 `partOfSpeech: "verb"`로만 나와 `isIdiom`은 이 소스는 항상 undefined.
- **ja**(`食べる` raw wikitext 실측): `====Conjugation====` 섹션이 一段/五段 등 활용형 전체를 뽑아내는 템플릿(`{{ja-ichi}}`, `{{ja-conj-ex}}` 등, て形·ない形·た形·가능형·수동형·사역형까지 실제 활용된 표기로 렌더링됨) — `conjugationClass`(라벨 하나)로는 이 활용표 자체를 못 담음. **스코프 결정: 활용표 전체는 파싱하지 않고 "一段"/"五段(う)" 같은 분류 라벨만 뽑아 `conjugationClass`에 채운다** — 실제 활용형(食べた/食べて 등)은 이미 형태소 분석기(`main/nlp/japanese.ts`)가 별도 처리 중이라 중복 파싱 불필요.
- **zh**(`捷運` raw wikitext 실측): `{{zh-pron}}` 블록 하나에 표준중국어(jiéyùn)·광둥어(zit3 wan6)·객가어(POJ+HRS 두 표기)·민난어(chia̍t-ūn) 4개 방언이 동시에 들어있음 — "발음이 다르면 뜻도 다르다"(`DictionaryReading` 분리 기준)도 "같은 sense의 지역 변이"(OEWN variety 케이스)도 아닌 제3의 축(동일 표기·동일 뜻·언어 자체가 다른 방언)이라 스키마 어디에도 안 맞고, 汉典·萌典·CC-CEDICT는 애초에 표준중국어만 다뤄 이 문제가 없으며 이 앱에 방언별 발음 질문 기능도 없어 무리해서 담을 실익이 없음 → **표준중국어(Mandarin) `m=` 필드 하나만 뽑아 `pronunciations: [{ value }]`로 채우고 나머지 방언은 버린다.** 구어 줄임말/인터넷 유행어(超商·很雷·部落格 등) 전용 최종 폴백 — 汉典·萌典 둘 다 이 카테고리를 놓치는 것을 실측으로 확인.
- **zh 간체/번체 한쪽 표기로만 페이지가 있는 경우(2026-07-29, 실사용 중 발견)**: en.wiktionary.org의 중국어 표제어가 간체/번체 어느 한쪽에만 있을 수 있다 — 실측: "天线"(간체, antenna)은 REST API가 404를 주는데 "天線"(번체)은 정상 응답을 준다. 기존 `tryZhDefinitionsFallback`은 **같은 표제어**의 raw wikitext를 다시 보는 것뿐이라 이 케이스(표제어 자체가 다른 스크립트에만 있음)는 못 잡았다. `question/dictionary/cccedict.ts`에 `findOtherScriptVariant`를 새로 export해(이미 로드해 쓰는 CC-CEDICT 번들에서 간체↔번체 반대 표기를 찾음, 별도 변환 라이브러리 불필요) `wiktionary.ts`가 기존 조회가 완전히 실패하면(zh 한정) 반대 표기로 한 번 더 시도하도록 수정 — 그 사전에도 없는 단어면 재시도 자체를 안 해 무한 루프 없음. 화면에 보이는 headword는 실제 조회에 성공한 표기가 아니라 사용자가 선택한 원래 표기로 되돌려 일관성 유지.

**발음 보강 구현 현황**(2026-07-28, `question/dictionary/wiktionary.ts` 실제 구현 — 연결 어댑터 자체는 완료, 정식 폴백 오케스트레이션 미연동 상태는 위 §전체와 동일):

REST API(definition 엔드포인트)엔 발음 필드가 아예 없어(위 1번 항목) 이 어댑터가 만드는 `DictionaryReading.pronunciations`는 기본적으로 전부 undefined다. 이를 언어별로 별도 보강한다. **찾은 값은 전부 배열로 채운다**(`DictionaryReading.pronunciations`가 원래 배열 스키마인데도 처음엔 첫 번째 값만 쓰고 있었음 — 2026-07-28 수정, 아래 각 언어 항목의 실측 예시가 이제 전부 그 대상):

**en/ja/zh 셋 다 raw wikitext 경로로 통일**(2026-07-28, 사용자 지적으로 재작업 — 처음엔 en 만 dictionaryapi.dev(서드파티) 로 보강했음): dictionaryapi.dev 는 `phonetic`/`phonetics[].text` 가 entry 하나에 하나뿐이라(meaning/품사별 구분 자체가 없는 API 구조 — 실측 확인, "run") "lead"(금속 `/lɛd/` vs 이끌다 `/liːd/`)처럼 뜻마다 발음이 다른 단어를 근본적으로 구분 못 했다. en wikitext 도 ja/zh 와 똑같이 `===Etymology N===`/`====Pronunciation====`/`{{IPA|en|/값/|...}}` 구조를 가진 것을 "lead"/"run" 실측으로 확인(REST API 블록 순서와도 일치: "lead" wikitext 헤더 [Noun, Verb, Verb, Noun, Adjective, Verb] ↔ REST API 블록 순서 완전 일치) — dictionaryapi.dev 를 완전히 걷어내고 en 도 아래 `assignPerBlockPronunciations` 로 통일했다. `lead`(Noun+Verb=`/ˈlɛd/`, 나머지 Verb+Noun+Adjective+Verb=`/ˈliːd/` 정확히 분리)·`run`(단일 Etymology, GA/RP·North England/Ireland·Scotland/Wales 3개 지역 발음 전부 모든 reading에 동일 적용)으로 검증.

- **ja/zh**: raw wikitext(`action=parse`, `prop=wikitext`)의 `{{ja-pron|よみ|...}}`/`{{zh-pron|m=병음|...}}`에서 값을 뽑되, **처음엔 페이지 전체에서 긁어 모든 reading에 똑같이 복제하는 방식**이었다가, **사용자 지적(2026-07-28)으로 재작업** — Wiktionary wikitext 헤더 구조를 실측(`猫`/`東京`/`打` 직접 조회) 확인한 결과 `{{ja-pron}}`/`{{zh-pron}}`가 페이지에 뭉텅이로 있는 게 아니라 `===Etymology N===`(다의어별) 아래 `====Pronunciation====`으로 **그 바로 다음 POS 섹션에만** 대응됨을 확인:
  - `猫`: Etymology 1(ねこ)/Noun, Etymology 2(ねこま)/Noun — 완전히 분리된 두 뜻.
  - `東京`: Etymology 1(とうきょう)/Proper noun+Noun, Etymology 2(とうけい)/Proper noun, Etymology 3(トンキン)/Proper noun.
  - REST API 블록도 같은 문서 순서로 옴을 실측 확인(東京: wikitext 헤더 [Proper noun, Noun, Proper noun, Proper noun] ↔ REST API 블록 [Proper noun(5 defs), Noun(1), Proper noun(5), Proper noun(1)] 완전 일치).

  그래서 `assignPerBlockPronunciations`(`wiktionary.ts`)가 헤더를 등장 순서대로 걸으며 "헤더 텍스트가 지금 기다리는 REST 블록의 partOfSpeech 와 일치할 때만 매칭·소비"하는 방식으로 각 REST API 블록(=`DictionaryReading`)에 그 직전 Pronunciation 헤더의 값만 정확히 붙인다 — 이전처럼 서로 무관한 읽기(ねこ/ねこま, とうきょう/とうけい/トンキン)를 모든 reading에 동일하게 복제하지 않는다. 단일 Etymology 표제어(`食べる`처럼 `===Etymology===`/`===Pronunciation===`/`===Verb===`가 나란한 구조)도 같은 알고리즘으로 자연히 처리됨(깊이를 안 보고 등장 순서만 봄).

  zh는 값 자체를 뽑을 때 두 가지 함정이 있다(실측: 你好/中國/一/打/謝謝/打算/水/的/了/麼/嗎 11개 표제어):  1. 값이 콤마로 여러 개 이어질 때 일부는 병음이 아니라 콤마로 덧붙는 수식 플래그다 — `打算`→`m=dǎsuàn,tl=y`(tl=톤 산디), `水`→`m=shuǐ,er=y`(er=얼화), `的`→`m=de,dì,2tl=y,1nb=unstressed,2nb=stressed`(앞 2개는 실제 복수 병음 — "de"/"dì" 둘 다 채택, 나머지는 번호 붙은 플래그). `=`가 포함된 세그먼트만 걸러내고 남는 건 전부 채택한다.
  2. 일부 블록은 `m=` 값 자체가 병음이 아니라 조회한 한자 그대로다(실측: `一`/`打`의 일부 zh-pron 블록 → `m=一`/`m=打`, 정확한 의미는 불명 — 다른 항목을 보라는 플레이스홀더로 추정). CJK 통합 한자 포함 여부로 걸러낸다.

  ja는 `猫`(ねこ/ねこま)·`東京`(3개, 위 예시)·`食べる`(たべる)·`走る`(はしる)로, zh는 `打算`(Verb/Noun 둘 다 dǎsuàn)·`你好`(nǐ hǎo)·`捷運`(jiéyùn)로 블록별 정확 매칭까지 실API 검증 완료. **`水`/`一` 같은 단일 한자 표제어는 이 발음 보강과 무관하게, REST API definition 엔드포인트 자체가 `zh` 언어 블록을 안 줘서(원인 불명 — 페이지 구조 문제로 추정) 뜻풀이 단계에서부터 entry 없음으로 끝난다** — 발음 시도 자체가 안 일어남, 별도 조사 필요(아래 "아직 미확인 항목" 참고). **헤더 구조가 예상과 다르면(드묾) 그 블록은 undefined로 남긴다** — 틀린 값을 자신 있게 보여주는 것보다 안전하다는 판단(2026-07-28).

**부가 보강**(2026-07-28, 사용자 피드백 반영):
- 발음이 여러 개일 때 `senseSelect.ts`가 첫 번째만 쓰던 것도 함께 고쳐 전부 `[값1, 값2]` 형태로 표시하도록 변경(위 wiktionary.ts 변경이 실제 화면에 드러나려면 이 쪽도 같이 고쳐야 했음).
- Wikimedia User-Agent 정책(연락 가능한 수단 명시 필수, 이메일이 꼭 아니어도 이슈를 남길 수 있는 저장소 URL이면 충분) 미준수로 개발 중 HTTP 429를 자주 맞아, `WIKTIONARY_USER_AGENT` 상수(`"JoJo-dictionary-adapter/1.0 (저장소 URL)"`)로 en.wiktionary.org REST API·action API 요청 전부에 통일 적용(이후 dictionaryapi.dev 는 아예 걷어냄 — 아래 발음 en/ja/zh 통일 항목 참고).
- Wiktionary는 CC BY-SA 4.0(+ GFDL) 라이선스라 저작자 표시 의무가 있음 — `senseSelect.ts`의 출처 줄이 Wiktionary일 때만 `[Wiktionary](표제어 페이지 URL) (CC BY-SA 4.0)` 형태로 링크+라이선스명을 함께 표기하도록 변경. OEWN도 CC BY 4.0이라 같은 처리가 필요하나 이번 스코프에서는 제외(별도 검토 필요).
- **캐싱 없음(미착수, 2026-07-28 논의) — 같은 단어를 반복 조회해도 매번 REST API + wikitext 2번을 새로 호출한다.** en/ja/zh 통일 이후 모든 조회가 항상 이 2번 요청을 거치는데, 개발 중 실측 테스트에서 이미 HTTP 429(Wikimedia 레이트리밋)를 여러 번 맞은 전례가 있어(위 User-Agent 항목 참고), 실사용에서 같은 단어가 짧은 시간에 반복 조회되는 패턴(예: 같은 문서를 스크롤하며 같은 단어를 다시 선택)이 있으면 문제가 될 수 있다. 간단한 인메모리 캐시(word+language 키, TTL 또는 세션 단위 무제한)를 어댑터 레벨에 두면 해결되나, 캐시 무효화 정책(사전 원문이 편집돼 바뀔 수 있음 — 다만 실사용상 빈도 낮음)·캐시 크기 상한 등 세부 결정이 남아있어 아직 미착수. 폴백 오케스트레이션 구현 시점에 함께 검토 필요.

**부가 보강**(2026-07-28, 사용자 피드백 반영):
- 발음이 여러 개일 때 `senseSelect.ts`가 첫 번째만 쓰던 것도 함께 고쳐 전부 `[값1, 값2]` 형태로 표시하도록 변경(위 wiktionary.ts 변경이 실제 화면에 드러나려면 이 쪽도 같이 고쳐야 했음).
- Wikimedia User-Agent 정책(연락 가능한 수단 명시 필수, 이메일이 꼭 아니어도 이슈를 남길 수 있는 저장소 URL이면 충분) 미준수로 개발 중 HTTP 429를 자주 맞아, `WIKTIONARY_USER_AGENT` 상수(`"JoJo-dictionary-adapter/1.0 (저장소 URL)"`)로 en.wiktionary.org REST API·action API·dictionaryapi.dev 요청 전부에 통일 적용.
- Wiktionary는 CC BY-SA 4.0(+ GFDL) 라이선스라 저작자 표시 의무가 있음 — `senseSelect.ts`의 출처 줄이 Wiktionary일 때만 `[Wiktionary](표제어 페이지 URL) (CC BY-SA 4.0)` 형태로 링크+라이선스명을 함께 표기하도록 변경.
- **OEWN도 CC BY 4.0이라 같은 저작자 표시 의무 확인, 추가 완료(2026-07-28)** — `SOURCE_LICENSE`에 `wordnet: 'CC BY 4.0'` 등록. 링크는 표제어별 딥링크 대신 **공식 GitHub 저장소(`https://github.com/globalwordnet/english-wordnet`) 프로젝트 페이지로 고정** — 위 OEWN 절 실측대로 `en-word.net`의 정적/라이브 API 링크가 둘 다 503으로 불안정해(재실측으로 재확인) 조회 결과별 딥링크를 만들면 사용자가 클릭했을 때 죽은 링크로 연결될 위험이 있고, 이 어댑터 자체가 애초에 그 불안정한 라이브 소스를 안 쓰고 GitHub Releases 데이터 파일을 로컬 번들로 받아 쓰므로(`oewn.ts`) 조회 결과와 무관하게 항상 살아있는 이 프로젝트 페이지가 더 안전하다고 판단. 이 김에 `formatDictionaryAnswer`의 `source === 'wiktionary' ? ... : SOURCE_LABELS[source]` 하드코딩 분기를 소스별 URL 빌더 맵(`SOURCE_URL: Partial<Record<DictionarySourceId, (word: string) => string>>`)으로 일반화 — 맵에 없는 소스는 자동으로 링크 없이 라이선스명만(또는 라이선스도 없으면 그냥 라벨만) 표기되도록 정리.

### 출처 링크 — 나머지 소스 추가 + 섹션 앵커 + 링크-본문 불일치 버그(2026-07-28~29)

**나머지 사전 소스(MW/JMdict/汉典/萌典/CC-CEDICT)도 `SOURCE_URL`에 링크 추가**(실제 URL 라이브 검증 완료):
- **merriam-webster**: 어댑터가 쓰는 `dictionaryapi.com`(API 전용)이 아니라 소비자용 웹사이트 `merriam-webster.com/dictionary/{표제어}`로 연결. curl로 직접 검증 시 UA를 바꿔도 403이 나오는데(서버/데이터센터 IP 차단으로 추정), 실제 브라우저 클릭은 문제없을 것으로 판단하나 자동화 도구로는 최종 확인 못함.
- **jmdict**: 로컬 번들이라 표제어별 페이지가 없어, 같은 JMdict 데이터를 쓰는 공개 사이트 `jisho.org/word/{표제어}`로 연결(200 OK 실측 확인).
- **hanyu-dict(汉典)**: 어댑터가 실제 조회에 쓰는 `zdic.net/{hans|hant}/{표제어}` 그대로 연결(`ZDIC_BASE`/`ZDIC_LANG_PATH`를 `hanyu.ts`에서 export해 재사용). 이 사이트도 페이지 안에 여러 섹션(`#jbjs`/`#xxjs`/`#gyjs`)이 있지만, 어댑터가 실제로 어느 섹션을 채택했는지가 링크 빌더까지 안 넘어와 있어 앵커는 안 붙임(잘못된 섹션 앵커보다 단어 페이지 전체 연결이 안전).
- **guoyu-cidian(萌典)**: API 엔드포인트(`moedict.tw/uni/...`)가 아니라 사람이 보는 웹 뷰어 `moedict.tw/{표제어}`로 연결(200 OK 실측 확인).
- **cc-cedict**: 로컬 파일 기반이라 표제어별 페이지 자체가 없음 — wordnet(OEWN)과 같은 방식으로 프로젝트 소개 페이지(MDBG CC-CEDICT 페이지, 200 OK 실측 확인)로 대신 연결.

**섹션 앵커 추가**: kotobank.jp 표제어 페이지는 daijisen 앞에 다른 사전이 최대 8개 있을 수 있는데, 각 사전 섹션(`<article id="...">`)의 id가 그 사전명("デジタル大辞泉")을 UTF-8 바이트 hex를 점(.)으로 이어붙인 값이라는 걸 실측 확인(id가 실제 인코딩과 정확히 일치하는지 재검증도 완료) — `kotobankSectionAnchor` 헬퍼로 이 앵커를 만들어 daijisen 섹션으로 바로 스크롤되게 함. en.wiktionary.org도 언어별 표준 MediaWiki 헤딩 id(`<h2 id="Japanese">` 등)를 쓰는 걸 실측 확인(`#Japanese` 앵커로 정상 이동)해 조회 언어의 영문명(`WIKTIONARY_LANG_NAME`, `wiktionary.ts`에서 export)을 앵커로 추가. 둘 다 개별 뜻풀이 번호까지는 이 사이트들 마크업상 앵커가 없어 안 됨(섹션/언어 단위 점프까지만 가능).

**출처 링크가 채팅창 본문과 어긋나는 버그 발견 및 수정(2026-07-28)**: 실측(MW "walked"): 채팅창 본문은 정확히 "walk"(동사 원형, MW 자체 교차참조로 이미 잘 해결됨)로 나오는데, 출처 링크는 `formatDictionaryAnswer`의 `queryWord` 매개변수(원래 선택 표면형 "walked") 그대로 써서 `dictionary/walked`로 걸려 본문("walk")과 어긋났다 — en/ja/zh 전 소스 공통 로직이라 언어를 안 가리는 문제였음. `queryWord` 대신 실제로 선택된 `selected[0].sense.headword`를 쓰도록 수정 — 이 값은 각 소스 어댑터가 실제로 찾아낸 원형을 항상 정확히 반영하므로(활용형 해석 로직이 소스마다 달라도) 언어별 전용 배선 없이 en/ja/zh 전부 일관되게 맞는다. `queryWord`는 "문맥에 맞는 뜻을 못 찾았을 때" 안내 메시지에만 남겨 쓴다.

---

## 공통 스키마 결정 사항

여러 소스에 걸쳐 있는 스키마 설계 판단(전체 근거는 `src/shared/types.ts` 해당 필드 주석 참고):

- `DictionaryEntry.source`는 스키마엔 유지하되 LLM 프롬프트엔 넣지 않음 — 폴백 체인 디버깅·UI 출처 표기(예: "출처: JMdict")용으로만 사용.
- `isCommon`(entry 선택용 필드)은 최종적으로 없앰 — 동일 표기의 서로 다른 reading(예: はし/きょう)은 **하나의 entry로 병합**되는 게 맞는 설계(MW hom, 萌典 heteronyms와 동일 패턴)라 우선순위 신호의 역할은 "entry 선택"이 아니라 "그 entry 안 어느 reading/sense가 대표인지"로 축소 — `DictionaryReading.isCommon`(JMdict 전용, reading 레벨)으로 분리해 실제 데이터가 있는 레벨에 맞춰 부활시킴. (당초 함께 부활시켰던 `DictionarySense.tagCount`(OEWN 전용, sense 레벨)는 **2026-07-28 실제 데이터 확인 결과 이 JSON 릴리스에 해당 필드가 없어 폐기 대상** — 아래 OEWN 섹션 참고.)
- `pos`(CanonicalPos)는 언어 간 겹치는 범위로만 표준화하고, 원본 세부 표기는 `posRaw`(LLM에 전달 안 함)에 보존. 문법 설명에 실제로 필요한 세부 정보(활용 분류 등)는 `posRaw`에만 있으면 버려지는 것과 같으므로 `conjugationClass`(사람이 읽을 수 있는 문자열, LLM에도 전달)로 별도 승격.
- ~~판별 유니온(discriminated union) 대신 공통 베이스+옵셔널 확장 필드 방식을 의도적으로 채택 — 언어 전용 필드가 2~3개 규모에서는 유니온이 과한 복잡도로 판단~~ → **번복(2026-07-28)**: 실제로 세어보니 언어 전용 필드가 이미 ja 3개(`conjugationClass`/`isCommon`/`appliesToHeadwords`)·en 1개(`irregularForms`)·zh 1개(`classifiers`)로(`transitive`는 en/ja 공유라 어느 쪽 전용 개수에도 안 넣음) "2~3개 규모"를 이미 넘어서 있었음(en 불규칙 동사 활용 등 확인 예정 항목까지 감안하면 더 늘 것). **"최상위(entry)만 판별 + 나머지는 제네릭으로 연동"** 방식으로 전환 — `DictionaryEntry<L extends Language = Language>`가 `language: L` 하나만 판별 필드로 갖고, `readings`/`senses`는 같은 `L`을 제네릭으로 물려받아(`DictionaryReading<L>`/`DictionarySense<L>`) `entry.language`로 좁히면 안쪽 언어 전용 필드까지 자동으로 좁혀진다(`src/shared/types.ts` 실제 구현 + 격리된 타입체크 파일로 좁히기/미좁히기 양쪽 다 tsc로 검증 완료). **트레이드오프**: sense/reading 자체엔 판별 필드를 안 뒀기 때문에, entry와 분리된 채 `sense: DictionarySense<Language>` 하나만 받는 함수는 `'classifiers' in sense`처럼 속성 존재 여부로 좁혀야 한다(entry를 거쳐 좁힌 경우보다 번거로움). `usageTags`/`domain`/`seeAlso` 등 실제로 여러 언어가 공유하는 필드는 그대로 `DictionarySenseBase`(공통 베이스)에 남겨뒀고, 언어 전용 필드만 `DictionarySenseExt<L>`로 분리했다.
- `usageTags`를 `string[]`에서 `UsageTag[]`(`{ text, kind?: 'register'|'convention'|'dialect'|'other' }`)로 구조화(2026-07-28) — 격식(MW `sls`, CC-CEDICT `(coll.)`/`(slang)` 등)과 격식 무관 표기 관례(MW `lbs`, JMdict "가나로만 씀")가 문자열 하나에 섞여 있으면, PLAN §3 "격식·객관 표현 여부" 자주 쓰는 질문 기능이 격식 판단에 무관한 태그까지 LLM에 같이 넣어 판단을 오염시킬 수 있음을 뒤늦게 발견해 정정. 소스별 라벨의 `kind` 분류는 위 MW/JMdict/CC-CEDICT 각 섹션 참고 — 분류가 애매한 라벨(CC-CEDICT `(loanword)`/`(bound form)`)은 `other`로 남겨 억지로 분류하지 않는다.
- 같은 이유로 `seeAlso`도 `string[]`에서 `SeeAlsoRef[]`(`{ text, kind?: 'variant'|'dialectVariant'|'abbreviation'|'usedIn'|'related' }`)로 구조화(2026-07-28) — CC-CEDICT 교차참조가 `variant of`(표기 변이)/`abbr. for`(줄임말↔원말)/`used in`(복합어 구성 성분)/`see also`(느슨한 관련어)로 관계 성격이 다 다른데 문자열 하나에 뭉쳐 있었음. **`usageTags`와 합치는 방안은 검토 후 기각** — `usageTags`는 이 뜻 자체의 성질을 나타내는 라벨이고 `seeAlso`는 다른 표제어를 가리키는 포인터라 성격이 근본적으로 달라서(나중에 "클릭해서 재조회" 같은 기능이 붙을 수 있는 것도 포인터 쪽), 합치면 `kind` 종류만 7개로 늘어나 오히려 지금 고치려던 문제를 재현하게 됨. `classifiers`(CC-CEDICT 양사)는 같은 검토를 거쳤으나 **배열 원소가 전부 "양사"라는 동일 개념이라 이 문제에 해당하지 않음** — 다만 원본 표기(`個|个[ge4]` 같은 파이프·대괄호)가 그대로 문자열에 남는 별개 문제가 있어 구조화(`{ hanzi, pinyin? }`)를 검토했으나 **하지 않기로 결정(2026-07-28)** — 원본 세그먼트 그대로 두는 현 방침 유지.
- `DictionarySense.parentIndex?: number` 신설(2026-07-28) — MW `sdsense`(위 MW 섹션의 "photosynthesis" 하위 정의 참고)와 daijisen(デジタル大辞泉, 위 daijisen 섹션 참고)의 `①②③`→`㋐㋑㋒` 번호매김이 둘 다 "병렬 대안 뜻"이 아니라 "상위 뜻의 더 좁은 하위 구분"이라는 계층 구조인데, `gloss: string[]`(OEWN의 병렬 대안 정의용으로 설계됨)는 이 부모-자식 관계를 평면화해버림. `[정정, 리네임과 함께]`: 최초 설계 당시엔 이 예시가 精選版日本国語大辞典(nikkokuseisen)의 `[一]`→`①②③`→`(イ)(ロ)` 3단 번호매김이었으나, 이후 ja 소스를 daijisen 하나로 채택 확정하면서(精選版은 실측만 하고 미채택, 위 daijisen 섹션 참고) 이 필드의 실제 근거도 daijisen 자체의 번호매김으로 정정한다 — "상위 뜻의 더 좁은 하위 구분"이라는 계층 구조라는 결론 자체는 동일. en/ja 두 무관한 소스에서 독립적으로 같은 패턴이 나와 zh(汉典 인용 포함 뜻풀이)까지 결국 마주칠 문제로 예상했으나, **이후 실측(2026-07-28, 위 汉典 섹션 참고) 결과 汉典은 다단계 구조가 없는 것으로 확인돼 이 예상은 기각됨** — 현재 이 필드가 실제로 필요한 소스는 en(MW)/ja(daijisen) 둘뿐. 같은 `DictionaryReading.senses` 배열 안에서 직속 부모 sense 의 인덱스(0-based)를 가리키는 필드를 추가해 트리 구조를 재구성할 수 있게 함(다단이면 부모의 parentIndex 를 따라 조상까지 거슬러 올라감). 계층 없는 소스는 항상 undefined. **이 값을 실제로 채우는 어댑터 파싱 로직(MW 완료, 아래 참고)과, LLM 프롬프트가 이 정보를 활용하는 부분(`NumberedSense.parentIndex`, 아래 "LLM이 실제로 쓸 수 있게 연결" 항목 참고)은 이후 완료됨 — UI 상 들여쓰기 표시는 아직 미구현.**
- `gloss`를 `parentIndex`가 없을 때만 필수로 정정(2026-07-28) — 위 `parentIndex` 신설 직후 설계 재검토 중 발견: daijisen의 `①②③` 같은 최상위 그룹은 자기 자신의 뜻풀이 없이 하위(`㋐㋑㋒`)를 묶기만 하는 "그룹 헤더" 역할일 수 있는데, `gloss: string[]`가 무조건 필수라 이런 그룹 헤더 sense도 값을 채워야 했음. 이러면 어댑터마다 "자식 gloss 복제" 또는 "빈 문자열" 같은 서로 다른 임기응변을 택할 위험이 있고, LLM 프롬프트/UI 쪽에서도 그 gloss가 "진짜 뜻"인지 "임기응변으로 채운 값"인지 구분할 방법이 없었음. `gloss`/`parentIndex`를 하나의 유니온(`DictionarySenseGloss`, `src/shared/types.ts`)으로 묶어 `parentIndex`가 없으면 `gloss` 필수, 있으면 선택으로 변경 — daijisen의 `㋐㋑㋒`처럼 하위이면서도 실제 뜻풀이가 있는 sense는 어댑터가 그대로 `gloss`를 채우면 되고, `①②③` 같은 순수 그룹 헤더만 생략하면 됨.
- 최종 검토(2026-07-28)에서 발견한 사소한 이슈 2개도 정리:
  - `transitive`가 en/ja 확장 타입 양쪽에 각각 선언돼 있어 설명 주석도 두 곳에 나뉘어 있었고, 서로 "반대쪽 참고"라고 써놔서 한쪽만 고치고 다른 쪽을 놓칠 위험이 있었음 → `TransitiveExt` 공통 타입 하나로 뽑아 en/ja 확장 타입이 인터섹션(`&`)으로 물려받게 정리(설명도 한 곳에만).
  - `CanonicalPos`에 언어 전용 값(`article`=en, `particle`=ja/zh, `classifier`=zh, `adnominal`=ja)이 섞여 있어서, en 어댑터가 실수로 `pos: 'classifier'`를 넣어도 컴파일러가 못 잡는 문제가 있었음 → `DictionaryEntry<L>`과 같은 방식으로 `CanonicalPos<L extends Language = Language>` 제네릭화(공통 품사는 `CanonicalPosCommon`으로 뽑고 언어별로 전용 품사를 더함). `DictionarySenseBase`도 `<L>`을 받아 `pos?: CanonicalPos<L>`로 연동. 격리된 타입체크로 각 언어가 실제로 자기 언어에 없는 품사 값을 못 넣는 것까지 tsc 로 검증 완료.
- `DictionarySenseCommon.pos`를 단일값(`CanonicalPos<L>`)에서 배열(`CanonicalPos<L>[]`)로 변경(2026-07-28) — sense 하나가 품사 코드를 2개 이상 동시에 갖는 실제 사례 발견: JMdict 실측 "らしい" sense2 → `partOfSpeech: ["suf", "adj-i"]`(접미사이면서 い형용사), "元気" sense1 → `["Na-adjective (keiyodoshi)", "Noun"]`(な형용사이면서 명사). 기존엔 어댑터의 `mapPos`가 배열을 순회하다 "other가 아닌 첫 코드"에서 멈추고 대표 하나만 반환해(`jmdict.ts`), 나머지는 `posRaw`(원본 문자열, LLM에 미전달)에만 남아 정보가 손실됐음 — LLM 프롬프트/UI가 실제로는 형용사+접미사인 sense를 형용사 하나로만 인식하는 문제. `pos`가 "이 sense에 해당하는 품사 전부"를 담도록 배열로 바꿔 해결(원소 1개 이상, 빈 배열 대신 undefined로 통일). MW(`fl`)/OEWN(synset pos)/Wiktionary(`partOfSpeech`)/萌典(`definitions[].type`)/汉典(`gy-pos__badge`)처럼 소스가 원래 코드 하나만 주는 경우는 매핑된 값을 `[value]`로 감싸기만 함 — 실질적으로 배열 확장이 의미 있는 소스는 JMdict뿐.
- **정식 폴백 오케스트레이션 구현(2026-07-28)** — `question/dictionary.ts`의 `FALLBACK_CHAINS`가 언어별 확정 순서(en `merriam-webster→wordnet→wiktionary`, ja `jmdict→wiktionary`, zh-Hans `hanyu-dict→cc-cedict→wiktionary`, zh-Hant `guoyu-cidian→hanyu-dict→cc-cedict→wiktionary`)대로 앞 소스가 못 찾거나(entries 없음) 실패(네트워크 에러 등)하면 조용히 다음으로 넘어간다. daijisen는 아직 다른 세션에서 구현 중이라 ja 체인에서 빠져 있음 — 머지되면 배열 맨 앞에 추가만 하면 된다. 소스별 조회를 `fetchSourceEntries` 하나로 통합해 폴백 체인과 기존 `forceSource` 디버깅 경로(팝업 "직접 선택" 토글, 기본값은 켜짐으로 변경됨 2026-07-28)가 공유하도록 정리 — 부수 효과로 JMdict/汉典/教育部重編國語辭典도 forceSource 강제 호출을 지원하게 됨(이전엔 MW/OEWN/Wiktionary/CC-CEDICT만 연결돼 있었음).
- **`DictionarySense.parentIndex`를 LLM이 실제로 쓸 수 있게 연결(2026-07-28)** — 위 `parentIndex` 신설 노트엔 "LLM 프롬프트가 이 정보를 어떻게 활용할지는 미룸"이라 적혀 있었는데, 실제로 `numberSenses`(senseSelect.ts)가 평평한 번호 목록을 만들면서 이 관계를 그냥 버리고 있었다(MW sdsense가 그냥 "또 다른 뜻 하나"로 보임). `NumberedSense.parentIndex`를 추가해 원본 `DictionarySense.parentIndex`(같은 reading.senses 배열 안에서의 원본 위치)를 `numberSenses`가 새로 매긴 평면 index로 변환해 담고, `buildSenseListText`가 후보 목록에 `"4. (3번의 더 좁은 의미) ..."`처럼 표시한다 — 부모가 gloss 없는 그룹 헤더라 목록에서 빠졌으면 조용히 undefined로 생략된다.

**아직 미확인 항목** (실측 필요, 확인되는 대로 위 해당 섹션에 반영):
- ~~汉典 近反义词(lazy 섹션)를 채우는 실제 AJAX 엔드포인트~~ → **해소(2026-07-28)**: 애초에 AJAX가 필요 없었다 — `data-lazy` 속성과 무관하게 정적 HTML에 이미 내용이 채워져 있음을 재확인(위 汉典 섹션 참고). 찾을 엔드포인트 자체가 없다.
- ~~MW sense 단위 "usage note" 필드의 정확한 이름~~ → **확정(2026-07-28)**: `uns`. 위 MW 섹션 참고.
- ~~**OEWN JSON 릴리스 내부 스키마**~~ → **확인 완료(2026-07-28)**: GitHub Releases 에셋을 실제로 받아 압축 해제 후 확인 — `pronunciation[].variety`/`form`/synset 다중 `definition[]`은 기존 기록대로 실재하나, `tagcount`는 존재하지 않음(위 OEWN 섹션 참고, `DictionarySense.tagCount` 폐기 필요).
- en 불규칙 동사 활용(MW `ins` 필드)을 `irregular?: boolean` 플래그로 별도 승격할지 여부.
- ~~zh 이합사(离合词, 结婚/见面처럼 중간에 성분 삽입 가능한 특이 문법)~~ → **확인 완료(2026-07-28)**: CC-CEDICT는 태깅 없음(기존 확인). 汉典 `结婚`, 萌典 `見面` 페이지를 직접 실측한 결과 둘 다 离合词/구조(动宾式 등) 관련 태그나 필드가 전혀 없음을 확인 — 汉典·萌典·CC-CEDICT 세 소스 모두 이 문법 범주를 태깅하지 않는다. 스키마에 별도 필드 안 만드는 결정 확정, 필요시 LLM 자체 지식으로 설명.
- ~~MW의 전문분야 라벨(`lbs`) 실제 값·의미론~~ → **확정(2026-07-28)**: 전문분야 라벨이 아니라 표기 관례("often attributive" 등) 라벨. 위 MW 섹션 참고.
- ~~en.wiktionary.org REST API(definition 엔드포인트)가 일부 표제어에서 `zh` 언어 블록 자체를 안 주는 원인~~ → **원인 특정(2026-07-28 재실측)**: `水`/`一`/`打`/`大`/`小`/`人`/`火`/`山` 단일 한자 8개 wikitext를 직접 조회한 결과, **전부** 품사별 전용 헤더(`===Noun===`/`===Verb===` 등) 대신 **`====Definitions====`라는 범용 헤더**를 쓰고 있었다(예: `水` → `===Etymology 1===`/`====Pronunciation====`/`====Definitions====`, `大` → `===Pronunciation 1===`/`====Definitions====`) — 이건 단일 한자 표제어가 `{{head|zh|hanzi}}`(범용 헤드워드 템플릿)를 품사 전용 템플릿 대신 쓰는 위키 편집 관례로 보인다. 반대로 정상 작동하는 복합어 5개(`捷運`/`打算`/`你好`/`結實`/`地方`)는 전부 `===Noun===`/`===Verb===`/`===Adjective===`/`===Interjection===` 처럼 품사 이름을 헤더로 직접 쓴다 — **8/8 단일 한자가 `Definitions` 패턴, 0/5 복합어가 이 패턴**으로 상관관계가 명확하다. REST API(Parsoid 기반)가 언어 블록을 만들 때 품사 헤더 텍스트를 인식해야 하는데 `Definitions`라는 이름을 인식 못 해서 그 언어 전체를 통째로 건너뛰는 것으로 추정 — 완전한 확증(Wiktionary/Parsoid 소스 코드 직접 확인)까지는 못 했지만 강한 상관관계로 원인을 좁혔다. `打`는 조금 다르게, REST API 응답 자체가 `{"status":404,"type":"Internal error"}`(HTTP 404) — 표제어가 없는 게 아니라(wikitext 로는 정상 조회됨) Parsoid 렌더링이 이 특정 페이지에서 내부 오류를 내는 것으로 추정.

**해결책 구현 완료(2026-07-28)** — 처음엔 "wikitext에서 직접 뜻풀이를 파싱하는 건 템플릿 확장 복잡도 때문에 기각"이라고 판단했으나(위 "en/ja/zh 셋 다 raw wikitext 경로로 통일" 항목의 REST API 유지 근거 참고), 실제로 zh 단일 한자의 `====Definitions====` 안 뜻풀이 줄(`# [[word]]` 형태)을 실측해보니 en보다 훨씬 단순해서(위키링크 나열+세미콜론 구분 정도, `{{lb|...}}`/`{{senseid|...}}` 같은 라벨류 템플릿만 섞임) 좁은 범위의 fallback 파서(`tryZhDefinitionsFallback`, `extractZhDefinitionsGloss`)로 커버 가능했다. REST API가 zh 언어 블록을 아예 안 주는 두 경우(빈 블록 / 404) 모두에서 시도한다. 구현 중 실측으로 잡은 함정들:
- 하위 sense(`##`)의 예문·인용 줄(`##:`/`##*`)을 최상위(`#:`/`#*`)만 검사하는 정규식으로는 못 걸러서 긴 고문 인용이 뜻풀이인 것처럼 섞여 들어가는 버그(`/^#[:*]/` → `/^#+[:*]/`로 수정).
- `<!--{{lb|zh|Min}}-->`처럼 라벨 템플릿을 통째로 HTML 주석 처리해 감추는 위키 편집 관례 — 주석을 안 지우면 빈 `<!---->` 태그가 결과에 남음.
- `{{n-g|...}}`/`{{gl|...}}`(nongloss 설명 템플릿)는 뜻풀이 문장 자체가 인자 안에 들어있어 다른 템플릿처럼 통째로 지우면 뜻풀이가 사라짐 — 인자를 살려서 남기되, 인자 안에 파이프 있는 위키링크(`[[modify|modified]]`)가 섞여 있을 수 있어 `|`를 인자 구분자로 보고 자르면 안 됨(처음엔 이렇게 짜서 "With the [[verb]] [[modify"처럼 잘리는 버그가 있었음).

`水`(19개 뜻)/`一`(4개 발음군, 16+1+3+1개 뜻)/`打`(404 케이스, 2개 발음군)/`大`/`山`/`小`/`人`/`火` 8개 전부 실API로 재검증해 정상적인 뜻풀이 목록을 확인했다. 汉典/CC-CEDICT가 zh 폴백 체인에서 Wiktionary보다 앞순위라 실사용 영향은 제한적이지만, 이 fallback으로 Wiktionary 단독으로도 커버 가능해졌다.
