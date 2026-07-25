# Nuance 구현 TODO

담당별 구현 체크리스트(작업의 단일 소스). 설계·인터페이스 계약은 [PLAN.md](PLAN.md) 참고 — §7(2인 분업 / 인터페이스 계약), §9(프로젝트 구조).

권장 순서: **뼈대 → 한 경로 end-to-end 관통 → 소스별 확장**. 첫 관통 경로는 가장 확실한 **PDF/텍스트 직접 추출 → 통합 질문**으로 잡고, 이후 OCR·자막·발음·사전을 붙인다.

## 목차

- [🅰️ 담당 A — 선택 & 추출](#a-담당)
  - [앱 · 윈도우 · 모드](#a-app)
  - [선택 · 좌표 매핑](#a-coord)
  - [추출 판정 · 실행](#a-extract)
  - [브라우저 확장 (MV3)](#a-ext)
- [🅱️ 담당 B — 질문 & AI](#b-담당)
  - [LLM 어댑터](#b-llm)
  - [질문 기능](#b-feature)
  - [UI · 설정](#b-ui)
- [🤝 공동](#공동)

<a id="a-담당"></a>

## 🅰️ 담당 A — 선택 & 추출

<a id="a-app"></a>

**앱 · 윈도우 · 모드**
- [ ] 창 선택 UI + `desktopCapturer` 창 목록/선택
- [ ] 선택된 창 테두리 색 표시 (일반=파랑 / 선택=보라)
- [ ] 백그라운드 실행 + 트레이 아이콘 (선택 해제 / 재선택 / 설정)
- [ ] 투명·클릭스루 오버레이 윈도우 (선택 창에 정렬 · 이동/리사이즈 추적)
- [ ] 모드 전환 전역 단축키(기본 Ctrl+1) + `MODE_CHANGED` 통지

<a id="a-coord"></a>

**선택 · 좌표 매핑**
- [ ] 단어 bbox 좌표 확보 → 커서 좌표 ↔ 단어 매핑
- [ ] hover 시 커서 모양 변경 + (확장) 단어 사각형 하이라이트
- [ ] 팝업 내 범위 지정: 영어=단어 / 일·중=문자 단위
- [ ] 클릭(단어) vs 드래그(범위) 구분 — mouseup 처리
- [ ] 앞뒤 문맥(preceding/following) 구성 → `SelectionContext` 생성·전달

<a id="a-extract"></a>

**추출 판정 · 실행**
- [ ] OCR 사용 여부 판정 (직접추출 우선, 텍스트 부족 시 OCR fallback)
- [ ] 판정 캐싱(URL 키): 모드 진입 시 1회 + URL 변화 시 재판정
- [ ] 창 재선택 시 선택 모드 자동 해제
- [ ] 직접 추출 파서: txt / epub / pdf + 좌표 매핑
- [ ] 접근성 API(AX/UIA)로 전자책 뷰어 렌더 텍스트 추출
- [ ] 언어 자동 감지 (유니코드 블록 기반 경량 분류)
- [ ] OCR 엔진 연동 (Tesseract.js ↔ 클라우드 벤치 후 결정) + 언어 특화
- [ ] 좌표 기반 노이즈 제거(제목·페이지번호) + 페이지 경계 문장 이어붙이기

<a id="a-ext"></a>

**브라우저 확장 (MV3)**
- [ ] 확장 번들 설정(vite/esbuild) + native messaging host 등록
- [ ] DOM 텍스트 추출(태그 제외 · 문단 잇기) + 좌표
- [ ] 유튜브 원어 자막 추출 (URL / timedtext)
- [ ] 넷플릭스 원어 자막 추출
- [ ] 선택 모드 단어 하이라이트 렌더
- [ ] 탭/URL 변화 감지 → 앱에 재판정 통지

<a id="b-담당"></a>

## 🅱️ 담당 B — 질문 & AI

<a id="b-llm"></a>

**LLM 어댑터**
- [x] ~~LLM 공통 어댑터 인터페이스 (provider 추상화)~~
- [x] ~~GPT / Gemini / Claude 클라이언트 구현 + 스트리밍~~
- [x] ~~어댑터가 `history: ChatTurn[]`을 받아 요청에 이어붙임 (`askLlm`/`buildRequest`, `llm/adapter.ts`)~~
- [x] ~~문맥 프롬프트 구성 + 프롬프트 캐싱(비용 절감)~~
- [x] ~~API 키 무효 / 크레딧(사용 한도) 소진 / 요청 과다 / 네트워크 오류를 구분하는 에러 체계 — `QuestionError`(`shared/types.ts`), `question/errors.ts`(메시지), `question/llm/errors.ts`(HTTP 상태코드 분류). UI 렌더링은 미구현(아래 UI 항목)~~
- [ ] provider별 실제 사용 모델 확정 — 현재 `DEFAULT_MODELS`(`llm/adapter.ts`)의 기본값은 gpt: `gpt-4o`, gemini: `gemini-pro-latest`, claude: `claude-sonnet-5`(모두 예시 placeholder, 확정 아님). 구현 시점에 모델을 고정할지, 설정 화면에서 사용자가 선택하게 할지 결정 필요
- [ ] 비용 고려사항 — 현재 `buildRequest()`가 `history` 전체를 매 요청마다 잘라내기/요약 없이 재전송함(`llm/adapter.ts`). 팝업 세션이 길어질수록 요청당 input 토큰이 선형 증가.
  - [ ] 대화 history 길이 제한 정책 결정 (예: 최근 N턴만 유지, 또는 초과 시 요약으로 압축)
  - [ ] 프롬프트 캐싱을 `cacheableContext`(선택 근방 문맥) 외에 대화 history에도 적용할지 검토 — 현재는 Claude의 `cache_control: ephemeral`도 문맥 블록에만 적용, history 메시지 배열은 캐싱 대상 아님
  - [ ] GPT/Gemini에도 캐싱 연동 검토 — 현재 캐시 제어는 Claude 클라이언트에만 구현됨. GPT는 prefix 자동 캐싱(별도 API 불필요, prefix 안정성 필요), Gemini는 명시적 context caching API(`cachedContents`) 필요
  - [ ] provider별 요청당 비용 추정치 산정 + 설정 화면에 예상 비용/사용량 노출 여부 결정

<a id="b-feature"></a>

**질문 기능**
- [ ] 발음: IPA / 히라가나 / 병음 + 맥락 의존 발음 판정
- [ ] 사전: 언어별 사전 API + 단어 분해 + LLM 뜻 번호 매핑
  - [ ] 언어별 사전 API 소스 확정 필요 — 예: 영어(Free Dictionary API / Merriam-Webster / WordsAPI), 일본어(Jisho API 등 JMdict 기반), 중국어(CC-CEDICT 기반 API 등). 무료/과금 여부·rate limit·라이선스 확인 후 선택
- [ ] 통합 질문: 자유 프롬프트 입출력
- [ ] 자주 쓰는 질문: 등록 / 수정 / 삭제 + 영속화
- [ ] 구글 검색: 발음 웹탭 / 이미지탭 (팝업 속 팝업)

<a id="b-ui"></a>

**UI · 설정**
- [ ] 팝업 화면: 원문 + 툴바(발음·사전 체크박스 / 입력 / 구글) + 채팅 + 자주쓰는질문
- [ ] 채팅 세션 상태 유지 — 팝업 = 1세션, `ChatTurn[]`을 누적하며 `askLlm` 호출 시 함께 전달(어댑터는 완료, 상태 보관·갱신은 미구현)
- [ ] 발음·사전 체크박스 토글 동작
- [ ] 스트리밍 렌더 (`QUESTION_STREAM` 수신)
- [ ] 에러 배너/토스트 — `QuestionResult.error` 존재 시 `error.code`별로 안내(재시도 버튼, 설정으로 이동 등). 메시지 문구·분류 로직은 완료(`question/errors.ts`), 렌더링만 미구현
- [ ] 설정 화면 5개 섹션: LLM 선택 / API 키(입력·보기·수정·삭제) / 단축키 / Byte 슬라이더+미리보기 / 언어
- [ ] API 키 `safeStorage` 암호화 저장·로드 영속화
- [ ] 앱 설정 영속화 (파일 저장)

<a id="공동"></a>

## 🤝 공동
- [ ] `SelectionContext` / `QuestionResult` + IPC 채널 확정 (스텁 완료 → 실연결)
- [ ] IPC 허브 A→B 실연결
- [ ] 첫 관통 경로: PDF 직접추출 → 통합 질문
- [ ] `npm install` + `electron-vite dev` 빌드 정상화
  - [x] ~~koffi를 optionalDependencies로 이동 — 맥에서 네이티브 빌드 실패해도 install 유지 (`fix: 969d08f`)~~
  - [ ] npm optional-deps 버그(npm/cli#4828)로 `@rollup/rollup-darwin-arm64` 누락 시: `node_modules`+`package-lock.json` 삭제 후 재설치 (온보딩 메모 필요)
- [ ] 크로스플랫폼(Win / Mac) 동작 점검
  - [x] ~~맥(arm64) 부팅 확인 — win32Capture(koffi)를 동적 import로 격리해 맥에선 미로드, `npm run dev` 정상 기동 (`fix: 969d08f`). 맥은 desktopCapturer 경로 사용(창 목록 실사용엔 화면 기록 권한 필요)~~
  - [ ] Windows 재확인 — win32Capture가 static→동적 import로 바뀌어 Windows 창 목록/캡처 정상 동작 재점검 필요
- [ ] 언어 확장성 — 현재 영/일/중만 지원(PLAN.md §1), 추후 언어 추가를 대비한 구조.
  - [x] ~~`@shared/languages.ts`에 언어별 정적 데이터(이름, 구글 검색 접미어 등) 단일 레지스트리 도입. `Language` 유니온에 언어를 추가하면 `Record<Language, ...>` 사용처가 컴파일 에러로 누락을 알려줌(`question/llm/adapter.ts`, `question/google.ts` 적용 완료)~~
  - [ ] (담당 A) OCR 언어 감지/언어팩을 이 레지스트리와 연동하거나 별도 레지스트리로 통일 (`selection/langDetect.ts`, `selection/ocr.ts`)
  - [ ] (담당 B) 설정 화면 언어 선택지, 언어별 사전 API 소스, 발음 표기 체계(IPA/히라가나/병음 등 — 언어마다 표기 체계 자체가 다름, 데이터 하나로 단순 확장 안 됨) 설계 시 레지스트리 패턴 반영
