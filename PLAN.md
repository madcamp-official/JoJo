# Nuance — 외국어 콘텐츠 소비 보조 프로그램 · 기획서

## 목차

1. [개요](#1-개요)
2. [지원 언어](#2-지원-언어)
3. [대상 콘텐츠](#3-대상-콘텐츠)
4. [사용 흐름](#4-사용-흐름)
5. [핵심 기능](#5-핵심-기능)
6. [사전 API 구성](#6-사전-api-구성)
7. [기술 아키텍처](#7-기술-아키텍처)
8. [까다로운 부분 & 해결 전략](#8-까다로운-부분--해결-전략)
9. [2인 분업 계획 (파이프라인 축)](#9-2인-분업-계획-파이프라인-축)
10. [리스크 & 확장 로드맵](#10-리스크--확장-로드맵)
11. [프로젝트 구조 (스캐폴드)](#11-프로젝트-구조-스캐폴드)

## 1. 개요

**한 줄 소개**: 화면 위 어떤 외국어 텍스트든 클릭 한 번으로, 그 맥락에 맞는 발음·뜻·뉘앙스를 즉시 알려주는 데스크톱 오버레이 도구.

**문제의식**: 외국어 원서·영상·웹소설·만화를 소비할 때, 모르는 표현을 만나면 뷰어를 벗어나 사전/번역기로 이동해야 하고, 사전은 그 **문맥 속 의미**를 짚어주지 못한다. `read`의 발음, `後`의 독음, 어떤 뜻으로 쓰였는지는 문맥이 있어야 안다.

**목표**: 사용자가 보고 있는 창 위에 투명 오버레이를 띄워, 콘텐츠를 벗어나지 않고 단어를 클릭 → 문맥 인지형 AI 답변을 받는 경험을 제공한다. 텍스트를 직접 추출할 수 있으면 추출하고, 불가능하면(스캔본·이미지 전자책) OCR로 대응한다.

**지원 범위**: 한국어 모어 화자 대상 / Windows·macOS. 언어는 3단계(tier)로 나뉜다 — 상세는
§2 지원 언어 참고.

## 2. 지원 언어

2026-07-30 도입. 그 전까지는 영어·일본어·중국어(간체/번체) 4개만 지원했는데, eld(언어 판별기)가
실제로 감지 가능한 언어 범위와 앱이 제공하는 기능 범위가 서로 다르다는 걸 인지하고 "감지되는
모든 언어에서 최대한 기능을 제공하되, 기능별로 지원 범위가 다름을 명시"하는 3단계 구조로 재설계
했다. 근거·조사 과정(네이버 사전 URL 패턴 재조사, 구글 발음 접미어 언어별 검증, OCR 언어팩 용량
실측 등)은 TODO.md "언어 확장성" 항목에 기록돼 있고, 여기서는 최종 구조만 정리한다.

| Tier | 언어 | OCR | AI 발음 | AI 사전 | 형태소 분석기 | 구글(발음/이미지 검색) | 네이버 사전 |
|---|---|---|---|---|---|---|---|
| **tier1** | 영어·일본어·중국어(간체/번체), 4개 | ✅ | ✅ | ✅ | ✅(ja/zh만) | ✅ | ✅ |
| **tier2-A** | eld 감지 가능 + 네이버 사전 실지원, 30개 | ✅ | ✅(IPA) | ❌ | ❌ | ✅ | ✅ |
| **tier2-B** | eld 감지 가능, 네이버 사전 없음, 26개 | ✅ | ✅(IPA) | ❌ | ❌ | ✅ | ❌ |
| **tier3** | 그 외 전부(eld가 아예 못 잡는 언어 포함) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- **tier1**은 기존 4개 언어 그대로(`Language` 타입, 닫힌 유니온) — AI 사전(§6 사전 API 구성,
  사전 API + AI 뜻 번호 판정)까지 포함한 전체 기능을 받는 유일한 등급. 그중 일본어·중국어는
  전용 **형태소 분석기**(`main/nlp/japanese.ts`: Lindera/Sudachi, `main/nlp/chinese.ts`:
  jieba/Intl.Segmenter/chinese-tokenizer)로 OCR 단어 재분할과 팝업 atom 병합을 처리하는
  것도 tier1 전용 특권이다 — tier2는 이런 언어별 형태소 분석기가 없어서, 공백으로 단어가
  구분되는 스크립트는 공백 기준(`LATIN_ATOM_RE` 류)으로, 공백이 없는 스크립트(태국어·라오어)는
  분석기 부재로 아예 글자 단위 강제(아래 항목)로 대체한다.
- **tier2**(A/B 합쳐 56개, `LinkLanguage` 타입)는 OCR·AI 발음·구글 검색까지는 tier1과 동일하게
  받지만, AI 사전(사전 API 폴백 체인)은 tier1 전용으로 남겨뒀다 — 사전 API 자체가 tier1 3개
  언어(+한국어 미지원) 기준으로 구성돼 있어서(§6), tier2까지 확장하려면 언어별 사전 소스를 새로
  발굴해야 해 이번 범위에서 제외. "AI 발음"은 사전 API 없이 AI 프롬프트만으로 되는 기능이라
  tier 구분 없이 항상 제공된다.
  - 네이버 사전은 언어별로 실제 서비스 여부가 갈려(재조사로 확인, 2026-07-30) 2-A/2-B로 다시
    나뉜다 — 팝업 툴바(`Toolbar.tsx`)가 `showNaverDict`/`showAiDictionary` prop으로 이 조합을
    노출/숨김한다.
  - 발음 표기는 tier2 전체 IPA로 통일(언어별 자연스러운 대안은 검증 비용 문제로 보류, 필요해지면
    `LinkLanguageInfo.pronunciationNotation` 필드로 언제든 교체 가능하게 설계돼 있음).
  - 공백 없는 스크립트(태국어·라오어)는 형태소 분석기가 없어 정확한 단어 경계를 낼 수 없다 —
    확장 hover 박스는 줄 전체를 한 덩어리로 보여주고, 팝업 내부 선택은 토글 없이 항상 글자
    단위로 강제한다(TODO.md 참고, "호버는 줄 단위 / 팝업 내부는 글자 단위"로 레이어마다 이유가
    다름).
- **tier3**은 감지는 되지만(eld가 잡는데 tier2에 없는 언어) 기능이 전혀 없거나, eld가 아예
  못 잡는 언어 — 클릭 시 팝업 대신 짧은 OS 알림("이 언어는 아직 지원하지 않습니다")만 뜬다.
  `detectSupportedLanguage()`가 tier1/2가 아니면 조용히 'en'으로 폴백하던 예전 방식(2026-07-29
  넷플릭스 간체/번체 오판과 같은 유형의 함정) 대신 `null`을 명시적으로 반환하고, 자막
  (`subtitleSource.ts`)·웹페이지(`webSource.ts`) 두 direct 추출 경로 모두 `null`이면 토스트로
  처리한다.
- **타입 구조**: `Language`(tier1, 4개) ⊂ `AnyLanguage = Language | LinkLanguage`(tier1+tier2,
  감지·선택 결과가 실제로 흘러다니는 자리 전부 — `ExtractedSelection.language` 등). tier1 전용
  로직(AI 사전)은 진입점에서 `isFullLanguage()`로 좁혀 `Language`만 다루게 해서, 사전 없는
  언어가 실수로 사전 로직을 타는 걸 컴파일 타임에 막는다. tier2 언어를 tier1로 승격하려면
  `LinkLanguage`에서 빼서 `Language`로 옮기기만 하면 되도록(필드 구조 동일) 설계해둠.

### tier별 언어 목록

- **tier1(4개)**: 영어, 일본어, 중국어(간체), 중국어(번체)
- **tier2-A(30개, 구글+네이버 사전)**: 아랍어, 체코어, 덴마크어, 독일어, 그리스어, 스페인어,
  페르시아어, 핀란드어, 프랑스어, 히브리어, 힌디어, 크로아티아어, 헝가리어, 이탈리아어,
  조지아어, 라오어, 네덜란드어, 노르웨이어, 폴란드어, 포르투갈어, 루마니아어, 러시아어,
  알바니아어, 스웨덴어, 태국어, 타갈로그어, 터키어, 우크라이나어, 우르두어, 베트남어
- **tier2-B(26개, 구글만)**: 암하라어, 아제르바이잔어, 벨라루스어, 불가리아어, 벵골어,
  카탈루냐어, 에스토니아어, 바스크어, 구자라트어, 아르메니아어, 아이슬란드어, 칸나다어,
  한국어, 쿠르드어, 리투아니아어, 라트비아어, 말라얄람어, 마라티어, 말레이어, 오리야어,
  펀자브어, 슬로바키아어, 슬로베니아어, 세르비아어, 타밀어, 텔루구어
- **tier3**: 위에 나열되지 않은 그 외 모든 언어(eld가 감지하더라도 tier2에 없으면 tier3).
  단일 출처는 `src/shared/languages.ts`(`LANGUAGES`/`LINK_LANGUAGES`) — 언어 추가/등급 변경은
  반드시 이 파일만 고치면 되도록 설계돼 있으니, 이 목록이 실제 코드와 달라 보이면 이 파일
  기준으로 갱신할 것.

## 3. 대상 콘텐츠

| 채널 | 대상 | 텍스트 확보 방식 |
|------|------|------------------|
| 데스크톱 | txt/epub 뷰어 | 원본 파일 직접 추출 |
| 데스크톱 | PDF 뷰어 | 추출 시도 → 텍스트 양으로 판정(적으면 OCR) |
| 데스크톱 | Kindle/Apple Books(전자책 뷰어) | 접근성 API로 렌더 텍스트 추출 시도 → 실패 시 OCR |
| 데스크톱 | 스캔 소설·만화 | OCR |
| 브라우저 | 유튜브 | URL 기반 원어 자막 추출 |
| 브라우저 | 넷플릭스 | 확장 프로그램으로 현재 에피소드 원어 자막 추출 |
| 브라우저 | 웹소설·웹툰·일반 웹페이지 | 확장으로 DOM 텍스트 추출 → 부족하면 OCR |

## 4. 사용 흐름

1. **실행** → 중앙에 큰 [창 선택] 버튼 + 우측 상단 작은 [설정] 아이콘.
2. **창 선택** (Zoom 화면공유처럼 창 목록에서 선택) → 앱이 해당 창 화면을 볼 수 있음 → 백그라운드 실행.
   - 선택된 창 테두리 색 표시: **일반 모드 = 파란색 / 선택 모드 = 보라색**.
   - 백그라운드 아이콘 클릭 시: 창 선택 전환 / 창 선택 해제 / 설정.
3. **모드 전환 단축키**로 일반 모드 ↔ 선택 모드 토글.
   - 일반 모드: 클릭에 개입하지 않음.
   - 선택 모드: 포커스된 창 위에 투명 오버레이 → 텍스트 클릭 가로챔.
4. **선택** → 근방 텍스트가 팝업으로 뜸 → 범위 지정 후 질문.
5. **질문** → 발음 / 사전 / 통합 질문(채팅형) / 구글 검색.

### 화면 구성 (UI 목업 기준)

**메인 화면**: 중앙에 큰 파란 [창 선택] 버튼 + "사용할 창을 선택하세요" 안내 + 우측 상단 작은 설정(톱니) 아이콘. 앱 아이덴티티 "Nu"/Nuance. Windows 11·macOS 네이티브 룩.

**설정 화면** (섹션 순서):
1. **LLM 선택** — GPT / Gemini / Claude 카드형 단일 선택(선택 시 체크 표시).
2. **API 키 관리** — 선택한 LLM의 키 입력, 보기(눈 아이콘)·수정·삭제. "안전하게 암호화 저장, 외부 미전송" 안내. 키 입력/수정·provider 선택 시 **무과금 GET으로 유효성 검사 + 사용 가능 모델 목록**을 받아, 유효/무효 상태와 **사용 모델 드롭다운**을 함께 표시(미선택 시 기존 기본 모델 사용). 잔액/크레딧은 공개 API 부재로 표시하지 않고, 크레딧 부족은 질문 시 에러로 안내.
3. **단축키 설정** — 모드 전환(일반 ↔ 선택) 키 지정. 기본 예: `Alt+Q`, 연필(변경)/휴지통(해제) 아이콘 버튼. 표시는 OS에 맞춰 macOS는 `Cmd/Ctrl`·`Opt`, 그 외는 `Ctrl`·`Alt`로 보여주며, macOS에서는 실제로 Cmd/Ctrl 두 키 모두로 동작한다.
4. **문맥 범위(Byte)** — 프롬프트 제출 시 함께 넘길 앞뒤 텍스트 범위를 Byte 단위로 지정(자유 지정: 연속 슬라이더 + 숫자 입력, 상한은 고정값이 아니라 설정 화면 미리보기 텍스트 길이 기반으로 동적 계산됨 — `SettingsScreen.tsx` `BYTE_MAX`). 앞/뒤 예산을 분리해 각각 지정하거나 잠금(linked)으로 동일 값 사용. 실제로는 순수 바이트 경계에서 문장이 잘리지 않도록 문장 경계까지 확장된다. 미리보기에 "포함 제외 / 사용자 선택 영역 / 포함될 주변 범위"를 색으로 시각화.
5. **언어 선택** — 자동 언어 감지 / 직접 선택(영어·일본어·중국어). OCR 언어 설정. 중국어는 간체/번체를 따로 고르지 않고 Tesseract 언어팩을 `chi_sim+chi_tra`로 함께 로드해 자동 판별한다.

**팝업 화면**: 상단에 선택된 원문 문맥 표시(선택한 표현이 속한 줄 기준 앞뒤 각 2줄, 부족하면 있는 만큼만) → 툴바(구글 로고 + [발음 검색]·[시각 자료 검색] · 네이버 로고 + [사전](언어별 en/ja/zh 사전 페이지를 새 브라우저 창으로 여는 바로가기, AI 뜻 번호 판정과는 별개) · AI 배지 · [발음]·[사전 검색] 원샷 버튼, 구글·네이버 로고도 AI 배지와 동일한 배지 스타일로 배치) → AI 채팅 영역(질문/답변 말풍선 + "궁금한 내용을 입력하세요…" 입력창 — 통합 질문은 여기서 입력) → 하단 "자주 쓰는 질문" 목록(각 항목 [수정], 드래그로 순서 변경; 예: 문법적 역할 / 문맥 속 의미 / 격식·객관 표현 여부).

팝업 창 자체의 크기는 열릴 때 한 번만 정해지고(너비 900px 고정, 높이는 min(900px, 현재 모니터 작업영역 높이 − 40px)) 이후 내용에 따라 다시 조정되지 않는다(설정 화면과 창 크기가 같지 않음 — 설정 화면은 760×800 고정). 그 고정된 높이 안에서 원문 문맥 표시 영역만 자체 스크롤 없이 텍스트 양만큼 자란다(내용이 짧으면 작게, 많으면 크게) — 나머지 영역(AI 채팅 영역)이 flex로 남는 공간을 차지하고, 대화가 그 공간보다 길어지면 채팅 로그 자체가 내부 스크롤(`.chat-log`)로 넘친다. 라이트 테마.

## 5. 핵심 기능

### 5.1 선택 (Selection Pipeline)

**모드 전환**
- 선택 모드 진입 시 포커스된 창 위로 클릭스루 가능한 투명 오버레이 윈도우를 띄운다.
- 텍스트 영역 클릭 → 근방 텍스트 팝업. 텍스트 외 영역 클릭 → 일반 클릭으로 통과.

**단어 감지 & 시각 피드백**
- 각 단어의 화면 좌표(bounding box)를 확보 → 커서 좌표가 어느 단어에 해당하는지 판정.
- 선택 가능한 단어 위에 커서가 오면 커서 모양 변경. 브라우저(확장 있음)에서는 단어 주변에 사각형 하이라이트.
- OCR로 뽑은 일본어·중국어는 Tesseract 자체 단어 경계 대신, 줄 단위로 다시 형태소 분석기(일: Lindera/Sudachi 중 `main/nlp/japanese.ts` `JA_ENGINE` 상수로 택1, 중: `main/nlp/chinese.ts` — zh-Hans는 jieba(`@node-rs/jieba`) 고정, zh-Hant는 `ZH_HANT_ENGINE` 상수로 Intl.Segmenter/chinese-tokenizer 중 스위치)를 돌려 의미 단위 단어로 재구성한다(`main/nlp/`). 각 단어 bbox는 가로(x)만 구성 글자(symbol)들의 bbox를 합쳐(union) 계산하고, 세로(y)는 기존과 동일하게 줄(line) 전체 bbox를 쓴다(같은 줄 단어들의 높이를 통일하기 위해서 — §5.1 다른 OCR 단어 높이 처리와 동일한 이유).
  - **중국어 엔진 선택 근거(2026-07-28 실측)**: segmentit·jieba 계열(nodejieba/@node-rs/jieba/jieba-wasm/@isdk)·Intl.Segmenter·chinese-tokenizer·lindera 8종을 간체/번체 각각 12문장 코퍼스로 F1 채점. zh-Hans는 `@node-rs/jieba`가 전 문장 만점(번체는 F1 .84 수준으로 부적합, zh-Hant엔 안 씀). zh-Hant는 완전한 승자가 없어(Intl.Segmenter=흔한 복합명사·성어 과다분절 및 인명 인식 약함, chinese-tokenizer=가든패스 중의성·영단어 오분할, lindera=바이트 오프셋·공백 삼킴·어미 오합류) 스위치로 남김 — 기본값은 chinese-tokenizer(오프셋이 이 앱과 같은 문자 단위라 통합 비용이 가장 낮음, CC-CEDICT는 사전 조회 기능과 공유해 용량 증가 없음). 원본 비교 스크립트·전체 실측 데이터는 실험 완료 후 폐기됨.

**팝업 내 범위 지정 (최소 단위)**
- 영어: 단어(공백 구분) 단위.
- 중국어: OCR 단어 클릭과 동일한 분석 결과(`main/nlp/chinese.ts`)를 그대로 atom으로 써서 단어 단위로 선택된다(`popup/selection.ts`) — 원래 계획이던 한자 글자 단위 선택은 실사용 확인 결과 아쉬워서 단어 단위로 전환.
- 일본어: 형태소 분석 결과(엔진은 `main/nlp/japanese.ts` `JA_ENGINE` 상수로 Lindera/Sudachi 중 스위치, 사용자 UI 없음)를 문절 단위 병합해 atom으로 쓴다(`JA_ATOM_STRATEGY='wordMerge'`, `popup/selection.ts`) — 동사·형용사 어간 뒤 조동사와 て/で 활용어미(예: "向かう"→"向かって")만 흡수하고, 그 뒤에 이어지는 補助動詞(ている 의 いる 등)·접미동사(過ぎる/出す 등)·명사 자동 병합은 하지 않는다 — 전부 그 자체로 독립된 사전 표제어라 따로 선택해 조회할 수 있어야 한다는 판단(실사용 피드백 반영, 예: "食べている" → 食べて / いる). 조동사 중에서도 ちゃう/じゃう(〜てしまう 축약)와 추량 だろう/でしょう(구어체 だろ/でしょ 포함, 예: "すぎるだろ" → すぎる / だろ)는 흡수하지 않고 새 단어로 분리한다(같은 이유, 2026-07-29 피드백 — 상세는 `shared/nlp/ja-unidic.ts` 주석). 원래 계획이던 한자 글자 단위 선택(`JA_ATOM_STRATEGY='charLevel'`)은 코드에 남겨뒀고 상수만 바꾸면 되돌릴 수 있다. 형태소 분석 결과가 도착하기 전 짧은 순간만 Intl.Segmenter 기반 근사치로 대체.
- 클릭=단어 선택, 드래그=범위 선택 구분 → 클릭 이벤트를 mouseup에서 처리하여 드래그와 분리(세부 구현 미정, 프로토타이핑으로 확정).

**동작 구조(파이프라인)**
```
선택 모드 활성화
  → OCR 사용 여부 판정
     → (OCR 필요) 포커스 창 캡처 → 언어 특정(자동 감지 시 경량 분류/범용 OCR) → 언어 특화 OCR
     → (직접 추출) 소스별 텍스트 추출
  → 텍스트 추출 + 화면 좌표 매핑
  → 커서 좌표 ↔ 단어 매핑
  → 단어 클릭 감지 → 팝업 트리거 (ExtractedSelection = 근방 텍스트·단어 좌표·클릭 기준점을 B로 전달)   ← 여기까지 A (팝업 전)
  → [B] 팝업 내 범위 확정 → SelectionContext 생성 → 질문 파이프라인                                    ← 이후 B (팝업 후)
```

**OCR 사용 여부 판정 로직** — 원칙: "직접 추출을 먼저 시도하고, 확보 텍스트가 부족할 때만 OCR로 fallback".
- 유튜브·넷플릭스·txt 뷰어 → 직접 추출.
- Kindle·Apple Books 등 전자책 뷰어 → **접근성 API(macOS AX / Windows UIA)로 렌더된 텍스트 추출을 먼저 시도** → epub 임포트 등으로 원본 텍스트가 노출되면 직접 추출, DRM·이미지 렌더로 추출 불가하면 OCR. (Apple Books는 AX로 잘 노출, Kindle은 편차 있어 fallback 필수.)
- PDF 뷰어·기타 웹사이트 → 텍스트 추출 시도 후, 노출 텍스트 양이 많으면 직접 추출 / 통짜 이미지면 OCR.
- 스캔 소설·만화 → OCR.

**판정 시점**
- 선택 모드 진입 시 1회 판정하고 유지.
- 창 재선택 시 선택 모드 자동 해제.
- 같은 창에서 탭 URL이 바뀔 때마다 재판정(브라우저 탭 + PDF 뷰어 탭 포함).
  - 브라우저 내부 → 확장 프로그램 / 그 외 → 데스크톱 접근성 API로 URL·탭 변화 감지.
  - URL을 메인 구분 요소로 사용. 한 URL 내 OCR 여부 변화는 고려하지 않음.

### 5.2 질문 (Question Pipeline)

**AI 채팅 팝업** (GPT / Gemini / Claude 선택)
- 하나의 팝업 = 하나의 대화 세션. 후속 질문이 이전 답변 맥락을 이어감.
- 인근 텍스트(설정 범위)를 문맥으로 함께 전달. 전체 맥락 텍스트는 **프롬프트 캐싱**으로 비용 절감 — 현재 Claude 어댑터에 `cache_control: ephemeral`으로 구현되어 있고, GPT/Gemini는 아직 미적용(TODO.md §미해결 문제 "LLM 비용 고려사항" 참고).
- 팝업 툴바에서 **발음·사전 검색은 누르면 즉시 질문이 전송되는 원샷 버튼**([발음]/[사전 검색]), **구글 검색은 별도 버튼**([발음 검색]/[시각 자료 검색])으로 구성하고, **통합 질문은 툴바가 아니라 그 아래 AI 채팅 영역의 입력창**에서 입력한다(§4 화면 구성 참고).

1. **발음** — 선택 텍스트의 발음기호(영: IPA / 일: 히라가나 / 중: 한어병음). **맥락 의존 발음**을 반영: `read`(현재/과거), `associate`(명·형/동), `後`(あと·ご·のち), `人気`(にんき·ひとけ), `得`(de·dé·děi), `行`(xíng·háng). 지역별 발음이 여러 개면 `[미국]`/`[영국]`(영어), `[대륙]`/`[대만]`(중국어) 순으로 대괄호 라벨을 붙여 병기하고, 근거는 의미 중의성을 판정해 발음을 좁힌 경우에만 표시(단순 지역·격식 변이면 생략). 형식이 고정된 판정 작업이라 LLM 호출 시 temperature를 낮게 고정.
2. **사전 검색** — 선택 영역을 단어 단위 분해 → 사전 API로 각 단어 정보 획득 → 문맥과 함께 AI에 전달 → AI가 **해당 맥락에서 사전상 몇 번 뜻인지** 판정.
3. **통합 질문** — 자유 프롬프트. 자주 쓰는 질문을 사용자가 커스텀 등록·수정·삭제(예: 문맥 속 의미 / 문법적 역할 / 격식도·어투·뉘앙스 / 문장 구조).

**구글 검색** (외부 브라우저 새 창 — 임베드형 팝업 속 팝업은 채택하지 않음)
- 발음: "선택 텍스트 + pronunciation/読み方/拼音" 구글 웹 탭.
- 시각 자료: 선택 텍스트 구글 이미지 탭.
- 이미 떠 있는 브라우저의 새 탭이 아니라 새 창으로 뜨도록, 기본 브라우저를 감지해 브라우저별로 새 창 옵션을 지정해 연다(Chromium/Firefox: `--new-window`, Safari: AppleScript, Windows는 레지스트리로 기본 브라우저 탐지 — 감지 실패 시에만 `shell.openExternal` 폴백).

## 6. 사전 API 구성

선택 영역을 사전 API로 조회해 원어 뜻(sense) 목록을 확보하고, 문맥상 몇 번째 뜻인지는 AI가 판정한다(§5.2 "사전 검색"). 사전 API는 원어 sense 목록만 제공하고 한국어 설명·번역은 AI가 담당한다 — 공식 무료 이중언어(외국어→한국어) API가 마땅치 않기 때문이다. 아래 구성은 **비상업(개인 목적) 사용을 전제**로 확정한 것이며, 상업화 시 재검토가 필요한 항목은 마지막에 별도 표기한다.

### 영어(en)
1. **Merriam-Webster**(영영사전=원어사전, 이중언어 아님) — 키 등록 필요, 무료 개인용 티어(일 1,000회/키). sense 번호가 구조화되어 있어 문맥 판정에 최적.
2. **OEWN(Open English WordNet, 영영사전=원어사전, 로컬)** — MW 미등록 또는 MW에 해당 단어가 없을 때 폴백. synset(동의어 집합) 구조가 sense 판정에 적합. 원본 Princeton WordNet(2011년 이후 갱신 없음, 발음 정보 없음)의 커뮤니티 후속 프로젝트(Global WordNet Association, CC-BY 4.0)로 교체 — 계속 갱신되고(최근 2년간 18,500건+ 개선) 단어 발음(IPA)도 추가로 제공. 라이브 API(en-word.net)는 실측 결과 불안정(503)이라 API 대신 JSON 릴리스 파일을 받아 로컬 번들.
3. **Wiktionary**(en.wiktionary.org, 다국어 통합 사전의 영어 항목) — 위 두 소스에 없는 신조어 전용 최종 폴백.

### 일본어(ja)
1. **daijisen**(デジタル大辞泉, 일일사전=원어사전, kotobank.jp 경유 스크래핑) — kotobank.jp 자체는 138개 정식 사전을 통합 서비스하지만, 이 앱은 그중 원전(原典)인 小学館 デジタル大辞泉 하나만 채택(소스 식별자·표시 라벨도 경유 플랫폼 이름이 아니라 이 원전 이름 기준). 일본어 정의문 품질 최상.
2. **JMdict**(일영사전, EDRDG) — daijisen이 못 찾은 단어의 커버리지 폴백(21만+ 항목). 번역어 나열이라 뉘앙스는 약하지만 신조어 대응력이 실측으로 매우 강함(2018년 이후 유행어 다수 포함).
3. **Wiktionary**(en.wiktionary.org, ja 항목) — 위 두 소스에도 없는 관용구·유행어 전용 최종 폴백. ja.wiktionary.org(일본어판) 자체는 실측 결과 커버리지가 더 약해 채택하지 않음.

### 중국어(zh) — 간체(zh-Hans)/번체(zh-Hant) 분리
언어 판별 단계에서 `zh` 하나가 아니라 **스크립트 기준으로 zh-Hans/zh-Hant를 먼저 분리**해 조회한다 — 스크립트 변환(OpenCC 등) 없이 각 스크립트를 네이티브로 지원하는 사전으로 바로 라우팅해, 변환 과정에서 생기는 오번역 리스크(一簡對多繁 등) 자체를 없앤다.

- **zh-Hans(간체/대륙식)**
  1. **汉典**(중중사전=원어사전, 스크래핑, `/hans/` 경로) — 간체 네이티브.
  2. **CC-CEDICT**(중영사전, MDBG) — 汉典 폴백.
- **zh-Hant(번체/대만식)**
  1. **教育部重編國語辭典**(萌典/moedict.tw 경유, 중중사전=원어사전, 대만 교육부 편찬 — 소스 식별자·표시 라벨도 경유 플랫폼(萌典)이 아니라 이 원전 이름 기준) — 대만 행정·공공 용어 등 대만식 표준 어휘는 汉典보다 강함(실측: 捷運 등 대만 인프라 용어).
  2. **汉典**(중중사전=원어사전, `/hant/` 경로) — 萌典 폴백.
  3. **CC-CEDICT**(중영사전) — 그다음 폴백.
- 공통 최종 폴백: **Wiktionary**(en.wiktionary.org, zh 항목) — 구어 줄임말·인터넷 유행어(超商·很雷·部落格 등) 전용. 汉典·萌典 둘 다 이 카테고리를 놓치는 것을 실측으로 확인. zh.wiktionary.org(중국어판)는 en.wiktionary.org보다 약해 채택하지 않음(위키미디어 접근 제한 등으로 추정).

### 상업화 시 재검토 필요(위 구성은 비상업 개인 목적 전제)
- **en**: Merriam-Webster 무료 티어는 앱 자체가 비상업일 것을 조건으로 함(사용자별 키 발급으로도 회피 불가) → 상업 빌드는 OEWN + Wiktionary만 사용.
- **ja**: daijisen(kotobank.jp 경유) 스크래핑은 약관의 "개인적 이용 목적" 조항에 기댄 회색지대 판단 → 상업 빌드는 JMdict + 日本語WordNet(NICT, 라이선스 클린, 일본어 정의문 보유) 조합으로 대체.
- **zh**: 汉典(CC BY-NC-ND, 비상업 한정)·萌典(대만 교육부 편찬물) 스크래핑 재검토 필요 → 상업 빌드는 CC-CEDICT 중심 구성 + 有道詞典 API(网易有道, 유료 협상형) 검토.

## 7. 기술 아키텍처

**전 구간 TypeScript 단일 언어**로 두 사람의 코드 이동 비용을 낮춘다. 구성 요소별 스택:

- **앱**: Electron(메인 = Node, 렌더러·오버레이 = 웹) + TypeScript + React(렌더러 UI).
- **캡처/오버레이**: 창 열거·캡처는 Windows 네이티브 win32(user32/gdi32/dwmapi, `koffi` FFI 바인딩)를 우선 사용(가려진/최소화된 창까지 캡처, `desktopCapturer`는 win32 네이티브 열거가 실패했을 때만 쓰는 최종 폴백). macOS는 창 "목록"엔 `desktopCapturer`(현재 가상 데스크탑/Space에 보이는 창만)를 그대로 쓴다 — 다른 Space의 창까지 열거하는 확장을 시도했으나(`CGWindowListCopyWindowInfo`를 `kCGWindowListExcludeDesktopElements`로 직접 호출) 목록이 지저분해지는 등 UX가 나빠져 원복했다(TODO.md 참고). 테두리 정렬·창 raise는 macOS도 CoreGraphics/AppKit을 `koffi`로 직접 바인딩(`main/selection/macWindow.ts`)해서 하고, 실제 화면 캡처엔 내장 `screencapture -l<windowID>`를 사용. koffi FFI는 Windows 전용이 아니라 두 플랫폼 모두에서 쓰인다. 투명·클릭스루 BrowserWindow, `globalShortcut`.
- **OCR**: Tesseract.js(로컬) 또는 클라우드 OCR(정확도 우선 시) — 벤치 후 결정. 중국어는 `chi_sim+chi_tra` 언어팩을 함께 로드해 간체/번체를 자동 판별. 일/중 단어 경계는 OCR 결과를 일본어(Lindera/Sudachi 중 택1)/중국어(zh-Hans는 jieba 고정, zh-Hant는 Intl.Segmenter/chinese-tokenizer 중 택1)(`main/nlp/`)로 재분할해 의미 단위로 맞춘다.
- **확장**: 브라우저 확장(Manifest V3) + 로컬 WebSocket(Electron main이 서버, 확장 background가 클라이언트) — native messaging은 OS별 호스트 매니페스트 등록이 번거로워 실제 구현 단계에서 WebSocket으로 결정(TODO.md 참고).
- **API**: LLM 3종 어댑터(GPT/Gemini/Claude), 사전 API(언어별), 구글 웹/이미지 탭.
- **보안**: API 키는 Electron `safeStorage`로 로컬 암호화 저장.
- **언어 감지**: 자동 감지 + OCR 필요 시, 언어 특화 OCR 전에 경량 분류 모델 또는 범용 OCR로 언어를 먼저 특정.

```mermaid
flowchart TB
    EXT["🌐 Browser Extension · MV3<br/>자막 추출(YT/NF) · DOM 텍스트 · 단어 하이라이트"]

    subgraph APP["🖥️ Electron App · TypeScript"]
        direction TB
        MAIN["<b>Main Process</b><br/>창 선택·캡처(win32 네이티브 우선/desktopCapturer 폴백, macOS는 desktopCapturer) · 전역 단축키(globalShortcut)<br/>접근성 API 브릿지(탭/URL 감지) · API 키 보관(safeStorage) · IPC 허브"]

        subgraph PIPE[" "]
            direction LR
            PA["<b>파이프라인 A · 선택준비/추출 (팝업 전)</b><br/>캡처 → (OCR｜직접추출) → 좌표 매핑 → 클릭 감지"]
            PB["<b>파이프라인 B · 선택확정/질문 (팝업 후)</b><br/>범위 확정 · LLM·사전 어댑터 · 캐싱 · 스트리밍"]
        end

        subgraph WINS[" "]
            direction LR
            OVL["<b>Overlay Window</b><br/>투명·클릭스루<br/>단어 하이라이트 / 커서 피드백"]
            POP["<b>Popup / Chat Window</b><br/>발음 · 사전 · 통합질문 · 구글탭"]
        end
    end

    SVC["☁️ 외부 서비스<br/>LLM(GPT/Gemini/Claude) · 사전 API · Google"]

    EXT -- "로컬 WebSocket" --> MAIN
    MAIN --> PA
    MAIN --> PB
    MAIN --> OVL
    PA -- "ExtractedSelection" --> PB
    PB -- "QuestionResult" --> POP
    PB -- "API 호출" --> SVC
```

## 8. 까다로운 부분 & 해결 전략


- **OCR 노이즈 제거**: 소설 제목·페이지 번호 등 불필요 텍스트를 **좌표 기반 규칙**(위치·반복성·정렬)으로 필터링 후 저장. 페이지 경계에 걸린 문장은 앞뒤 조각을 자연스럽게 이어붙임.
- **HTML 문단 잇기**: 태그는 제외하고 내부 텍스트만 이어 자연스러운 문단 구성.
- **직접 추출 vs OCR 구분**: PDF/HTML에서 추출 시도 → 텍스트 양으로 분기(위 4.1 로직).
- **판정 시점 캐싱**: URL을 키로 판정 결과를 유지, URL 변화 시에만 재판정.

## 9. 2인 분업 계획 (파이프라인 축)

두 사람을 **팝업창 기준**으로 나눈다. A는 팝업이 뜨기 전까지(창 선택·캡처·오버레이·모드·추출·좌표·클릭 감지), B는 팝업이 뜬 이후 전부(범위 확정·문맥 구성·질문·결과·설정)를 맡는다. **경계 = `ExtractedSelection`(A→B, 팝업 직전 추출 결과)와 `QuestionResult`(B→UI)**. 이 인터페이스를 가장 먼저 못박아 각자 목(mock)으로 병렬 개발한다.

### 담당 A — 선택 준비 & 추출 (팝업 전)
- 창 선택/화면 캡처(win32는 네이티브 우선·desktopCapturer 폴백, macOS는 창 목록에 desktopCapturer 그대로 사용), 오버레이 윈도우, 전역 단축키, 모드 전환.
- OCR 파이프라인(캡처→언어 감지→언어 특화 OCR→좌표 매핑) + 노이즈 제거.
- 소스별 직접 추출(txt/epub/PDF) + 접근성 API(AX/UIA)로 전자책 뷰어 렌더 텍스트 추출, OCR 여부 판정 로직·판정 시점 캐싱.
- 브라우저 확장(유튜브/넷플릭스 자막, 단어 하이라이트) + 앱과 로컬 WebSocket — 실제 구현은 자막 문맥 로직과의 결합도 때문에 담당 B로 이관됨(TODO.md 참고), DOM 텍스트(일반 웹페이지)는 A 영역으로 후속 예정(담당: milleion — 설계 방향·구현 상태는 TODO.md "DOM 텍스트(일반 웹페이지) 직접 추출" 항목 참고).
- 확장이 `chrome.tabs` API로 탭/URL 변화를 감지해 WS로 앱에 보고.
- 단어 hover 피드백·클릭 감지 → 팝업 트리거.
- **산출**: 클릭 시점의 `ExtractedSelection`(근방 텍스트 + 단어 좌표 + 클릭 기준점)을 B로 넘긴다(최종 선택 확정은 B가 팝업에서).

### 담당 B — 선택 확정 & 질문 (팝업 후)
- 팝업 내 범위 확정(영어=단어 / 일·중=문자, 클릭 vs 드래그) + 앞뒤 문맥 구성 → `SelectionContext` 생성.
- LLM 어댑터(GPT/Gemini/Claude 공통 인터페이스) + 채팅 세션·프롬프트 캐싱.
- 발음(맥락 발음), 사전 API 연동 + AI 뜻 번호 판정, 통합 질문·커스텀 질문 관리.
- 구글 검색 탭(발음/이미지), 팝업·채팅 UI.
- 설정 화면(언어·LLM·API 키·단축키·인근 텍스트 범위).
- **입력**: `ExtractedSelection`을 받아 팝업에서 선택 범위를 확정(`SelectionContext` 구성)한 뒤 `QuestionResult`(스트리밍)를 UI에 렌더.

### 인터페이스 계약 (A ↔ B, 최우선 확정)
```ts
interface SelectionSource {              // 출처 메타(캐싱·자막 추출용)
  kind: 'youtube' | 'netflix' | 'pdf' | 'txt' | 'epub' | 'web' | 'ocr';
  url?: string;
  appName?: string;
}

// A가 팝업 직전에 생성해 B로 전달 (팝업 전까지가 A 경계)
interface ExtractedSelection {
  text: string;                         // 클릭 지점 근방의 추출 텍스트(문맥 포함)
  words: { text: string; bbox?: Rect }[]; // 단어 분해(+화면 좌표)
  anchor: { start: number; end: number }; // 클릭 표현의 text 내 [start, end) = 팝업 초기 선택
  language: AnyLanguage;                // 감지 또는 지정된 언어(tier1+tier2, §2 참고)
  source: SelectionSource;
  extraction: 'direct' | 'ocr';         // 어떻게 뽑았는지
}

// B가 팝업에서 범위를 확정한 뒤 내부적으로 구성 (검색 함수 입력)
interface SelectionContext {
  selectedText: string;                 // 팝업에서 사용자가 최종 확정한 선택 범위
  language: AnyLanguage;
  fullText: string;                     // 원문 전체(트리밍 없음, ExtractedSelection.text 그대로)
  selStart: number;                     // selectedText 의 fullText 내 시작 오프셋
  selEnd: number;                       // selectedText 의 fullText 내 끝(exclusive) 오프셋
  words: { text: string; bbox?: Rect }[]; // 단어 분해(+화면 좌표)
  source: SelectionSource;
  extraction: 'direct' | 'ocr';
}
// 앞/뒤 문맥(precedingText/followingText)은 더 이상 SelectionContext 가 미리 잘라서
// 들고 있지 않는다 — 팝업 표시 범위(당시엔 바이트 창, 지금은 앞뒤 2줄 창)가 LLM 문맥
// 범위(설정의 contextBytesBefore/After)까지 제한해버리는 버그가 있었어서, fullText+
// selStart/selEnd 원문 좌표를 그대로 넘기고 LLM 어댑터(buildContextBlock)가 그때그때
// 설정값만큼 별도로 잘라 쓰도록 바꿨다(`fix: 1b7f0a1`).

// B가 반환해 UI로 (스트리밍 가능)
type QuestionRequest =
  | { type: 'pronunciation' }
  | { type: 'dictionary' }
  | { type: 'ask'; prompt: string; history?: ChatTurn[] };

interface QuestionResult {
  kind: 'pronunciation' | 'dictionary' | 'ask';
  content: string;                      // 렌더용 마크다운/텍스트(스트리밍 청크)
  error?: QuestionError;                // 있으면 실패 결과. UI가 성공/실패를 구분하는 기준
  meta?: Record<string, unknown>;       // 발음기호, 사전 뜻 번호 등
}

// API 키 미설정/무효, 사용 한도(크레딧) 소진 등 UI가 구분해 안내해야 하는 실패 종류
type QuestionErrorCode =
  | 'no_active_provider' | 'no_api_key' | 'invalid_api_key'
  | 'insufficient_credit' | 'rate_limited' | 'network_error' | 'unknown';

interface QuestionError {
  code: QuestionErrorCode;
  message: string;                      // 렌더링용 완성된 한국어 문장
  provider?: LlmProvider;
}
```
- **통합 지점**: IPC 채널 `selection:extracted`(A→B, `ExtractedSelection` 전달 = 팝업 트리거), `question:request`/`question:stream`(B, 팝업에서 확정한 `SelectionContext` 기반). 양측 목 구현으로 병렬 진행하다 이후 실연결.
- **공유 코드**: 타입 정의(`shared/types.ts`), IPC 유틸, 로거는 공동 소유.

## 10. 리스크 & 확장 로드맵

- **리스크**: OCR 정확도/속도, 접근성 API의 OS별 편차(Win UIA vs macOS AX), 넷플릭스 자막 추출의 취약성, LLM 비용. → 관통 경로(직접 추출)를 먼저 확보해 데모 안정성 보장.
- **확장**: 지원 언어 추가, 학습 이력·단어장, 발음 TTS, 모바일.

## 11. 프로젝트 구조 (스캐폴드)

**빌드**: electron-vite(Vite 기반, main/preload/renderer 3개 번들 관리) + React + TypeScript. 파이프라인 A/B를 디렉터리로 분리해 §9 분업 경계를 코드 구조에 반영했다. `src/shared`(타입·IPC 채널)는 공동 소유.

```text
JoJo/
├── package.json                 # electron-vite 스크립트(dev/build/preview)
├── package-lock.json            # 의존성 트리 고정(npm ci)
├── electron.vite.config.ts      # main/preload/renderer 빌드 + 경로 alias
├── electron-builder.yml         # 배포 패키징(appId/productName, dist:mac/win/linux)
├── tsconfig.json                # 공통 TS 설정(@shared/@main/@renderer)
├── .env.example                 # [dev] MAIN_VITE_* API 키 템플릿(.env는 gitignore)
├── src/
│   ├── env.d.ts                 #   import.meta.env(MAIN_VITE_*) 타입 선언
│   ├── shared/                  # 🤝 공동 소유 — 인터페이스 계약(§9)
│   │   ├── types.ts             #   SelectionContext / QuestionResult / 에러 · 설정 타입
│   │   ├── channels.ts          #   IPC 채널 상수
│   │   ├── languages.ts         #   언어별 정적 데이터 레지스트리(이름·구글 접미어 등)
│   │   ├── context.ts           #   문맥 범위 계산(computeContextRange, 문장 경계 확장)
│   │   ├── providers.ts         #   LLM provider 목록·표시명
│   │   ├── questionText.ts      #   발음/사전 버튼의 고정 질문 라벨
│   │   ├── wordMapping.ts       #   커서 좌표 ↔ 단어 bbox 매핑(findWordAtPoint)
│   │   └── nlp/                 #   일본어 형태소 병합 로직(main/renderer 양쪽에서 씀) — ja.ts(IPADIC, lindera 用) / ja-unidic.ts(UniDic, sudachi 用) 완전 분리(엔진 하나 걷어낼 때 해당 파일만 지우면 되게)
│   ├── main/                    # Electron 메인 프로세스
│   │   ├── index.ts             #   진입점(윈도우·IPC·단축키 등록, 일본어 형태소 분석 엔진 예열)
│   │   ├── windows.ts           #   메인(라우트 전환)/오버레이/팝업 윈도우 팩토리
│   │   ├── ipc.ts               #   🤝 IPC 허브(A→B 연결점)
│   │   ├── contextMenu.ts       #   🤝 모든 창 공통 OS 우클릭 메뉴
│   │   ├── tray.ts              #   🅰️ 트레이 아이콘(창 선택 해제/창 선택 전환/설정)
│   │   ├── keyStore.ts          #   [B] API 키 safeStorage 암호화 저장
│   │   ├── settingsStore.ts     #   [B] AppSettings 파일 영속화(userData/settings.json)
│   │   ├── frequentStore.ts     #   [B] 자주 쓰는 질문 영속화(userData/frequent.json)
│   │   ├── devSeed.ts           #   [dev] .env(MAIN_VITE_*) API 키 seed
│   │   ├── selection/          # 🅰️ 선택/추출 (담당 A)
│   │   │   ├── index.ts         #   선택 파이프라인 오케스트레이터
│   │   │   ├── shortcut.ts      #   모드 전환 전역 단축키(Alt+Q, macOS Cmd/Ctrl 이중 등록)
│   │   │   ├── capture.ts       #   창 목록/캡처 — win32는 네이티브 우선(desktopCapturer 폴백), macOS는 목록에 desktopCapturer·캡처는 screencapture -l + 선택 창 id 보관
│   │   │   ├── win32Capture.ts  #   Windows 네이티브 창 열거·캡처(koffi FFI, 가려짐/최소화 대응)
│   │   │   ├── macWindow.ts     #   macOS CoreGraphics/AppKit 바인딩(koffi) — bounds 조회·창 raise
│   │   │   ├── decideOcr.ts     #   OCR 사용 여부 판정(현재 파이프라인에선 미사용, 아래 참고)
│   │   │   ├── extractDirect.ts #   소스별 직접 추출 — txt(win32 전용) 구현, epub/pdf/web 미구현
│   │   │   ├── webSource.ts     #   일반 웹페이지 DOM 텍스트 direct 추출(범용 본문 탐지, 2026-07-30 구현 완료)
│   │   │   ├── subtitleSource.ts #  유튜브/넷플릭스 자막 direct 추출 + anchor 매칭
│   │   │   ├── extractionCache.ts # 선택 모드 진입 시 캡처+OCR 선행 캐싱(단일 슬롯)
│   │   │   ├── regionSelection.ts # OCR 대상 영역 드래그 지정(Windows/macOS)
│   │   │   ├── layoutDetect.ts  #   본문 영역 탐지(DocLayout-YOLO), 언어 감지 전 영역 선지정
│   │   │   ├── changeWatcher.ts # 지정 영역 픽셀 변화 감지 → 자동 재추출(Windows/macOS)
│   │   │   ├── inputHook.ts     #   Windows 저수준 입력 후크 — changeWatcher 오탐 필터(2026-07-29)
│   │   │   ├── macInput.ts      #   macOS 입력 감지(CGEventSourceSecondsSinceLastEventType) — inputHook.ts의 mac 대응
│   │   │   ├── ocr.ts           #   OCR 엔진 래퍼(Tesseract.js) + 일/중 단어 재분할 + 잘린 단어 제외
│   │   │   ├── ocrNdlocr.ts     #   일본어 전용 NDLOCR 엔진 래퍼
│   │   │   ├── ocrPaddle.ts     #   PaddleOCR 엔진 래퍼
│   │   │   ├── ocrYomitoku.ts   #   일본어 전용 Yomitoku 엔진 래퍼
│   │   │   ├── pythonServer.ts  #   NDLOCR/PaddleOCR/Yomitoku 등 python 상주 서버 공용 브릿지
│   │   │   ├── langDetect.ts    #   언어 자동 감지 — tier2 확장(2026-07-30) 대응 완료: OSD 스크립트 판별 + eld 재판별(§2 참고)
│   │   │   └── accessibility.ts #   접근성 API(AX/UIA) 브릿지 — readWindowText(Windows) 구현, readActiveWindow 미구현
│   │   ├── nlp/                 # 🤝 공동 소유 — 언어별 형태소 분석(OCR 단어 분리 + 팝업 atom 병합 공용)
│   │   │   ├── japanese.ts      #   일본어 엔진 디스패처 — JA_ENGINE 상수로 lindera/sudachi-b/sudachi-c 전환, tokenizeJapanese/segmentJapaneseWords 외부 계약은 엔진 무관 고정
│   │   │   ├── engines/         #   엔진별 구현 — ja: lindera.ts(WASM, IPADIC) / sudachi.ts(python 상주 서버, UniDic) · zh: jieba.ts(@node-rs/jieba, zh-Hans 고정) / intl-zh.ts(Intl.Segmenter) / chineseTokenizer.ts(CC-CEDICT 그리디)
│   │   │   ├── chinese.ts       #   중국어 엔진 디스패처 — zh-Hans는 jieba 고정, zh-Hant는 ZH_HANT_ENGINE 상수로 전환
│   │   │   └── chinese-tokenizer.d.ts # chinese-tokenizer 최소 타입 선언(공식 타입 없음)
│   │   └── question/           # 🅱️ 질문/AI (담당 B)
│   │       ├── index.ts         #   질문 라우터(발음/사전/통합질문)
│   │       ├── pronunciation.ts #   맥락 발음(IPA/히라가나/병음) — 구현 완료
│   │       ├── dictionary.ts    #   사전 API + AI 뜻 번호 판정 — 폴백 오케스트레이션 구현 완료(8개 소스)
│   │       ├── google.ts        #   구글 발음/이미지 검색 URL 생성
│   │       ├── naver.ts         #   언어별 네이버 사전(en/ja/zh) URL 생성
│   │       ├── browser.ts       #   URL을 기본 브라우저 새 창으로 열기(구글/네이버 공용)
│   │       ├── errors.ts        #   질문 에러 메시지 단일 출처(한국어 문장화)
│   │       ├── prompts/         #   프롬프트 자원
│   │       │   ├── system.txt        #   문맥 질문 시스템 프롬프트
│   │       │   ├── pronunciation.txt #   발음 질문 전용 시스템 프롬프트
│   │       │   └── template.ts       #   {{key}} 플레이스홀더 치환 유틸
│   │       └── llm/             #   LLM 공통 어댑터 ✅ 구현 완료
│   │           ├── adapter.ts   #   provider 추상화 + 문맥 프롬프트 + 스트리밍(streamLlm)
│   │           ├── validate.ts  #   무과금 GET으로 API 키 유효성·사용 가능 모델 목록 조회
│   │           ├── sse.ts       #   SSE 스트림 파서(공통)
│   │           ├── errors.ts    #   HTTP 상태코드 → QuestionErrorCode 분류
│   │           ├── gpt.ts       #   GPT
│   │           ├── gemini.ts    #   Gemini
│   │           └── claude.ts    #   Claude(프롬프트 캐싱 cache_control:ephemeral 적용)
│   ├── preload/
│   │   └── index.ts             #   🤝 contextBridge로 안전 API 노출
│   └── renderer/                # UI (React) — 공동, B 주도
│       ├── index.html
│       └── src/
│           ├── main.tsx, App.tsx        # 해시 라우팅(main/settings/popup/overlay/picker)
│           ├── navigate.ts              # 해시 라우트 이동 유틸
│           ├── env.d.ts                 # window.nuance(preload API) 타입 선언
│           ├── styles.css               # 테두리색(일반=파랑/선택=보라) 등
│           └── screens/
│               ├── MainScreen.tsx           # 창 선택 진입 + 선택 결과 표시 + 데모 팝업 버튼
│               ├── WindowPickerScreen.tsx   # [A] 창 목록 그리드(메인 창 재사용, 리사이즈 전환)
│               ├── SettingsScreen.tsx       # [B] LLM·키·단축키·Byte·언어(메인 창 재사용)
│               ├── PopupScreen.tsx          # [B] 원문·툴바·채팅·자주쓰는질문
│               ├── Overlay.tsx              # [A] 단어 하이라이트/커서 피드백/영역 드래그
│               ├── EditDeleteGroup.tsx      # 🤝 연필(수정)+휴지통(삭제) 공용 버튼 쌍
│               ├── icons.tsx                # 🤝 lucide-react 아이콘 재노출
│               └── popup/                   # [B] 팝업 화면 하위 컴포넌트·로직
│                   ├── ContextView.tsx      #   원문 문맥 표시 + 클릭/드래그 선택
│                   ├── Toolbar.tsx          #   구글/네이버 사전/발음/사전 버튼 툴바
│                   ├── Chat.tsx             #   채팅 말풍선 + 에러 배너 + 스트리밍 커서
│                   ├── FrequentQuestions.tsx#   자주 쓰는 질문 등록/수정/삭제/드래그 정렬
│                   ├── selection.ts         #   atom 분해(영/일/중) + SelectionContext 구성
│                   ├── mockSelection.ts     #   데모용 목업 ExtractedSelection(영/일/중)
│                   ├── frequentStore.ts     #   자주 쓰는 질문 렌더러측 얇은 IPC 래퍼
│                   └── types.ts             #   ChatMessage 등 팝업 전용 타입
└── extension/                   # 🅱️ 브라우저 확장(MV3) — 유튜브/넷플릭스 자막 구현 완료(담당 B로 이관)
    ├── manifest.json
    └── src/
        ├── background.ts        #   WS 브릿지 + 탭/URL 감지 + 확장↔content 메시지 중계
        ├── content.ts           #   화면 자막 hover/클릭 + 전체 자막 확보 결과 취합
        ├── youtube.ts / netflix.ts  # 사이트별 DOM 자막 추출
        ├── domWords.ts          #   공용 단어 좌표 유틸(CJK 글자 단위, 후리가나 제외)
        ├── wordSegments.ts      #   자막·본문 공용 CJK 형태소 분석 결과 캐시(pageParagraphText 요청/응답)
        ├── highlight.ts         #   hover 박스/클릭을 페이지 안에서 직접 렌더 — wordSegments.ts 캐시로 CJK 형태소 단위 hover
        ├── networkHook.ts / netflixNetworkHook.ts  # MAIN world 네트워크 가로채기(전체 자막 확보)
        ├── timedtext.ts / captionParse.ts          # videoId 파싱 / 자막 응답 포맷 파서
        ├── webArticle.ts        #   🅰️ [담당: milleion, 2026-07-30 구현 완료] 일반 웹페이지(뉴스·웹소설) 본문 DOM 추출 — 사이트별 셀렉터 등록 없이 범용 본문 탐지 알고리즘(텍스트 밀도 스코어링)
        └── articleHighlight.ts  #   🅰️ [담당: milleion] 본문 hover/클릭(highlight.ts와 같은 페이지 내 직접 처리 방식, 문단 단위 지연 계산으로 성능 대응) — wordSegments.ts 캐시로 CJK 형태소 단위 hover 연결(2026-07-30)
```

**시작 방법**: `npm install`(또는 `npm ci`) 후 `npm run dev`(electron-vite 개발 서버). 개발 중 LLM 키는 `.env`(`MAIN_VITE_*`)에 넣으면 `devSeed`가 keyStore에 주입한다. 확장은 `npm run build:ext`로 빌드한 `extension/dist`를 `chrome://extensions`에서 로드(개발자 모드 → 압축해제된 확장 프로그램 로드) — native messaging host 등록 불필요(로컬 WebSocket 사용).

**표기**: 🤝 공동 소유 / 🅰️ 담당 A / 🅱️ 담당 B. **현황**: 담당 B는 LLM 3종 어댑터·스트리밍·에러 체계·발음·사전(8개 소스 + 폴백 오케스트레이션)·팝업(채팅·자주쓰는질문)·설정 화면(5개 섹션)·브라우저 확장(유튜브·넷플릭스 자막)까지 구현 완료. 담당 A는 창 선택 UI·오버레이·전역 단축키·OCR 파이프라인(캡처→언어별 Tesseract/NDLOCR/PaddleOCR→일/중 형태소 재분할→좌표 매핑, macOS 캡처 포함)을 구현했고, DOM 텍스트(일반 웹페이지, 담당: milleion)도 2026-07-30 구현 완료(범용 본문 탐지+자막 경로와 동일한 확장 hover/클릭 direct 추출 구조, 상세는 TODO.md). 직접 추출(epub/pdf)·접근성 API(AX/UIA)는 아직 미구현. 언어 자동 감지(`langDetect.ts`)는 tier2 확장(2026-07-30)에 맞춰 구현 완료. 항목별 최신 진행 상황은 [TODO.md](TODO.md) 참고.
