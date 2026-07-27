# 사전 소스별 응답 형식 정리

en/ja/zh 8개 사전 소스(MW·OEWN·Wiktionary·Kotobank·JMdict·汉典·萌典·CC-CEDICT)가 실제로 어떤 형식으로 응답을 주는지, 그리고 그 원본 필드가 통일 스키마(`src/shared/types.ts`의 `DictionaryEntry`/`DictionaryReading`/`DictionarySense`)의 어느 필드로 매핑되는지 정리한다. 소스 채택 근거·폴백 순서는 [PLAN.md §5](PLAN.md#5-사전-api-구성), 남은 구현 작업은 [TODO.md](TODO.md)의 "사전" 항목 참고 — 이 문서는 그중 **"실측으로 확인된 응답 형식"만 소스별로 뽑아 한곳에 모은 것**이다(TODO.md의 실측 노트·`types.ts`의 필드별 주석과 내용은 같고, 여기서는 소스를 기준 축으로 재배열했다).

날짜가 없는 항목은 확인 시점 불명(초기 조사분), `(YYYY-MM-DD)`가 붙은 항목은 그 날짜에 실제 API 호출/스크래핑/원본 파일로 확인한 것이다.

## 목차

- [영어(en)](#영어en)
  - [Merriam-Webster (MW)](#merriam-webster-mw)
  - [OEWN (Open English WordNet)](#oewn-open-english-wordnet)
  - [Wiktionary (en)](#wiktionary-en)
- [일본어(ja)](#일본어ja)
  - [Kotobank](#kotobank)
  - [JMdict](#jmdict)
  - [Wiktionary (ja 항목)](#wiktionary-ja-항목)
- [중국어(zh)](#중국어zh)
  - [CC-CEDICT](#cc-cedict)
  - [汉典 (zh-Hans)](#汉典-zh-hans)
  - [萌典 (zh-Hant)](#萌典-zh-hant)
  - [Wiktionary (zh 항목)](#wiktionary-zh-항목)
- [공통 스키마 결정 사항](#공통-스키마-결정-사항)

---

## 영어(en)

### Merriam-Webster (MW)

**접근**: Collegiate Dictionary API(키 등록, 무료 개인용 티어). REST GET, JSON 응답.

**원본 구조 특징**:
- 표제어 하나에 여러 entry(품사별)가 올 수 있고, entry 안에 `sseq`(sense sequence, 중첩 배열) → `dt`(defining text) → `text`/`vis`(예문) 구조로 깊게 중첩됨.
- `prs.mw` 필드가 발음이지만 **IPA가 아니다** — 매크론(ā/ē/ī/ō/ū 등)을 쓰는 MW 자체 표기법. IPA 필드 자체가 응답에 없고, variety(지역) 구분도 없음(단일 값).
- `fl`(functional label)이 품사; `"phrase"`면 관용구 표제어(예: "kick the bucket").
- `sls`(status label sequence) — 격식/사용역 라벨(예: "ain't" → `["informal"]`).
- `uns`(usage note) — 화용론적 사용법 설명(예: "ain't hay" → "많은 금액을 강조할 때 쓴다"는 설명). gloss/example 어디에도 안 들어가는 자유 서술.
- `ins`(inflections) — 불규칙 활용형(예: run → "ran"). 반쯤 자유 텍스트.
- `uros`(Undefined Run-Ons, 파생어 목록) — 조회한 표면형이 파생 접사가 붙은 형태(예: "photosynthesizing")면 **최상위 응답이 항상 원 표제어(예: "photosynthesis")로 돌아온다**(실측 확인). 질의어를 원형으로 미리 바꿔("photosynthesize") 검색해도 동일하게 원 표제어로 돌아옴 — 질의 단계 원형화로는 안 풀림. `uros[]`의 `ure`(파생어 표기, 중점 제거 후 비교)가 조회 표면형과 일치하는 항목을 찾아 그 `fl`/발음으로 보정해야 하고, 뜻풀이는 `uros`에 없으므로 원 표제어의 `def`를 그대로 쓴다.
- `cxs`(cross-reference) — 변형 철자를 가리키는 포인터 전용 엔트리. 실측: "colour" 조회 시 `def`/`shortdef`가 전부 비어있고 `cxs: [{ "cxl": "chiefly British spelling of", "cxtis": [{ "cxt": "color" }] }]`만 옴. `DictionarySense.gloss`가 필수 필드라 안 거르면 어댑터가 막힌다 — 처리안은 (1) `cxl`+`cxt` 합성해 gloss로 대체(추가 호출 없음) 또는 (2) `cxt`로 재조회해 실제 정의 병합(호출 1회 추가, 더 정확) 둘 중 택1, 스키마 필드 추가는 불필요.
- 전문분야 라벨(`lbs` 계열) 존재 여부는 아직 미확인 — en 어댑터 구현 시 재검토.

**스키마 매핑**:

| MW 원본 필드 | 통일 스키마 필드 |
|---|---|
| `sseq[].dt[].text` | `DictionarySense.gloss[]` |
| `sseq[].dt[].vis` | `DictionarySense.examples[]` |
| `fl` (`"phrase"`) | `DictionaryEntry.isIdiom` |
| `prs.mw` | `DictionaryReading.pronunciations[].value` (variety 없음) |
| `sls` | `DictionarySense.usageTags` |
| `uns` | `DictionarySense.usageNote` |
| `ins` | `DictionarySense.irregularForms` |
| `cxs`/`uros` | (파싱 로직에서만 처리, 전용 스키마 필드 없음) |

### OEWN (Open English WordNet)

**접근**: 공식 GitHub JSON 릴리스(`x-englishwordnet/json`, `oewn-2026.json.zip`)를 직접 받아 로컬 번들(라이브 API `en-word.net`은 실측 결과 불안정(503)이라 제외). 원본 Princeton WordNet(2011년 이후 갱신 없음, 발음 정보 없음) 대신 이 커뮤니티 후속판(CC-BY 4.0) 채택.

**원본 구조 특징**(`run`/`kick the bucket`으로 실측):
- `pronunciation[]`에 지역별 발음이 여러 개(각각 `variety` 태그) 붙을 수 있음 — 실제 IPA(예: run(v) → "ɹʌn").
- synset이 패러프레이즈 대안 정의를 여러 개 가질 수 있음(실측: `81484980-r` synset이 정의 3개: "quickly and without warning" / "happening unexpectedly" / "on impulse; without premeditation").
- `tagcount`(SemCor 코퍼스 실사용 빈도수, sense마다 다름 — 실측: run(v) "달리다" 뜻 tagcount=106, 뒤쪽 rare sense는 이 필드 자체가 없음).
- entry의 `form` 필드가 불규칙 활용형을 배열로 제공(예: run(v) → `["ran", "running"]`) — MW의 반쯤 자유 텍스트 `ins`보다 구조가 깔끔함. 원시 synset 데이터 자체엔 활용형이 없지만 WNDB 배포판 포맷에 포함된 **Morphy**(형태소 처리기)가 처리 — 사용할 라이브러리가 Morphy를 감싸고 있는지 확인 필요.

**스키마 매핑**:

| OEWN 원본 필드 | 통일 스키마 필드 |
|---|---|
| synset 정의 (복수 가능) | `DictionarySense.gloss[]` |
| `pronunciation[].value` | `DictionaryReading.pronunciations[].value` (실제 IPA) |
| `pronunciation[].variety` | `DictionaryReading.pronunciations[].variety` |
| `tagcount` | `DictionarySense.tagCount` (LLM 프롬프트엔 안 넣음, sense 정렬용) |
| `form` | `DictionarySense.irregularForms` |

### Wiktionary (en)

**접근**: en.wiktionary.org 또는 kaikki.org 추출 데이터. en/ja/zh 공용 최종 폴백.

**특징**: 활용형(ran/went/ate 등)을 원형과 교차 연결해둬서 그대로 조회해도 정상 동작(실측 확인) — ja/zh와 달리 형태소 분석 전처리가 필요 없음. dictionaryapi.dev 경유 실측: 유의어(synonyms)가 sense(definition) 단위가 아니라 그 상위 meaning(품사 그룹) 단위로 붙어있어(예: "ate" → consume/swallow/dine 등), 어댑터가 같은 meaning 안의 모든 sense에 복제해 채워야 함. `phonetic` 필드가 실제 IPA(예: "/beɪs/"). "kick the bucket" 같은 관용구도 `partOfSpeech: "verb"`로만 나와 **관용구 여부 표시 자체가 없음**(`isIdiom` 은 이 소스는 항상 undefined).

---

## 일본어(ja)

### Kotobank

**접근**: 스크래핑(공식 API 없음). 小学館 デジタル大辞泉 등 **138개 출판 사전을 한 페이지에 통합 표시**하는 것이 이 소스의 근본 특징(2026-07-28, 地震/花 스크래핑 실측).

**원본 구조 특징**:
- 각 사전 항목은 `<article class="dictype cf {slug}">`로 감싸여 있고, slug가 사전별 고유 식별자(`/dictionary/{slug}/` URL도 고정). 국어사전/백과사전/한자어원사전/고유명사·전문용어사전 등 최소 4종류가 섞여 있어, 품사 태그 유무만으로는 국어사전식만 못 거른다(デジタル大辞泉조차 무표시 명사는 태그 자체가 없음) — **국어사전식만 쓰려면 slug 화이트리스트**(`daijisen`=デジタル大辞泉, `nikkokuseisen`=精選版日本国語大辞典)로 거르는 게 텍스트 파싱보다 안정적.
- 화이트리스트로 고른 두 사전끼리도 형식이 상당히 다름 — **파서를 하나로 통일할 수 없고 사전별로 따로 짜야 함**:
  - **デジタル大辞泉**: 품사를 별도 브래킷 태그로 거의 안 보여줌(무표시 명사는 표시 자체 없음). 뜻풀이는 `<b>１</b>``<b>２</b>`(전각 숫자) 얕은 단일 계층 번호매김이 기본(드물게 하위 구분 ㋐㋑㋒). 각 뜻풀이 끝에 **類語**(유의어) 섹션이 붙어 `synonyms`로 바로 매핑 가능. 예문은 현대어 짧은 용례구만, 출전·연대 없음. 같은 daijisen article 안에 한자 표제어가 별도 `<h3>`(「か【花】［漢字項目］」식)로 딸려오는데 이건 낱말 뜻풀이가 아니라 한자 자체의 음훈·학습 학년·부수 숙어 나열이라 별도 처리 또는 스킵 필요.
  - **精選版日本国語大辞典**: 품사를 `〘 名詞 〙`처럼 굵은 이중갈고리 괄호로 **일관되게** 표시(오히려 품사 추출은 더 안정적). `[ 一 ]`(대분류)→`①②③`(중분류)→`(イ)(ロ)`(소분류)까지 최대 3단계로 깊게 중첩되는 번호매김이라 파싱이 훨씬 복잡(실측: "花"는 5개 대분류 아래 30개 이상 세부 뜻풀이). 뜻풀이마다 `[初出の実例]`(최초 용례, 실제 옛 문헌 인용구+출전+연대)가 붙는 문헌학적 사전이라 항목 하나가 daijisen보다 훨씬 길고 정보 밀도가 높음(LLM 프롬프트 토큰 예산 고려 필요). 語誌(어원/역사) 섹션이 `<h4>`로 따로 붙는 경우 있음. 類語 섹션은 없음.
- 품사 마커(`<span class="hinshi">`)가 있긴 하지만(실측 — 食べる `［動バ下一］`, 明るい `［形］［ク］`, 静か `［形動］［ナリ］`) (a) 동사는 품사+활용형이 한 태그에 결합, 형용사는 두 태그로 분리되는 등 결합 방식이 다르고 (b) 순수 명사(花)는 태그 자체가 안 나오고 (c) とても가 예상된 `副` 대신 `連語`로 나오는 등 매핑 예외가 실측만으로 이미 발견됨 → **품사 판정은 JMdict을 1순위로 두고 Kotobank는 보조**.
- `慣用句`(4자 이외 일반 관용구) 태그 유무 확인 결과: 실제 관용구 페이지("猫の手も借りたい")엔 그런 카테고리 라벨 자체가 없음(4자성어 전용 `四字熟語` 라벨과 달리 일반 관용구는 평문 정의만). `isIdiom` 판정은 JMdict(`exp`/"Yojijukugo")·MW(`fl:"phrase"`) 위주로 확정.
- 활용형(食べた/美しかった 등)을 원형(食べる/美しい)으로 자동 변환해주지 않음(실측 확인, 검색 결과 없음) — 사전 API 호출 전에 형태소 분석 엔진(`main/nlp/japanese.ts`, `JA_ENGINE` 설정값)으로 基本形 치환 전처리가 반드시 필요.

**스키마 매핑**: (daijisen 기준) 番号 뜻풀이 → `gloss[]`, 類語 → `synonyms`. (精選版 기준) `〘 品詞 〙` → `posRaw`/`pos`, `[初出の実例]` → `examples[]`(용례+출전 텍스트를 그대로 넣을지 분리할지는 어댑터 구현 시 결정).

### JMdict

**접근**: 로컬 데이터셋 번들(jmdict-simplified 등), 라이브 조회 실측은 jisho.org API로 대체 확인.

**원본 구조 특징**(jisho.org API 실측 기준, 원본은 jmdict-simplified 스키마):
- 활용형을 원형으로 자동 변환해주지 않음(Kotobank와 동일) — 형태소 분석 전처리 필요.
- 품사 판정이 Kotobank보다 훨씬 안정적 — 실측 5개 예시(食べる/明るい/静か/花/とても) 전부 `parts_of_speech` 배열에 일관되게 나옴(명사도 명시적으로 "Noun") → **품사 판정 1순위 소스로 확정**.
- **sense 배열을 인덱스로 매칭해 Kotobank gloss + JMdict pos를 섞으면 안 됨** — 두 소스가 sense를 나누는 기준 자체가 다름(예: 静か를 Kotobank는 명사 용법 sense까지 포함해 나누는데 JMdict은 3개 Na-adjective sense로만 균일하게 나눔). Kotobank 파싱 실패 시엔 "이 표제어의 JMdict 전체에서 가장 흔한 pos"를 엔트리 단위 근사치로만 참고.
- 한 sense 안에 품사가 2개 동시에 붙는 경우 있음(실측: 元気/自由 → `["Na-adjective (keiyodoshi)", "Noun"]` 동시 태깅) — `pos`는 단일값이라 더 대표적인 쪽 하나만, 원본 조합은 `posRaw`에 보존.
- `partOfSpeech`에 "Auxiliary adjective"/"Auxiliary verb"/"Suffix" 등이 섞여 있으면(실측: "らしい") `conjugationClass`를 "조동사(い형용사 활용)"처럼 기능까지 설명하는 문자열로 채워야 함 — `posRaw`는 LLM에 전달 안 되므로 gloss만으론("seeming ...") 독립적으로 못 쓰이고 다른 말에 붙는 기능어라는 사실이 안 드러남.
- `is_common`이 sense 배열 안이 아니라 각 entry(reading 그룹) 최상위에만 있고 그 밑 sense들은 전부 같은 값을 공유(실측: jisho.org "上手") — 원본 XML이 우선도 태그(`ke_pri`/`re_pri`)를 한자/읽기 요소에만 붙이고 sense 요소엔 안 붙이는 구조이기 때문.
- `synonyms` 키 자체가 응답에 없음(실측 재확인, "高い"). 대신 `see_also`(jisho.org 실측: "一人"의 "being alone" 뜻 → `見よ: 一人で`) — 동의어 보장이 없는 "관련어 참조"라 `synonyms`가 아니라 `seeAlso`로 분리.
- `antonyms` 필드는 있음(실측: "高い"→"低い").
- jmdict-simplified 원본 스키마 기준: `field: Tag[]`(전문분야/도메인, 컴퓨터·의학·법률 등)과 `misc: Tag[]`(사용역/속어 등)가 원래 별도 배열인데, jisho.org 라이브 API는 이 둘을 `tags` 필드 하나로 뭉개서 노출(실측: "レジスター"의 "register" 뜻 → `tags: ["Computing"]`, 형식상 misc 예시들과 같은 자리). 로컬 데이터셋을 직접 번들하는 어댑터는 이 구분을 살려 `domain`/`usageTags`로 분리해서 받는다. `misc`(실측: "しどい"→["Slang"], "薔薇"→["Usually written using kana alone"])는 격식뿐 아니라 표기 관례 같은 이질적 태그까지 섞여 있어 `register`가 아니라 `usageTags`로 개명해 수용.
- `info`(jisho.org 실측: "パン" 첫 뜻 → "originally written 麺麭 or 麪包")는 MW `uns`와 동일하게 "gloss/examples 어디에도 안 들어가는 sense 단위 자유 서술"이라 `usageNote`로 합류.
- 원본엔 `dialect: Tag[]`(방언, 예: 関西弁 어휘)도 있으나 이 앱에 방언 판별 기능 자체가 없어 스코프 제외(zh 방언 발음을 스키마에서 뺀 것과 동일 판단).

**스키마 매핑**:

| JMdict/jisho.org 원본 필드 | 통일 스키마 필드 |
|---|---|
| `senses[].english_definitions` | `DictionarySense.gloss[]` |
| `parts_of_speech` | `DictionarySense.pos`/`posRaw` |
| `is_common` (entry 최상위) | `DictionaryReading.isCommon` |
| `see_also` | `DictionarySense.seeAlso` |
| `antonyms` | `DictionarySense.antonyms` |
| `field`(로컬 데이터셋) | `DictionarySense.domain` |
| `misc`/`tags`(jisho.org) | `DictionarySense.usageTags` |
| `info` | `DictionarySense.usageNote` |
| `v1`/`vt` 등 자동사/타동사 코드 | `DictionarySense.transitive` |
| (해당 없음, synonyms 키 없음) | `DictionarySense.synonyms` — 항상 undefined |

### Wiktionary (ja 항목)

**접근**: en.wiktionary.org의 ja 항목(raw wikitext 실측: `食べる`). ja.wiktionary.org(일본어판) 자체는 실측 결과 커버리지가 더 약해 미채택.

**특징**: `====Conjugation====` 섹션이 `conjugationClass` 같은 라벨 한 줄이 아니라 一段/五段 등 활용형 전체를 뽑아내는 템플릿(`{{ja-ichi}}`, `{{ja-conj-ex}}` 등, て形·ない形·た形·가능형·수동형·사역형까지 실제 활용된 표기로 렌더링됨) — **스코프 결정: 활용표 전체는 파싱하지 않고 "一段"/"五段(う)" 같은 분류 라벨만 뽑아 `conjugationClass`에 채운다.** 실제 활용형(食べた/食べて 등)은 이미 형태소 분석기(`main/nlp/japanese.ts`)가 별도 처리 중이라 어댑터가 중복 파싱할 필요 없음. 나중에 어미 활용 설명 자체를 사전 데이터로 보여줘야 하면 별도 필드(예: `inflectionTable`) 추가 재검토.

---

## 중국어(zh)

언어 판별 단계에서 zh-Hans/zh-Hant를 스크립트 기준으로 먼저 분리해 조회(변환 없이 네이티브 라우팅). zh-Hans는 汉典 → CC-CEDICT, zh-Hant는 萌典 → 汉典 → CC-CEDICT, 공통 최종 폴백은 Wiktionary.

### CC-CEDICT

**접근**: 로컬 데이터셋(`resources/cedict.u8` 원본 파일). 2026-07-28, 124,733개 항목 직접 실측.

**원본 구조 특징**:
- 포맷 자체가 `번체 간체 [pinyin] /뜻1/뜻2/.../` — 슬래시 구분 뜻 목록 안에 실제 정의뿐 아니라 사용역 라벨·전문분야 라벨·교차참조·발음 변이가 전부 비정형 평문으로 뒤섞여 있음. 스키마에 필드가 없는 게 아니라 **어댑터가 슬래시 세그먼트마다 정규식으로 분류해 올바른 필드로 라우팅**해야 하는 파싱 문제.
- 사용역/전문분야 라벨(실측 빈도): `(idiom)` 5733회, `(loanword)` 849, `(literary)` 1331, `(coll.)` 950, `(dialect)` 576, `(bound form)` 772, `(slang)` 545, `(derog.)` 94, `(archaic)` 188 / 전문분야: `(math.)` 524, `(computing)` 483, `(chemistry)` 360, `(medicine)` 251, `(TCM)` 176, `(Buddhism)` 156, `(law)` 115, `(finance)` 110 등 → `DictionarySense.usageTags`로 흡수(괄호 텍스트를 그대로 넣을지, 소스 간 통일 어휘로 정규화할지는 미정).
- 교차참조 포인터(`variant of`, `old variant of`, `erhua variant of`, `abbr. for`, `see also`, `used in`, `also written` — 실측: `一族` → `.../see also 族[zu2]`, `一個勁兒` → `erhua variant of 一個勁|一个劲[yi1 ge4 jin4]`) → `DictionarySense.seeAlso`. MW의 `cxs`(포인터 전용 엔트리가 정의를 통째로 대체)와 달리 CC-CEDICT는 **같은 슬래시 리스트 안에 실제 정의와 포인터가 섞여** 있어(`一族` sense 안에 진짜 정의 3개 + see also 1개), 세그먼트별로 골라내 `gloss`가 아니라 `seeAlso`로 보내는 필터링이 필요.
- `Taiwan pr. [...]`/`also pr. [...]`(실측: `行`(xing2) → `.../behavior; conduct (Taiwan pr. [xing4])/...`) → `DictionaryPronunciation.variety: "Taiwan"`(원문 sense 텍스트 안에 파묻혀 있어 정규식 추출 필요).
- 동자이음(異音字, 실측: `都` → Du1(성씨)/dou1(모두)/du1(수도) 3줄, `行` → hang2/heng2/xing2 3줄) → `DictionaryReading[]` 배열 구조에 자연스럽게 대응.
- `CL:`(양사, 원본: `CL:個|个[ge4],位[wei4]`처럼 번체\|간체 쌍+병음이 콤마로 여러 개 이어지는 복합 문자열) — 콤마로 분리해 세그먼트(`個|个[ge4]`, `位[wei4]`) 그대로 `DictionarySense.classifiers[]` 각 원소에 넣기로 확정(추가 분해 없음).
- 병음 첫 글자 대문자(실측: `Du1`, `San1` 등, 전체 20,266/124,733줄 = 16%)로 고유명사(성씨/지명) 구분 신호가 있음 — **결정(2026-07-28): 전용 `isProperNoun` 필드는 추가하지 않는다.** en의 `isIdiom`과 달리 이 신호 하나만으로 어댑터/LLM 활용처가 아직 없어 필드를 신설할 실익이 부족하다고 판단, `surname X`/`place name` gloss 텍스트만으로 충분한 수준으로 남겨두고 이 노트에만 신호 존재를 기록해둔다. 필요해지면 이 항목을 근거로 재검토.
- `(bird species of China)` 태그가 1443회로 매우 빈번 — 조류 라틴학명 엔트리가 대량 포함돼 일반 단어 조회 결과에 노이즈가 될 수 있음(스키마 문제 아니고 어댑터 필터링 검토 대상).

**스키마 매핑**: 슬래시 세그먼트를 분류 후 `gloss[]`/`usageTags`/`seeAlso`/`classifiers`/`pronunciations[].variety`로 라우팅. `pos` 필드 자체가 없어 항상 undefined.

### 汉典 (zh-Hans)

**접근**: 스크래핑, `/hans/` 경로(간체 네이티브).

**상태**: 아직 미실측(2026-07-28 기준) — CC-CEDICT까지만 실측 완료, 汉典 응답 구조는 폴백 순서만 확정된 상태. 유의어(近反义词 섹션)가 있다는 것만 확인됨(초기 조사, `DictionarySense.synonyms`로 매핑 예정). 실측 완료되는 대로 이 섹션 갱신 필요.

### 萌典 (zh-Hant)

**접근**: 스크래핑, 대만 교육부 편찬(번체 네이티브, 대만식 표준 어휘는 汉典보다 강함 — 실측: 捷運 등 대만 인프라 용어).

**상태**: 아직 미실측 — CC-CEDICT까지만 실측 완료. 다만 아래 특징은 초기 조사로 확인:
- `definitions[].type` 필드로 품사 제공(名/動/形/副/連/介/代/助/歎, 순서대로 명사/동사/형용사/부사/접속사/전치사/대명사/조사/감탄사). 단, 양사(量詞)는 별도 type 값이 없고 `名`(명사) 안에 "量詞："라는 평문으로만 표시돼(예: "隻") classifier 판정은 이 필드만으론 안 되고 gloss 텍스트 파싱이 추가로 필요.
- `heteronyms`(복수) — 동자이음. 실측: "行"이 heteronyms 4개, 각각 다른 병음(háng/hàng/xíng/xìng)에 전혀 다른 뜻풀이 세트를 가짐 → `DictionaryReading[]`으로 매핑.
- `link` 필드(관련어 참조, 실측: "蟑螂" → "也稱為「蜚蠊」" 문장형) → `DictionarySense.seeAlso`. 汉典 近反义词 섹션과 달리 완결된 용어 목록이 아니라 문장 형태라, 어댑터가 용어만 추출하거나 애매하면 `usageNote`로 대체 처리.
- `zh-pron` 관련(Wiktionary 조사 중 확인, 萌典 자체 응답은 아님) — 아래 Wiktionary zh 항목 참고.

### Wiktionary (zh 항목)

**접근**: en.wiktionary.org의 zh 항목(REST `/page/definition`·`dictionaryapi.dev`·raw wikitext 3경로 비교, `捷運` 실측). zh.wiktionary.org(중국어판)는 en.wiktionary.org보다 약해 미채택(위키미디어 접근 제한 등으로 추정).

**특징**: `{{zh-pron}}` 블록 하나에 표준중국어(jiéyùn)·광둥어(zit3 wan6)·객가어(POJ+HRS 두 표기)·민난어(chia̍t-ūn) 4개 방언이 동시에 들어있음 — "발음이 다르면 뜻도 다르다"(`DictionaryReading` 분리 기준)도 "같은 sense의 지역 변이"(OEWN variety 케이스)도 아닌 제3의 축(동일 표기·동일 뜻·언어 자체가 다른 방언)이라 스키마 어디에도 안 맞고, 汉典·萌典·CC-CEDICT는 애초에 표준중국어만 다뤄 이 문제가 없으며 이 앱에 방언별 발음 질문 기능도 없어 무리해서 담을 실익이 없음 → **표준중국어(Mandarin) `m=` 필드 하나만 뽑아 `pronunciations: [{ value }]`로 채우고 나머지 방언은 버린다.** 구어 줄임말·인터넷 유행어(超商·很雷·部落格 등) 전용 최종 폴백 — 汉典·萌典 둘 다 이 카테고리를 놓치는 것을 실측으로 확인.

---

## 공통 스키마 결정 사항

여러 소스에 걸쳐 있는 스키마 설계 판단(전체 근거는 `src/shared/types.ts` 해당 필드 주석 참고):

- `DictionaryEntry.source`는 스키마엔 유지하되 LLM 프롬프트엔 넣지 않음 — 폴백 체인 디버깅·UI 출처 표기(예: "출처: JMdict")용으로만 사용.
- `isCommon`(entry 선택용 필드)은 최종적으로 없앰 — 동일 표기의 서로 다른 reading(예: はし/きょう)은 **하나의 entry로 병합**되는 게 맞는 설계(MW hom, 萌典 heteronyms와 동일 패턴)라 우선순위 신호의 역할은 "entry 선택"이 아니라 "그 entry 안 어느 reading/sense가 대표인지"로 축소 — `DictionaryReading.isCommon`(JMdict 전용, reading 레벨)과 `DictionarySense.tagCount`(OEWN 전용, sense 레벨)로 분리해 실제 데이터가 있는 레벨에 맞춰 부활시킴.
- `pos`(CanonicalPos)는 언어 간 겹치는 범위로만 표준화하고, 원본 세부 표기는 `posRaw`(LLM에 전달 안 함)에 보존. 문법 설명에 실제로 필요한 세부 정보(활용 분류 등)는 `posRaw`에만 있으면 버려지는 것과 같으므로 `conjugationClass`(사람이 읽을 수 있는 문자열, LLM에도 전달)로 별도 승격.
- 판별 유니온(discriminated union) 대신 공통 베이스+옵셔널 확장 필드 방식을 의도적으로 채택 — 언어 전용 필드가 2~3개 규모에서는 유니온이 과한 복잡도로 판단(실행 시점엔 JSON 직렬화로 undefined 키 자동 생략되어 안전, 다만 타입 수준에서 "이 필드는 이 언어 전용"을 컴파일러가 강제하지는 않음).

**아직 미확인 항목** (실측 필요, 확인되는 대로 위 해당 섹션에 반영):
- 汉典·萌典 원본 응답의 전체 구조(현재는 폴백 순서만 확정, 위 각 섹션의 초기 조사분 외 미실측).
- en 불규칙 동사 활용(MW `ins` 필드)을 `irregular?: boolean` 플래그로 별도 승격할지 여부.
- zh 이합사(离合词, 结婚/见面처럼 중간에 성분 삽입 가능한 특이 문법) — 汉典/萌典/CC-CEDICT 태깅 여부(현재까지는 CC-CEDICT 기준 태깅 없음으로 확인, 汉典/萌典은 미확인).
- MW의 전문분야 라벨(`lbs` 계열) 존재 여부.
