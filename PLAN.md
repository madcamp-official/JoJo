# Nuance — 외국어 콘텐츠 소비 보조 프로그램 · 기획서

## 목차

1. [개요](#1-개요)
2. [대상 콘텐츠](#2-대상-콘텐츠)
3. [사용 흐름](#3-사용-흐름)
4. [핵심 기능](#4-핵심-기능)
5. [기술 아키텍처](#5-기술-아키텍처)
6. [까다로운 부분 & 해결 전략](#6-까다로운-부분--해결-전략)
7. [2인 분업 계획 (파이프라인 축)](#7-2인-분업-계획-파이프라인-축)
8. [리스크 & 확장 로드맵](#8-리스크--확장-로드맵)
9. [프로젝트 구조 (스캐폴드)](#9-프로젝트-구조-스캐폴드)

## 1. 개요

**한 줄 소개**: 화면 위 어떤 외국어 텍스트든 클릭 한 번으로, 그 맥락에 맞는 발음·뜻·뉘앙스를 즉시 알려주는 데스크톱 오버레이 도구.

**문제의식**: 외국어 원서·영상·웹소설·만화를 소비할 때, 모르는 표현을 만나면 뷰어를 벗어나 사전/번역기로 이동해야 하고, 사전은 그 **문맥 속 의미**를 짚어주지 못한다. `read`의 발음, `後`의 독음, 어떤 뜻으로 쓰였는지는 문맥이 있어야 안다.

**목표**: 사용자가 보고 있는 창 위에 투명 오버레이를 띄워, 콘텐츠를 벗어나지 않고 단어를 클릭 → 문맥 인지형 LLM 답변을 받는 경험을 제공한다. 텍스트를 직접 추출할 수 있으면 추출하고, 불가능하면(스캔본·이미지 전자책) OCR로 대응한다.

**지원 범위**: 한국어 모어 화자 대상 / 영어·일본어·중국어 지원(추후 확장) / Windows·macOS.

## 2. 대상 콘텐츠

| 채널 | 대상 | 텍스트 확보 방식 |
|------|------|------------------|
| 데스크톱 | txt/epub 뷰어 | 원본 파일 직접 추출 |
| 데스크톱 | PDF 뷰어 | 추출 시도 → 텍스트 양으로 판정(적으면 OCR) |
| 데스크톱 | Kindle/Apple Books(전자책 뷰어) | 접근성 API로 렌더 텍스트 추출 시도 → 실패 시 OCR |
| 데스크톱 | 스캔 소설·만화 | OCR |
| 브라우저 | 유튜브 | URL 기반 원어 자막 추출 |
| 브라우저 | 넷플릭스 | 확장 프로그램으로 현재 에피소드 원어 자막 추출 |
| 브라우저 | 웹소설·웹툰·일반 웹페이지 | 확장으로 DOM 텍스트 추출 → 부족하면 OCR |

## 3. 사용 흐름

1. **실행** → 중앙에 큰 [창 선택] 버튼 + 우측 상단 작은 [설정] 아이콘.
2. **창 선택** (Zoom 화면공유처럼 창 목록에서 선택) → 앱이 해당 창 화면을 볼 수 있음 → 백그라운드 실행.
   - 선택된 창 테두리 색 표시: **일반 모드 = 파란색 / 선택 모드 = 보라색**.
   - 백그라운드 아이콘 클릭 시: 창 선택 해제 / 창 선택 전환 / 설정.
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

**팝업 화면**: 상단에 선택된 원문 문맥 표시(선택 앞뒤 각 256바이트, 문장 경계까지 확장·부족하면 있는 만큼만, 내부 스크롤 없이 텍스트 양만큼 높이 자동 확장) → 툴바(구글 로고 + [발음 검색]·[시각 자료 검색] · 네이버 로고 + [사전](언어별 en/ja/zh 사전 페이지를 새 브라우저 창으로 여는 바로가기, LLM 뜻 번호 판정과는 별개) · LLM 배지 · [발음]·[사전 검색] 원샷 버튼, 구글·네이버 로고도 LLM 배지와 동일한 배지 스타일로 배치) → AI 채팅 영역(질문/답변 말풍선 + "궁금한 내용을 입력하세요…" 입력창 — 통합 질문은 여기서 입력) → 하단 "자주 쓰는 질문" 목록(각 항목 [수정], 드래그로 순서 변경; 예: 문법적 역할 / 문맥 속 의미 / 격식·객관 표현 여부). 창 크기는 설정 화면과 동일, 라이트 테마.

## 4. 핵심 기능

### 4.1 선택 (Selection Pipeline)

**모드 전환**
- 선택 모드 진입 시 포커스된 창 위로 클릭스루 가능한 투명 오버레이 윈도우를 띄운다.
- 텍스트 영역 클릭 → 근방 텍스트 팝업. 텍스트 외 영역 클릭 → 일반 클릭으로 통과.

**단어 감지 & 시각 피드백**
- 각 단어의 화면 좌표(bounding box)를 확보 → 커서 좌표가 어느 단어에 해당하는지 판정.
- 선택 가능한 단어 위에 커서가 오면 커서 모양 변경. 브라우저(확장 있음)에서는 단어 주변에 사각형 하이라이트.
- OCR로 뽑은 일본어·중국어는 Tesseract 자체 단어 경계 대신, 줄 단위로 다시 형태소 분석기(일: kuromoji, 중: segmentit)를 돌려 의미 단위 단어로 재구성한다(`main/nlp/`). 각 단어 bbox는 가로(x)만 구성 글자(symbol)들의 bbox를 합쳐(union) 계산하고, 세로(y)는 기존과 동일하게 줄(line) 전체 bbox를 쓴다(같은 줄 단어들의 높이를 통일하기 위해서 — §4.1 다른 OCR 단어 높이 처리와 동일한 이유).

**팝업 내 범위 지정 (최소 단위)**
- 영어: 단어(공백 구분) 단위.
- 중국어(한자): 문자 단위 세밀 선택 — 원하는 한 글자만 골라 선택 가능.
- 일본어: 한자는 문자 단위, 가나가 섞이면 kuromoji 품사 태그 기반으로 의미 단위 병합 — 조사(助詞)는 항상 독립 선택 단위, 조동사·활용어미(助動詞)는 앞 글자에 붙여 동사 어간+어미를 하나로 취급(예: "渡った" → 渡 / った). kuromoji 사전 로드가 끝나기 전 짧은 순간만 Intl.Segmenter 기반 근사치로 대체.
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

### 4.2 질문 (Question Pipeline)

**LLM 채팅 팝업** (GPT / Gemini / Claude 선택)
- 하나의 팝업 = 하나의 대화 세션. 후속 질문이 이전 답변 맥락을 이어감.
- 인근 텍스트(설정 범위)를 문맥으로 함께 전달. 전체 맥락 텍스트는 **프롬프트 캐싱**으로 비용 절감 — 현재 Claude 어댑터에 `cache_control: ephemeral`으로 구현되어 있고, GPT/Gemini는 아직 미적용(TODO.md §미해결 문제 "LLM 비용 고려사항" 참고).
- 팝업 툴바에서 **발음·사전 검색은 누르면 즉시 질문이 전송되는 원샷 버튼**([발음]/[사전 검색]), **구글 검색은 별도 버튼**([발음 검색]/[시각 자료 검색])으로 구성하고, **통합 질문은 툴바가 아니라 그 아래 AI 채팅 영역의 입력창**에서 입력한다(§3 화면 구성 참고).

1. **발음** — 선택 텍스트의 발음기호(영: IPA / 일: 히라가나 / 중: 한어병음). **맥락 의존 발음**을 반영: `read`(현재/과거), `associate`(명·형/동), `後`(あと·ご·のち), `人気`(にんき·ひとけ), `得`(de·dé·děi), `行`(xíng·háng). 지역별 발음이 여러 개면 `[미국]`/`[영국]`(영어), `[대륙]`/`[대만]`(중국어) 순으로 대괄호 라벨을 붙여 병기하고, 근거는 의미 중의성을 판정해 발음을 좁힌 경우에만 표시(단순 지역·격식 변이면 생략). 형식이 고정된 판정 작업이라 LLM 호출 시 temperature를 낮게 고정.
2. **사전 검색** — 선택 영역을 단어 단위 분해 → 사전 API로 각 단어 정보 획득 → 문맥과 함께 LLM에 전달 → LLM이 **해당 맥락에서 사전상 몇 번 뜻인지** 판정.
3. **통합 질문** — 자유 프롬프트. 자주 쓰는 질문을 사용자가 커스텀 등록·수정·삭제(예: 문맥 속 의미 / 문법적 역할 / 격식도·어투·뉘앙스 / 문장 구조).

**구글 검색** (외부 브라우저 새 창 — 임베드형 팝업 속 팝업은 채택하지 않음)
- 발음: "선택 텍스트 + pronunciation/読み方/拼音" 구글 웹 탭.
- 시각 자료: 선택 텍스트 구글 이미지 탭.
- 이미 떠 있는 브라우저의 새 탭이 아니라 새 창으로 뜨도록, 기본 브라우저를 감지해 브라우저별로 새 창 옵션을 지정해 연다(Chromium/Firefox: `--new-window`, Safari: AppleScript, Windows는 레지스트리로 기본 브라우저 탐지 — 감지 실패 시에만 `shell.openExternal` 폴백).

## 5. 기술 아키텍처

**전 구간 TypeScript 단일 언어**로 두 사람의 코드 이동 비용을 낮춘다. 구성 요소별 스택:

- **앱**: Electron(메인 = Node, 렌더러·오버레이 = 웹) + TypeScript + React(렌더러 UI).
- **캡처/오버레이**: 창 열거·캡처는 Windows 네이티브 win32(user32/gdi32/dwmapi, `koffi` FFI 바인딩)를 우선 사용(가려진/최소화된 창까지 캡처, `desktopCapturer`는 win32 네이티브 열거가 실패했을 때만 쓰는 최종 폴백). macOS는 창 "목록"엔 `desktopCapturer`(현재 가상 데스크탑/Space에 보이는 창만)를 그대로 쓴다 — 다른 Space의 창까지 열거하는 확장을 시도했으나(`CGWindowListCopyWindowInfo`를 `kCGWindowListExcludeDesktopElements`로 직접 호출) 목록이 지저분해지는 등 UX가 나빠져 원복했다(TODO.md 참고). 테두리 정렬·창 raise는 macOS도 CoreGraphics/AppKit을 `koffi`로 직접 바인딩(`main/selection/macWindow.ts`)해서 하고, 실제 화면 캡처엔 내장 `screencapture -l<windowID>`를 사용. koffi FFI는 Windows 전용이 아니라 두 플랫폼 모두에서 쓰인다. 투명·클릭스루 BrowserWindow, `globalShortcut`.
- **OCR**: Tesseract.js(로컬) 또는 클라우드 OCR(정확도 우선 시) — 벤치 후 결정. 중국어는 `chi_sim+chi_tra` 언어팩을 함께 로드해 간체/번체를 자동 판별. 일/중 단어 경계는 OCR 결과를 kuromoji/segmentit(`main/nlp/`)로 재분할해 의미 단위로 맞춘다.
- **확장**: 브라우저 확장(Manifest V3) + native messaging.
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

    EXT -- "native messaging" --> MAIN
    MAIN --> PA
    MAIN --> PB
    MAIN --> OVL
    PA -- "ExtractedSelection" --> PB
    PB -- "QuestionResult" --> POP
    PB -- "API 호출" --> SVC
```

## 6. 까다로운 부분 & 해결 전략


- **OCR 노이즈 제거**: 소설 제목·페이지 번호 등 불필요 텍스트를 **좌표 기반 규칙**(위치·반복성·정렬)으로 필터링 후 저장. 페이지 경계에 걸린 문장은 앞뒤 조각을 자연스럽게 이어붙임.
- **HTML 문단 잇기**: 태그는 제외하고 내부 텍스트만 이어 자연스러운 문단 구성.
- **직접 추출 vs OCR 구분**: PDF/HTML에서 추출 시도 → 텍스트 양으로 분기(위 4.1 로직).
- **판정 시점 캐싱**: URL을 키로 판정 결과를 유지, URL 변화 시에만 재판정.

## 7. 2인 분업 계획 (파이프라인 축)

두 사람을 **팝업창 기준**으로 나눈다. A는 팝업이 뜨기 전까지(창 선택·캡처·오버레이·모드·추출·좌표·클릭 감지), B는 팝업이 뜬 이후 전부(범위 확정·문맥 구성·질문·결과·설정)를 맡는다. **경계 = `ExtractedSelection`(A→B, 팝업 직전 추출 결과)와 `QuestionResult`(B→UI)**. 이 인터페이스를 가장 먼저 못박아 각자 목(mock)으로 병렬 개발한다.

### 담당 A — 선택 준비 & 추출 (팝업 전)
- 창 선택/화면 캡처(win32는 네이티브 우선·desktopCapturer 폴백, macOS는 창 목록에 desktopCapturer 그대로 사용), 오버레이 윈도우, 전역 단축키, 모드 전환.
- OCR 파이프라인(캡처→언어 감지→언어 특화 OCR→좌표 매핑) + 노이즈 제거.
- 소스별 직접 추출(txt/epub/PDF) + 접근성 API(AX/UIA)로 전자책 뷰어 렌더 텍스트 추출, OCR 여부 판정 로직·판정 시점 캐싱.
- 브라우저 확장(DOM 텍스트, 유튜브/넷플릭스 자막, 단어 하이라이트) + 앱과 native messaging.
- 접근성 API로 탭/URL 변화 감지.
- 단어 hover 피드백·클릭 감지 → 팝업 트리거.
- **산출**: 클릭 시점의 `ExtractedSelection`(근방 텍스트 + 단어 좌표 + 클릭 기준점)을 B로 넘긴다(최종 선택 확정은 B가 팝업에서).

### 담당 B — 선택 확정 & 질문 (팝업 후)
- 팝업 내 범위 확정(영어=단어 / 일·중=문자, 클릭 vs 드래그) + 앞뒤 문맥 구성 → `SelectionContext` 생성.
- LLM 어댑터(GPT/Gemini/Claude 공통 인터페이스) + 채팅 세션·프롬프트 캐싱.
- 발음(맥락 발음), 사전 API 연동 + LLM 뜻 번호 판정, 통합 질문·커스텀 질문 관리.
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
  language: 'en' | 'ja' | 'zh';         // 감지 또는 지정된 언어
  source: SelectionSource;
  extraction: 'direct' | 'ocr';         // 어떻게 뽑았는지
}

// B가 팝업에서 범위를 확정한 뒤 내부적으로 구성 (검색 함수 입력)
interface SelectionContext {
  selectedText: string;                 // 팝업에서 사용자가 최종 확정한 선택 범위
  language: 'en' | 'ja' | 'zh';
  fullText: string;                     // 원문 전체(트리밍 없음, ExtractedSelection.text 그대로)
  selStart: number;                     // selectedText 의 fullText 내 시작 오프셋
  selEnd: number;                       // selectedText 의 fullText 내 끝(exclusive) 오프셋
  words: { text: string; bbox?: Rect }[]; // 단어 분해(+화면 좌표)
  source: SelectionSource;
  extraction: 'direct' | 'ocr';
}
// 앞/뒤 문맥(precedingText/followingText)은 더 이상 SelectionContext 가 미리 잘라서
// 들고 있지 않는다 — 팝업 표시 범위(256바이트 창)가 LLM 문맥 범위(설정의
// contextBytesBefore/After)까지 제한해버리는 버그가 있었어서, fullText+selStart/selEnd
// 원문 좌표를 그대로 넘기고 LLM 어댑터(buildContextBlock)가 그때그때 설정값만큼
// 별도로 잘라 쓰도록 바꿨다(`fix: 1b7f0a1`).

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

## 8. 리스크 & 확장 로드맵

- **리스크**: OCR 정확도/속도, 접근성 API의 OS별 편차(Win UIA vs macOS AX), 넷플릭스 자막 추출의 취약성, LLM 비용. → 관통 경로(직접 추출)를 먼저 확보해 데모 안정성 보장.
- **확장**: 지원 언어 추가, 학습 이력·단어장, 발음 TTS, 모바일.

## 9. 프로젝트 구조 (스캐폴드)

**빌드**: electron-vite(Vite 기반, main/preload/renderer 3개 번들 관리) + React + TypeScript. 파이프라인 A/B를 디렉터리로 분리해 §7 분업 경계를 코드 구조에 반영했다. `src/shared`(타입·IPC 채널)는 공동 소유.

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
│   ├── shared/                  # 🤝 공동 소유 — 인터페이스 계약(§7)
│   │   ├── types.ts             #   SelectionContext / QuestionResult / 에러 · 설정 타입
│   │   ├── channels.ts          #   IPC 채널 상수
│   │   ├── languages.ts         #   언어별 정적 데이터 레지스트리(이름·구글 접미어 등)
│   │   ├── context.ts           #   문맥 범위 계산(computeContextRange, 문장 경계 확장)
│   │   ├── providers.ts         #   LLM provider 목록·표시명
│   │   ├── questionText.ts      #   발음/사전 버튼의 고정 질문 라벨
│   │   └── wordMapping.ts       #   커서 좌표 ↔ 단어 bbox 매핑(findWordAtPoint)
│   ├── main/                    # Electron 메인 프로세스
│   │   ├── index.ts             #   진입점(윈도우·IPC·단축키 등록, kuromoji 예열)
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
│   │   │   ├── extractionCache.ts # 선택 모드 진입 시 캡처+OCR 선행 캐싱(단일 슬롯)
│   │   │   ├── regionSelection.ts # OCR 대상 영역 드래그 지정(Windows/macOS)
│   │   │   ├── changeWatcher.ts # 지정 영역 픽셀 변화 감지 → 자동 재추출(Windows/macOS)
│   │   │   ├── ocr.ts           #   OCR 엔진 래퍼(Tesseract.js) + 일/중 단어 재분할 + 잘린 단어 제외
│   │   │   ├── langDetect.ts    #   언어 자동 감지 — 현재 스텁(항상 'en' 반환)
│   │   │   └── accessibility.ts #   접근성 API(AX/UIA) 브릿지 — 미구현(not implemented)
│   │   ├── nlp/                 # 🤝 공동 소유 — 언어별 형태소 분석(OCR 단어 분리 + 팝업 atom 병합 공용)
│   │   │   ├── japanese.ts      #   kuromoji(IPADIC) 래퍼 — tokenizeJapanese/segmentJapaneseWords
│   │   │   ├── chinese.ts       #   segmentit(jieba 스타일) 래퍼 — segmentChineseWords
│   │   │   └── segmentit.d.ts   #   segmentit 최소 타입 선언(공식 타입 없음)
│   │   └── question/           # 🅱️ 질문/AI (담당 B)
│   │       ├── index.ts         #   질문 라우터(발음/사전/통합질문)
│   │       ├── pronunciation.ts #   맥락 발음(IPA/히라가나/병음) — 구현 완료
│   │       ├── dictionary.ts    #   사전 API + LLM 뜻 번호 판정 — 스텁(빈 문자열 반환)
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
└── extension/                   # 🅰️ 브라우저 확장(MV3) — 담당 A, 전혀 미구현
    ├── manifest.json
    └── src/
        ├── background.ts        #   native messaging 브릿지 + 탭/URL 감지(TODO만 존재)
        └── content.ts           #   DOM 텍스트·자막 추출 + 하이라이트(TODO만 존재)
```

**시작 방법**: `npm install`(또는 `npm ci`) 후 `npm run dev`(electron-vite 개발 서버). 개발 중 LLM 키는 `.env`(`MAIN_VITE_*`)에 넣으면 `devSeed`가 keyStore에 주입한다. 확장은 `chrome://extensions`에서 `extension/`을 로드하고 native messaging host를 등록해야 함(추후 번들러 설정 TODO).

**표기**: 🤝 공동 소유 / 🅰️ 담당 A / 🅱️ 담당 B. **현황**: 담당 B는 LLM 3종 어댑터·스트리밍·에러 체계·발음·팝업(채팅·자주쓰는질문)·설정 화면(5개 섹션)까지 구현 완료, 사전 기능만 스텁. 담당 A는 창 선택 UI·오버레이·전역 단축키·OCR 파이프라인(캡처→언어별 Tesseract→일/중 형태소 재분할→좌표 매핑, macOS 캡처 포함)을 구현했고, 직접 추출(epub/pdf/web)·접근성 API(AX/UIA)·언어 자동 감지·브라우저 확장은 아직 미구현/스텁. 항목별 최신 진행 상황은 [TODO.md](TODO.md) 참고.
