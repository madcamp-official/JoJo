# 사전 소스별 응답 형식 정리

en/ja/zh 8개 사전 소스(MW·OEWN·Wiktionary·Kotobank·JMdict·汉典·萌典·CC-CEDICT)가 실제로 어떤 형식으로 응답을 주는지, 그리고 그 원본 필드가 통일 스키마(`src/shared/types.ts`의 `DictionaryEntry`/`DictionaryReading`/`DictionarySense`)의 어느 필드로 매핑되는지 정리한다. 소스 채택 근거·폴백 순서는 [PLAN.md §5](PLAN.md#5-사전-api-구성), 남은 구현 작업은 [TODO.md](TODO.md)의 "사전" 항목 참고.

**실측 이력**: 최초 작성 시점엔 `TODO.md`/`types.ts`에 이미 있던 과거 실측 기록을 소스 기준으로 재배열만 했었다. **2026-07-28에 이 문서 작성자가 직접 재실측**(공개 API 호출 — jisho.org/en.wiktionary.org REST API/dictionaryapi.dev/moedict.tw API, `resources/cedict.u8` 원본 파일 직접 grep, 웹 검색으로 정확한 페이지 URL 확보 후 재스크래핑)해 아래 내용을 갱신했다. 이 재실측으로 **바로잡은 오류**와 **접근 불가로 확인 못 한 부분**은 각 섹션에 `[2026-07-28 재실측]` 표시와 함께 명시한다 — MW(API 키 없음)와 OEWN(JSON 릴리스가 zip 압축이라 이 세션에서 다운로드 못 함)의 세부 필드 구조는 이번에 재검증하지 못해 기존 기록을 그대로 이어받았다.

## 목차

- [영어(en)](#영어en)
  - [Merriam-Webster (MW)](#merriam-webster-mw)
  - [OEWN (Open English WordNet)](#oewn-open-english-wordnet)
- [일본어(ja)](#일본어ja)
  - [Kotobank](#kotobank)
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
- `fl`(functional label)이 품사; `"phrase"`면 관용구 표제어(예: "kick the bucket").
- `sls`(status label sequence) — 격식/사용역 라벨(예: "ain't" → `["informal"]`).
- ~~화용론적 사용법 설명 필드명이 `uns`인지 `usages`인지 API 키 없이는 확정 불가~~ → **확정(2026-07-28, `.env`의 실제 API 키로 "ain't hay" 직접 호출)**: sense 레벨 필드명은 **`uns`가 맞다** — `dt` 배열(태그된 튜플 시퀀스, `["text", ...]`/`["vis", [...]]`와 같은 자리) 안에 `["uns", [[["text", "used to say that an amount (of money) is a lot "], ["vis", [...]]]]]` 형태로 옴(예문 실측: "ain't hay" → "used to say that an amount (of money) is a lot"). `usages`(entry 최상위 usage discussion)는 별개의 상위 레벨 필드로 공존 가능 — sense 단위 자유 서술은 `uns`, 어댑터는 이걸 `usageNote`로 매핑.
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
| `uns` | `DictionarySense.usageNote` |
| `lbs`(entry 최상위, 실측: "deco" → `["often attributive"]`) | `DictionarySense.usageTags[]` (`kind: 'convention'`) — **레벨이 다름**(entry 전체 vs sense 단위)이라, 어댑터가 entry의 senses 전부에 복제해 `sls`(`kind: 'register'`)와 합쳐 넣는다(값 자체가 드물고 가벼운 표기 관례라 이 정도 단순화로 결정, 2026-07-28). 전문분야(컴퓨터/의학 등) 라벨이 아니므로 `domain`엔 매핑 안 함. |
| `ins` | `DictionarySense.irregularForms` |
| `cxs`/`uros` | (파싱 로직에서만 처리, 전용 스키마 필드 없음) |

### OEWN (Open English WordNet)

**접근**: 공식 GitHub 저장소(`globalwordnet/english-wordnet`)의 JSON 릴리스를 받아 로컬 번들. **`en-word.net/static/...` 정적 다운로드 링크는 2026-07-28 재실측 결과 503 Service Unavailable로 죽어있었으나, 같은 파일의 GitHub Releases 직접 다운로드 URL(`https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip`)은 같은 날 실측으로 HTTP 200/9.98MB 정상 다운로드 확인됨** — 그래서 다운로드 경로를 en-word.net 정적 링크가 아니라 GitHub Releases 에셋 URL로 확정한다. 별도 미러 저장소(`x-englishwordnet/json`)는 불필요 — 공식 GitHub Releases만으로 충분히 안정적이라 폴백 없이 이거 하나로 확정(이전에 검토했던 미러 폴백 방침은 폐기). 라이브 API(`en-word.net/api/...`)는 **2026-07-28에 재호출해도 여전히 503 Service Unavailable로 불안정함을 재확인** — API 대신 데이터 파일 번들 방침 유지(정적 파일 링크 자체도 en-word.net 도메인은 불안정하니, 다운로드는 항상 GitHub Releases 쪽에서). 원본 Princeton WordNet(2011년 이후 갱신 없음, 발음 정보 없음) 대신 이 커뮤니티 후속판(CC-BY 4.0) 채택.

**원본 구조 특징**(`run`/`kick the bucket`으로 실측 — **2026-07-28, GitHub Releases 에셋을 실제로 받아 압축 해제 후 파일 직접 열람으로 재검증 완료**, 이전 세션엔 못 열어봐서 기존 기록만 승계했던 상태였음):
- `pronunciation[]`에 지역별 발음이 여러 개(각각 `variety` 태그) 붙을 수 있음(실측 확인: `Bach` 항목이 `variety: "US"`/`"GB"` 2개, `Balinese`는 `"GB"` 등 — 태그 값은 "미국"/"영국" 같은 한글 라벨이 아니라 `US`/`GB`/`NZ` 같은 짧은 코드 원문 그대로) — 실제 IPA(예: run(v) → "ɹʌn").
- synset이 패러프레이즈 대안 정의를 여러 개 가질 수 있음(실측: `81484980-r` synset이 정의 3개: "quickly and without warning" / "happening unexpectedly" / "on impulse; without premeditation").
- ~~`tagcount`(SemCor 코퍼스 실사용 빈도수, sense마다 다름 — 실측: run(v) "달리다" 뜻 tagcount=106)~~ → **정정(2026-07-28, GitHub Releases `english-wordnet-2025-json.zip`을 실제로 받아 압축 해제 후 전수 검사)**: 이 필드는 이 JSON 릴리스에 **존재하지 않는다** — `grep -r "tagcount"` 결과 0건, sense 객체가 실제로 갖는 키 전체(26종: `id`/`synset`/`derivation`/`sent`/`agent`/`also`/`antonym`/`similar`/`pertainym`/`subcat` 등 프레임 의미 정보 위주)를 전수 확인해도 빈도 관련 필드가 없다. 예전 Princeton WordNet WNDB 배포판의 `index.sense`(`tag_cnt`)에 있던 개념으로 추정되나, 이 GitHub JSON 릴리스로는 가져올 수 없다 — **`DictionarySense.tagCount` 필드는 이 데이터 소스로 채울 수 없으므로 폐기하거나 다른 소스(WNDB 원본 파일을 별도로 받는 등)를 찾아야 한다.**
- entry의 `form` 필드가 불규칙 활용형을 배열로 제공(예: run(v) → `["ran", "running"]`) — MW의 반쯤 자유 텍스트 `ins`보다 구조가 깔끔함. 원시 synset 데이터 자체엔 활용형이 없지만 WNDB 배포판 포맷에 포함된 **Morphy**(형태소 처리기)가 처리 — 사용할 라이브러리가 Morphy를 감싸고 있는지 확인 필요.

**스키마 매핑**:

| OEWN 원본 필드 | 통일 스키마 필드 |
|---|---|
| synset 정의 (복수 가능) | `DictionarySense.gloss[]` |
| `pronunciation[].value` | `DictionaryReading.pronunciations[].value` (실제 IPA) |
| `pronunciation[].variety` | `DictionaryReading.pronunciations[].variety` |
| ~~`tagcount`~~ | ~~`DictionarySense.tagCount`~~ — **이 JSON 릴리스엔 필드 자체가 없어 채울 수 없음(2026-07-28 확인), 폐기 검토 대상** |
| `form` | `DictionarySense.irregularForms` |

---

## 일본어(ja)

### Kotobank

**접근**: 스크래핑(공식 API 없음). `kotobank.jp/word/{표제어}-{ID}` 형식이라 정확한 URL은 검색을 거쳐야 찾을 수 있음(ID를 짐작해서 URL을 만들면 엉뚱한 페이지가 뜸 — 2026-07-28 재실측 중 실제로 겪은 문제. `花-460388`처럼 잘못 짐작한 ID는 "学振" 같은 전혀 다른 표제어로 연결됐고, 정확한 URL(`花-115580`)은 웹 검색으로 찾아야 했음).

**원본 구조 특징** `[2026-07-28, 花 페이지 재실측]`:
- 한 표제어 페이지에 여러 사전 소스가 `<article>`로 나란히 붙는 구조는 재확인됨. "花" 페이지에서 실제로 확인된 소스는 **daijisen(デジタル大辞泉)/nikkokuseisen(精選版日本国語大辞典)/sekaidaihyakka(改訂新版世界大百科事典)/nipponica(日本大百科全書)/jitsu(普及版字通)/britannica(ブリタニカ国際大百科事典)/mypedia(百科事典マイペディア)/daijisenplus(デジタル大辞泉プラス)/animalsandplants(動植物名よみかた辞典)** 9개 — "138개 사전 통합"은 Kotobank 전체가 보유한 사전 총수이고, 표제어 하나에 실제로 붙는 소스 수는 이보다 훨씬 적다(9개, 표제어 성격에 따라 가변적일 것으로 추정).
- 국어사전/백과사전/한자어원사전/고유명사·전문용어사전 등 여러 종류가 섞여 있어, 품사 태그 유무만으로는 국어사전식만 못 거른다 — **국어사전식만 쓰려면 slug 화이트리스트**(`daijisen`, `nikkokuseisen`)로 거르는 게 텍스트 파싱보다 안정적이라는 기존 판단 유지.
- **デジタル大辞泉**: 뜻풀이 번호매김(`<b>１</b>` 등)·유의어(類語) 섹션·같은 article 안 한자 표제어(`か【花】`, 漢字項目) 3가지는 재확인됨.
- **精選版日本国語大辞典**: `[ 一 ]`→`①②③`→`(イ)(ロ)` 다단 번호매김은 재확인됨. **단, "精選版엔 類語 섹션이 없다"는 기존 기록은 이번 재실측으로 틀린 것으로 확인됨** `[정정, 2026-07-28]` — 花 페이지에서는 daijisen뿐 아니라 nikkokuseisen에도 類語 섹션이 나타났다. 표제어에 따라 있고 없고가 갈릴 가능성이 있어(花는 있음, 원래 기록의 근거였던 단어는 달랐을 수 있음) 완전히 없다고 단정하지 말고 **"사전마다가 아니라 표제어마다 있을 수도 없을 수도 있다"로 정정**.
- 품사 마커(`<span class="hinshi">`)의 불일치 사례(동사/형용사 태그 결합 방식 차이, 명사 무표시, とても가 `連語`로 나오는 것)는 기존 기록 유지(이번 재실측 대상은 아님) — 여전히 **품사 판정은 JMdict 1순위** 방침 유지.
- 활용형 자동 원형 변환이 안 되는 점(형태소 분석 전처리 필요)은 기존 기록 유지.
- `慣用句`(4자성어 이외의 일반 관용구) 태그 유무 확인 — 실제 관용구 페이지("猫の手も借りたい")를 스크래핑해보니 그런 카테고리 라벨 자체가 페이지에 없음(4자성어 전용 `四字熟語` 라벨과 달리, 일반 관용구는 평문 정의만 있고 별도 태그가 없음). `isIdiom` 판정은 이 소스에 기대지 않고 JMdict(`exp`/"Yojijukugo")·MW(`fl:"phrase"`) 위주로 확정.

**스키마 매핑**: (daijisen 기준) 番号 뜻풀이 → `gloss[]`, 類語 → `synonyms`. (精選版 기준) `〘 品詞 〙` → `posRaw`/`pos`, `[初出の実例]` → `examples[]`, (있는 경우) 類語 → `synonyms`.

### JMdict

**접근**: 로컬 데이터셋 번들(jmdict-simplified 등) 예정, 라이브 조회는 jisho.org API로 대체 검증. **2026-07-28, 아래 항목 전부 jisho.org API를 실제로 호출해 재확인함** — 기존 기록과 전부 일치, 정정 사항 없음.

**원본 구조 특징**(jisho.org API 실측 기준, 원본은 jmdict-simplified 스키마):
- 활용형을 원형으로 자동 변환해주지 않음(Kotobank와 동일) — 형태소 분석 전처리 필요.
- 품사 판정이 Kotobank보다 훨씬 안정적 — `parts_of_speech` 배열에 일관되게 나옴(명사도 명시적으로 "Noun") → **품사 판정 1순위 소스로 확정**.
- **sense 배열을 인덱스로 매칭해 Kotobank gloss + JMdict pos를 섞으면 안 됨** — 두 소스가 sense를 나누는 기준 자체가 다름.
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
- `CL:`(양사) 재확인 — 단일 분류사(`CL:件[jian4]`)와 복수 분류사(`CL:個|个[ge4],位[wei4]`, `CL:份[fen4],頓|顿[dun4]`, `CL:件[jian4],樁|桩[zhuang1],回[hui2]` 등) 둘 다 실제 존재 확인. 콤마로 분리해 세그먼트 그대로 `DictionarySense.classifiers[]` 각 원소에 넣는 방침 유지.
- 병음 첫 글자 대문자(재실측: 정확히 20,266/124,732줄 = 16.2%, 예: `丁`→"surname Ding", `三`→"surname San")로 고유명사(성씨/지명) 구분 신호가 있음 — **결정(2026-07-28): 전용 `isProperNoun` 필드는 추가하지 않는다.** `surname X`/`place name` gloss 텍스트만으로 충분한 수준으로 남겨두고 신호 존재만 기록.
- `(bird species of China)` 태그 1,443회(재확인, 일치) — 조류 라틴학명 엔트리가 대량 포함돼 일반 단어 조회 결과에 노이즈가 될 수 있음(어댑터 필터링 검토 대상).

**스키마 매핑**: 슬래시 세그먼트를 분류 후 `gloss[]`/`usageTags`/`domain`/`seeAlso`/`classifiers`/`pronunciations[].variety`/`isIdiom`(`(idiom)` 라벨 전용)로 라우팅. `pos` 필드 자체가 없어 항상 undefined.

### 汉典 (zh-Hans)

**접근**: 스크래핑, `/hans/` 경로(간체 네이티브). **주의: 이 문서 작성 중 자체 WebFetch 도구로는 실제 존재하는 페이지 URL(검색으로 확보)도 전부 HTTP 404를 반환했다** — 반면 `curl -L`(리다이렉트 추적)+일반 브라우저 User-Agent 조합으로는 200 정상 응답(정적 SSR HTML)이 왔다. 즉 완전히 차단된 게 아니라 **무조건 리다이렉트를 한 번 거치고(301), UA를 검사하는 정도** — 실제 스크래퍼는 리다이렉트 추적 + 정상 UA만 갖추면 된다(헤드리스 브라우저까지는 불필요, 아래 내용 전부 정적 HTML만으로 확인됨).

**원본 구조 특징** `[2026-07-28, curl로 打(한자)/打算(단어)/一石二鸟(성어) 3개 페이지 직접 재실측]`:
- 단어(词语) 페이지(`打算`)와 한자(单字) 페이지(`打`)가 **템플릿이 다르다**: 공통으로 `gy-reading__py`(병음)+`gy-reading__zy`(주음부호)로 발음을, `gy-sense-list` 안 `gy-sense__num`(번호)+`gy-sense__def`(뜻풀이)로 뜻을 나열하는 것까지는 같지만, 인용 방식이 다름 — `打算`(단어)은 뜻풀이마다 **저자·출전이 붙은 고전 인용문**이 실측 확인됨(예: "究竟上天不生无禄的人，等慢慢再打算就是了。 ——《官话指南·卷一·应对须知》"), 반면 `打`(단일 한자)는 인용문 없이 **"如：「打铁趁热」" 식의 짧은 용례구**만 붙음. 예문 출전 메타데이터(저자/출전)는 지금 스키마의 `examples?: string[]`(평문)로는 못 담고 통째로 버려지는 문제가 아래 항목에 정리돼 있음 — Kotobank 精選版日本国語大辞典의 `[初出の実例]`와 동일 축의 문제.
- `打`(한자) 페이지는 **다음(多音, 이 경우 dǎ/dá) 2개 발음** 아래 각각 다른 뜻풀이 세트(`gy-sense-list`)가 있고, 첫 발음(dǎ) 밑에만 23개 뜻풀이가 있는 것을 확인 — `DictionaryReading[]` 배열 구조에 자연스럽게 대응(CC-CEDICT의 異音字 구조와 동일 패턴).
- **품사(词性) 필드 자체가 없음** — `打算`/`打` 페이지 둘 다 명시적 품사 마커를 못 찾음(`pos` 는 이 소스는 항상 undefined로 취급).
- ~~近反义词(유의어/반의어) 섹션은 실제로 있지만 `data-lazy` 속성이 붙어 있어 정적 HTML엔 내용이 비어있고 JS/AJAX로 뒤늦게 채워짐~~ → **정정(2026-07-28, curl로 打算/一石二鸟/结婚 3개 페이지 재확인)**: `id="syn" data-section="近反义词"` 섹션에 `data-lazy` 속성은 여전히 붙어있지만, **정적 HTML 자체에 내용이 이미 채워져 있다** — `打算`은 근의어 7개(盘算/打定/计划/计算/企图/准备/预备), `一石二鸟`는 근의어 2개(一箭双雕/一举两得), `结婚`은 근의어 6개+반의어 3개가 `<a class="synonym-tag">` 링크로 정적 HTML에 그대로 존재함을 확인. `data-lazy`는 AJAX로 내용을 채우는 게 아니라 다른 용도(예: 지연 렌더링 애니메이션 등 프런트엔드 훅)로 보인다 — **AJAX 엔드포인트를 찾거나 헤드리스 브라우저를 쓸 필요가 없다**, curl 스크래핑만으로 근반의어를 그대로 파싱할 수 있다. 단, 단일 한자 페이지(`打`)는 이 섹션 자체가 아예 없음(비어있는 게 아니라 미제공) — 표제어가 단어/성어일 때만 근반의어 데이터가 있는 것으로 보임.
- 성어(idiom, `一石二鸟`) 페이지는 위 근반의어 섹션과 별개로, 뜻풀이 블록 안에 "国语辞典"(대만 교육부 사전 — 萌典과 같은 데이터 계열) 서브섹션을 정적으로 통째로 끼워 넣고, 그 안에도 자체 유의어 목록(`近义词: 一箭双雕, 一举两得`, CSS class `xxjs-block-label--syn`)과 영어 번역(`英语: to kill two birds with one stone (idiom)`)이 중복 포함돼 있음 — 이 부분은 기존 기록대로 유지(정정 대상 아님).
- `CL:`(양사) 마커나 CC-CEDICT식 명시적 태그는 이 세 페이지에선 안 보임(단어 자체에 양사가 필요 없는 예시들이라 존재 여부 자체가 미확정 — 명사류 단어로 재확인 필요).
- **예문(書證) 출처 메타데이터(저자·시대·출전) — 스키마에 안 넣기로 보류.** 汉典은 인용마다 "身世浮沉雨打萍。—— 宋·文天祥《过零丁洋》"처럼 저자/시대/출전이 붙어 오는데(위 `打算` 고전 인용 예시 참고), `DictionarySense.examples?: string[]`는 평문만 담아 이 메타데이터가 통째로 버려진다. 精選版日本国語大辞典(Kotobank)의 `[初出の実例]`에도 최초 용례+출전+연대가 붙는 동일 패턴이 확인돼 있어 zh 전용 문제가 아니라 "인용문 출처"라는 공통 축인데, 필드를 추가하면 `examples`를 `string[]`에서 `{ text, source? }[]` 같은 구조로 바꿔야 해서 이미 반영된 다른 어댑터 코드에도 영향이 간다 — 스코프 결정을 미루고 기록만 해둔다. 나중에 하려면 en/ja/zh 소스 전체에서 "평문 예문"과 "출전 붙은 고전 인용"을 같은 필드에 넣을지 분리할지부터 정해야 한다.
- 상용 词组(표제어를 포함하는 복합어 목록, 실측: `打` 한 글자에 打靶/打包/打赌 등 약 200개) — 대응 필드 자체가 스키마에 없음(synonyms/antonyms와는 다른 축). 미반영.
- 다국어 翻译 섹션(词语/성어 페이지 하단, 실측: `打算` → 영어 "to plan, to intend, ..., CL:個|个[ge4]" + 독일어 "planen, beabsichtigen (V)" + 프랑스어 병기) — `gloss`는 원어 뜻풀이 전용 필드라 이 다국어 번역 블록이 들어갈 자리가 없음. 미반영.
- 간체 페이지(`/hans/`)에서도 표제어 옆에 번체 대응형을 병기(실측: "一石二鸟（一石二鳥）") — 스키마 결정 당시엔 `DictionaryEntry.headword`가 단일 문자열이라 이 매핑이 사라지는 문제였으나, 이후(2026-07-28) JMdict 이표기 대응으로 `headword: string[]`로 바뀌면서 담을 자리 자체는 생겼다. 다만 이건 "같은 뜻의 이표기"(JMdict 케이스)가 아니라 "같은 뜻의 다른 스크립트(간체/번체) 표기"라 성격이 달라 그대로 재사용해도 되는지는 재검토 필요 — 아직 미반영.
- 부수/획수/필순/오필/창힐/자형변천/강희자전/설문해자/음운방언(IPA·唐代음·방언 등)은 학습자용 팝업사전 기능과 무관하다고 판단해 스키마에 안 담기로 결정(아래 萌典의 `radical`/`stroke_count` 미반영 결정과 동일 근거) — 재검토 대상 아님.
- "同音词"(동음이의 단어) 섹션은 정적 HTML엔 없고 클라이언트 JS가 별도 API로 채움(실측: "加载中…" 플레이스홀더만 SSR됨) — 스키마 문제가 아니라 어댑터 구현 시 함정: curl 등 단순 스크래핑으론 못 잡고 헤드리스 브라우저나 별도 API 호출이 필요.

**스키마 매핑**: `gy-sense__def`(고전 인용 있는 경우 분리 필요) → `gloss[]`(+ 인용 메타데이터는 스코프 보류), `gy-reading__py` → `pronunciations[].value`, `#syn` 섹션의 `synonym-tag`(근의어)/`synonym-label--ant` 그룹(반의어) → `synonyms`/`antonyms`(단어/성어 표제어에서만, 한자 단독 표제어는 이 섹션이 없어 항상 undefined), 성어 페이지 "国语辞典" 서브섹션의 근의어/영어 번역도 동일하게 `synonyms`로 흡수(번역은 스키마 밖, LLM 한국어 설명 단계에서 참고 가능). `pos`는 항상 undefined.

### 萌典 (zh-Hant)

**접근**: `moedict.tw` — 스크래핑이 아니라 **공개 JSON API**(`https://www.moedict.tw/uni/{글자}` 또는 `/a/{글자}.json`)로 확인됨, 대만 교육부 편찬(번체 네이티브, 대만식 표준 어휘는 汉典보다 강함 — 실측: 捷運 등 대만 인프라 용어).

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

---

## 공통 스키마 결정 사항

여러 소스에 걸쳐 있는 스키마 설계 판단(전체 근거는 `src/shared/types.ts` 해당 필드 주석 참고):

- `DictionaryEntry.source`는 스키마엔 유지하되 LLM 프롬프트엔 넣지 않음 — 폴백 체인 디버깅·UI 출처 표기(예: "출처: JMdict")용으로만 사용.
- `isCommon`(entry 선택용 필드)은 최종적으로 없앰 — 동일 표기의 서로 다른 reading(예: はし/きょう)은 **하나의 entry로 병합**되는 게 맞는 설계(MW hom, 萌典 heteronyms와 동일 패턴)라 우선순위 신호의 역할은 "entry 선택"이 아니라 "그 entry 안 어느 reading/sense가 대표인지"로 축소 — `DictionaryReading.isCommon`(JMdict 전용, reading 레벨)으로 분리해 실제 데이터가 있는 레벨에 맞춰 부활시킴. (당초 함께 부활시켰던 `DictionarySense.tagCount`(OEWN 전용, sense 레벨)는 **2026-07-28 실제 데이터 확인 결과 이 JSON 릴리스에 해당 필드가 없어 폐기 대상** — 아래 OEWN 섹션 참고.)
- `pos`(CanonicalPos)는 언어 간 겹치는 범위로만 표준화하고, 원본 세부 표기는 `posRaw`(LLM에 전달 안 함)에 보존. 문법 설명에 실제로 필요한 세부 정보(활용 분류 등)는 `posRaw`에만 있으면 버려지는 것과 같으므로 `conjugationClass`(사람이 읽을 수 있는 문자열, LLM에도 전달)로 별도 승격.
- 판별 유니온(discriminated union) 대신 공통 베이스+옵셔널 확장 필드 방식을 의도적으로 채택 — 언어 전용 필드가 2~3개 규모에서는 유니온이 과한 복잡도로 판단(실행 시점엔 JSON 직렬화로 undefined 키 자동 생략되어 안전, 다만 타입 수준에서 "이 필드는 이 언어 전용"을 컴파일러가 강제하지는 않음).
- `usageTags`를 `string[]`에서 `UsageTag[]`(`{ text, kind?: 'register'|'convention'|'dialect'|'other' }`)로 구조화(2026-07-28) — 격식(MW `sls`, CC-CEDICT `(coll.)`/`(slang)` 등)과 격식 무관 표기 관례(MW `lbs`, JMdict "가나로만 씀")가 문자열 하나에 섞여 있으면, PLAN §3 "격식·객관 표현 여부" 자주 쓰는 질문 기능이 격식 판단에 무관한 태그까지 LLM에 같이 넣어 판단을 오염시킬 수 있음을 뒤늦게 발견해 정정. 소스별 라벨의 `kind` 분류는 위 MW/JMdict/CC-CEDICT 각 섹션 참고 — 분류가 애매한 라벨(CC-CEDICT `(loanword)`/`(bound form)`)은 `other`로 남겨 억지로 분류하지 않는다.
- 같은 이유로 `seeAlso`도 `string[]`에서 `SeeAlsoRef[]`(`{ text, kind?: 'variant'|'dialectVariant'|'abbreviation'|'usedIn'|'related' }`)로 구조화(2026-07-28) — CC-CEDICT 교차참조가 `variant of`(표기 변이)/`abbr. for`(줄임말↔원말)/`used in`(복합어 구성 성분)/`see also`(느슨한 관련어)로 관계 성격이 다 다른데 문자열 하나에 뭉쳐 있었음. **`usageTags`와 합치는 방안은 검토 후 기각** — `usageTags`는 이 뜻 자체의 성질을 나타내는 라벨이고 `seeAlso`는 다른 표제어를 가리키는 포인터라 성격이 근본적으로 달라서(나중에 "클릭해서 재조회" 같은 기능이 붙을 수 있는 것도 포인터 쪽), 합치면 `kind` 종류만 7개로 늘어나 오히려 지금 고치려던 문제를 재현하게 됨. `classifiers`(CC-CEDICT 양사)는 같은 검토를 거쳤으나 **배열 원소가 전부 "양사"라는 동일 개념이라 이 문제에 해당하지 않음** — 다만 원본 표기(`個|个[ge4]` 같은 파이프·대괄호)가 그대로 문자열에 남는 별개 문제가 있어 구조화(`{ hanzi, pinyin? }`) 여부는 논의만 하고 보류.

**아직 미확인 항목** (실측 필요, 확인되는 대로 위 해당 섹션에 반영):
- ~~汉典 近反义词(lazy 섹션)를 채우는 실제 AJAX 엔드포인트~~ → **해소(2026-07-28)**: 애초에 AJAX가 필요 없었다 — `data-lazy` 속성과 무관하게 정적 HTML에 이미 내용이 채워져 있음을 재확인(위 汉典 섹션 참고). 찾을 엔드포인트 자체가 없다.
- ~~MW sense 단위 "usage note" 필드의 정확한 이름~~ → **확정(2026-07-28)**: `uns`. 위 MW 섹션 참고.
- ~~**OEWN JSON 릴리스 내부 스키마**~~ → **확인 완료(2026-07-28)**: GitHub Releases 에셋을 실제로 받아 압축 해제 후 확인 — `pronunciation[].variety`/`form`/synset 다중 `definition[]`은 기존 기록대로 실재하나, `tagcount`는 존재하지 않음(위 OEWN 섹션 참고, `DictionarySense.tagCount` 폐기 필요).
- en 불규칙 동사 활용(MW `ins` 필드)을 `irregular?: boolean` 플래그로 별도 승격할지 여부.
- ~~zh 이합사(离合词, 结婚/见面처럼 중간에 성분 삽입 가능한 특이 문법)~~ → **확인 완료(2026-07-28)**: CC-CEDICT는 태깅 없음(기존 확인). 汉典 `结婚`, 萌典 `見面` 페이지를 직접 실측한 결과 둘 다 离合词/구조(动宾式 등) 관련 태그나 필드가 전혀 없음을 확인 — 汉典·萌典·CC-CEDICT 세 소스 모두 이 문법 범주를 태깅하지 않는다. 스키마에 별도 필드 안 만드는 결정 확정, 필요시 LLM 자체 지식으로 설명.
- ~~MW의 전문분야 라벨(`lbs`) 실제 값·의미론~~ → **확정(2026-07-28)**: 전문분야 라벨이 아니라 표기 관례("often attributive" 등) 라벨. 위 MW 섹션 참고.
