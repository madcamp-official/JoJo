# Nuance 구현 TODO

담당별 구현 체크리스트(작업의 단일 소스). **분업 경계 = 팝업창**: A는 팝업이 뜨기 전까지의 로직(창 선택·캡처·오버레이·모드·텍스트 추출·단어 좌표·클릭 감지), B는 팝업이 뜬 이후의 모든 로직(팝업 내 범위 확정·문맥 구성·발음/사전/질문·결과 렌더·설정 화면)을 담당한다. 설계·인터페이스 계약은 [PLAN.md](PLAN.md) 참고 — §7(2인 분업 / 인터페이스 계약), §9(프로젝트 구조).

권장 순서: **뼈대 → 한 경로 end-to-end 관통 → 소스별 확장**. 첫 관통 경로는 가장 확실한 **PDF/텍스트 직접 추출 → 통합 질문**으로 잡고, 이후 OCR·자막·발음·사전을 붙인다.

## 목차

- [🅰️ 담당 A — 선택 준비 & 추출 (팝업 전)](#a-담당)
  - [앱 · 윈도우 · 모드](#a-app)
  - [단어 감지 · 좌표 매핑 (오버레이)](#a-coord)
  - [추출 판정 · 실행](#a-extract)
  - [브라우저 확장 (MV3)](#a-ext)
- [🅱️ 담당 B — 선택 확정 & 질문 (팝업 후)](#b-담당)
  - [팝업 선택 & 문맥 확정](#b-select)
  - [LLM 어댑터](#b-llm)
  - [질문 기능](#b-feature)
  - [UI · 설정](#b-ui)
- [🤝 공동](#공동)
- [⚠️ 미해결 문제](#미해결-문제)

<a id="a-담당"></a>

## 🅰️ 담당 A — 선택 준비 & 추출 (팝업 전)

<a id="a-app"></a>

**앱 · 윈도우 · 모드**
- [x] 창 선택 UI + `desktopCapturer` 창 목록/선택
- [x] 선택된 창 테두리 색 표시 (일반=파랑 / 선택=보라) — Windows: 대상 창에 정렬+실시간 추적. **macOS: 구현됨** — `showMacSelectionOverlay`(`windows.ts`)가 CoreGraphics `CGWindowListCopyWindowInfo`(koffi, `selection/macWindow.ts`)로 desktopCapturer window id 의 실제 bounds 를 얻어 테두리를 정렬하고, 저빈도 폴링(150ms)으로 이동/리사이즈를 따라간다(win32 폴백 폴링과 동일 개념). bounds 를 못 구하면 주 디스플레이 전체 테두리로 폴백. **추가 권한 프롬프트 없음**(창 geometry 조회는 권한 불필요, 창 목록엔 이미 화면기록 권한 사용). osascript(자동화 권한) 방식은 unsigned dev 앱에서 프롬프트가 안 떠 폐기.
- [x] 백그라운드 실행 + 트레이 아이콘 (선택 해제 / 재선택 / 설정)
- [x] 투명·클릭스루 오버레이 윈도우 (선택 창에 정렬 · 이동/리사이즈 추적) — Windows: WinEventHook + 폴백 폴링. macOS: CGWindowList bounds 폴링(150ms)으로 정렬+이동/리사이즈 추적(win32 는 즉시 반응 훅까지 있고 mac 은 폴링만이라 반응이 약간 느릴 수 있음)
- [x] 창 선택 시 대상 창 맨 앞으로 — Windows: `bringWindowToForeground`(win32Capture). macOS: 창의 owner PID(CGWindowList)로 `NSRunningApplication.activateWithOptions:`(objc, koffi, `selection/macWindow.ts`). raise 가 실패해도 테두리/추적은 정상 동작(try/catch 로 degrade). CoreGraphics/objc 네이티브 바인딩은 실기기(맥 arm64)에서 bounds·PID 조회·클래스 로드까지 검증됨.
- [x] 모드 전환 전역 단축키(기본 Alt+Q) + `MODE_CHANGED` 통지

<a id="a-coord"></a>

**단어 감지 · 좌표 매핑 (오버레이)**
- [x] 단어 bbox 좌표 확보 → 커서 좌표 ↔ 단어 매핑 — 매핑 로직(`shared/wordMapping.ts: findWordAtPoint`)·오버레이·OCR 파이프라인이 실 데이터로 완전히 연결됨. 선택 모드 진입 시 캐시된 OCR 결과(`extractionCache.ts`)의 단어 bbox를 메인→오버레이로 IPC 통지(`windows.ts: sendOverlayWords`, `preload: onExtractionWords`)해서 `Overlay.tsx`가 **실제 단어 위치**로 hover/클릭 판정을 한다(`MOCK_WORDS` 자리표시자는 제거됨). bbox 정확도를 위해 두 가지 보정을 적용: (1) 물리 픽셀(캡처·OCR) → DIP(오버레이 렌더링) 배율 보정(`windows.ts: getPhysicalToDipScale`) — 디스플레이 배율 100% 아닐 때 어긋나는 문제, (2) 캡처 좌표계(`GetWindowRect`, 안 보이는 리사이즈 테두리 포함) ↔ 오버레이 좌표계(`DWMWA_EXTENDED_FRAME_BOUNDS`, 실제 보이는 프레임) 원점 차이 보정(`win32Capture.ts: getCaptureOriginOffset`). 단어 박스 높이는 단어 자체 bbox 대신 그 단어가 속한 줄(line) bbox 를 써서 같은 줄 단어들의 높이를 통일함(`ocr.ts`). 화면에 그리는 박스는 hover 판정용 bbox 와 별개로 왼쪽에 2px 시각적 여백을 둬서 글자 획(L/T/I 등)과 테두리가 안 겹치게 함(`Overlay.tsx: WORD_BOX_PADDING`).
- [x] hover 시 커서 모양 변경 — **데스크톱 커서 모양만 구현**, 실제 단어 bbox 기준으로 동작(`windows.ts: setOverlayInteractive`가 실제 텍스트 위에서만 클릭스루 해제 → CSS `cursor: pointer` 반영 + 보라 박스 표시). ~~(확장) 단어 사각형 하이라이트~~는 PLAN.md상 브라우저 확장(extension/) 쪽 기능인데, 확장이 아직 전혀 구현 안 된 상태(native messaging 등 기반 자체가 없음)라 의도적으로 건너뜀 — 확장 작업 시작할 때 별도로 처리 필요.
- [x] 단어 클릭 감지 → 팝업 트리거 (팝업 직전까지가 A 경계) — `Overlay.tsx`가 선택 모드 동안 오버레이를 인터랙티브 상태로 두고(현재는 텍스트 위에서만, 위 항목 참고) 클릭 시 `extractSelection(point)` 호출, `ipc.ts`의 `SELECTION_EXTRACTED` 핸들러가 결과로 바로 `createPopupWindow()`를 호출해 팝업을 연다.
- [x] 산출: 근방 추출 텍스트 + 단어 좌표 + 클릭 기준점을 B로 전달 (최종 선택 확정은 B가 팝업에서 수행) — `runSelectionPipeline`(`selection/index.ts`)이 캐시된 추출 결과에서 클릭 좌표에 해당하는 단어를 찾아 `ExtractedSelection`(`text`+`anchor`+`words`+`source`+`extraction`)을 만들어 B(`PopupScreen.tsx`)로 전달. 단, 앞뒤 문맥(`text`) 자체는 페이지 전체가 아니라 OCR/캡처 단위(현재 화면에 보이는 범위)로 한정됨 — 스크롤되어 화면 밖에 있는 텍스트는 애초에 캡처되지 않아 문맥에 포함 안 됨.

<a id="a-extract"></a>

**추출 판정 · 실행**
- [x] ~~OCR 사용 여부 판정~~ → **구현은 됐지만 지금 파이프라인에서는 미사용으로 보류**. `decideOcr.ts`(`decideExtraction`)가 접근성 텍스트(`accessibility.ts: readWindowText`, 표준 Edit/RichEdit 컨트롤)로 direct vs OCR을 판정하고 `extractDirect.ts`가 direct 추출을 구현해뒀는데, direct 추출은 화면 좌표(bbox)를 만들 수 없어서 "클릭한 단어 기준 앞뒤 범위만 팝업에 표시"하는 지금 UX(좌표 필수)와 근본적으로 안 맞는다 — 좌표 때문에 결국 항상 OCR을 돌려야 해서 direct 판정 자체가 무의미해짐. `extractionCache.ts`는 이 둘을 호출하지 않고 항상 OCR만 쓴다. 나중에 "OCR 좌표 + 접근성 텍스트로 내용만 교체"하는 하이브리드로 갈 수도 있지만 두 추출 결과를 매칭시켜야 해서 별도 작업 필요.
- [x] 판정 캐싱: 모드 진입 시 1회 — `extractionCache.ts`. 클릭마다 캡처+OCR을 새로 돌리면 매번 1~3초씩 걸려서, 선택 모드 진입(`shortcut.ts: toggleMode`) 시 미리 캡처+OCR 해 캐시해두고 클릭 시엔 캐시를 즉시 사용하도록 변경. 선택 모드를 나갔다 다시 들어올 때마다 항상 새로 캡처+OCR 한다(그 사이 스크롤 등으로 내용이 바뀌었을 수 있어서 "재진입 = 최신화"로 결정). 창 재선택/선택 해제 시 캐시 무효화(`ipc.ts`/`tray.ts`). ~~URL 키~~ 방식이 아니라 "현재 선택된 창 1개"만 캐시하는 단일 슬롯 구조로 구현(URL 기반 캐싱은 브라우저 확장 경로가 생기면 별도 추가 필요). 캐시가 준비되면 오버레이로도 단어 bbox를 통지(`windows.ts: sendOverlayWords`)해서 hover/클릭이 실제 텍스트 위에서만 되게 함(`Overlay.tsx`).
- [x] 창 재선택 시 선택 모드 자동 해제 — `shortcut.ts: resetToNormalMode()`, `ipc.ts`의 `SELECT_WINDOW` 핸들러에서 호출.
- [ ] 직접 추출 파서: txt / epub / pdf + 좌표 매핑
- [ ] 접근성 API(AX/UIA)로 전자책 뷰어 렌더 텍스트 추출
- [ ] 언어 자동 감지 (유니코드 블록 기반 경량 분류) — 현재 `detectLanguage()`는 항상 `'en'` 반환하는 스텁.
- [x] OCR 엔진 연동 — **범용 엔진(전체 언어 공통/자동감지용) + 언어별 최적 엔진(개별 특화) 이중 구조**로 결정.
  - [x] 범용 엔진: **Tesseract.js** 채택 확정 및 연동 완료 — `ocr.ts`: `captureFocusedWindow()`(창 캡처 → PNG) → `createWorker` → `recognize(image, {}, {blocks:true})` → block/paragraph/line 을 평탄화해 단어별 bbox 추출. 언어별 워커를 재사용(언어 바뀌면 재생성)하고, `detectLanguage()`가 고른 `Language`로 traineddata를 선택. 실제 창 캡처 + OCR 로 검증됨(단, 언어 자동 감지가 스텁이라 항상 `eng` 모델 사용 — 한국어 등 미지원 언어 인식 시 깨진 텍스트가 나오는 게 정상, 언어 자동 감지 구현 후 해소).
  - [x] **창 캡처 크로스플랫폼** — OCR 엔진(Tesseract)은 PNG 버퍼만 받으므로 플랫폼 무관, 캡처만 분기. Windows: win32 `PrintWindow`. **macOS: 내장 `screencapture -o -l<windowID>`**(`capture.ts`, 네이티브 해상도라 PrintWindow 동급 품질). mac 은 물리 픽셀(Retina 2x)이라 `alignWordsToOverlay`(`extractionCache.ts`) darwin 분기에서 bbox 를 `scaleFactor` 로 나눠 오버레이 DIP 에 정합. `screencapture -l` 실기기 동작 확인(760×460 창 → 1520×920 PNG).
    - [ ] mac 실사용 검증 — 실제 선택모드에서 단어 hover/클릭 좌표가 정확히 맞는지(배율·프레임 미세보정 필요 여부) GUI 확인 필요. **화면 기록 권한** 최초 허용 + 앱 재시작 1회 필요.
  - [ ] 언어별 특화 엔진: 영어/일본어/중국어 각각 Tesseract보다 더 정확한 전용 엔진이 있는지 벤치마킹 후 결정 (예: 중국어는 PaddleOCR 등) — 나중에 진행. 결정되면 언어별로 다른 엔진을 호출하도록 라우팅 필요(의존성 여러 개 추가되는 만큼 복잡도 증가 감안).
- [ ] 좌표 기반 노이즈 제거(제목·페이지번호) + 페이지 경계 문장 이어붙이기 — `removeNoise()`는 현재 통과만 시키는 no-op.

<a id="a-ext"></a>

**브라우저 확장 (MV3)**
- [ ] 확장 번들 설정(vite/esbuild) + native messaging host 등록
- [ ] DOM 텍스트 추출(태그 제외 · 문단 잇기) + 좌표
- [ ] 유튜브 원어 자막 추출 (URL / timedtext)
- [ ] 넷플릭스 원어 자막 추출
- [ ] 선택 모드 단어 하이라이트 렌더
- [ ] 탭/URL 변화 감지 → 앱에 재판정 통지

<a id="b-담당"></a>

## 🅱️ 담당 B — 선택 확정 & 질문 (팝업 후)

<a id="b-select"></a>

**팝업 선택 & 문맥 확정**
- [x] ~~A가 넘긴 근방 텍스트·단어 좌표를 팝업에 표시 (`PopupScreen.tsx` + `popup/ContextView.tsx`; `getPopupContext()`/`onPopupContext()` 로 수신, 없으면 목업 fallback)~~
- [ ] 팝업 내 범위 지정 — 영어=단어(atom) 단위는 구현(`popup/selection.ts`, 하이픈 단어 조각별 선택 포함). **일·중 문자 단위 미구현**(atom 규칙만 언어별로 분기하면 됨)
- [x] ~~클릭(단어) vs 드래그(범위) 구분 — `popup/ContextView.tsx` 가 mousedown+mouseenter+전역 mouseup 으로 처리(클릭=단일 atom, 드래그=범위)~~
- [x] ~~최종 선택 확정 + 앞뒤 문맥(preceding/following) 구성 → `SelectionContext` 생성 (`popup/selection.ts` `deriveContext`)~~
- [x] ~~팝업 원문 문맥 표시 범위를 선택 앞뒤 각 1024바이트로 제한 — `buildSelectionModel`(`popup/selection.ts`)이 A가 넘긴 추출 텍스트 전체를 그대로 보여주던 것을, `@shared/context.ts` `computeContextRange` 로 앞뒤 1024바이트(+문장 경계까지 확장, 부족하면 있는 만큼만) 잘라 표시하도록 변경. 데모 목업(`popup/mockSelection.ts`)도 문장 수 기반 사전 트리밍을 없애고 원문 전체를 넘기도록 정리해 동일 로직을 그대로 시연~~
- [x] ~~문장 경계 판정이 영어 약어·이니셜·소수점·줄임표(`Mr.`/`e.g.`/`i.e.`/`U.S.`/`3.14`/`J. K.`/`...`)의 `.`을 문장 끝으로 오인해 LLM 문맥·팝업 표시 범위가 조기에 잘리던 문제 수정 — `@shared/context.ts` `isAbbreviationDot`. CJK 종결부호(`。！？…`)는 영향 없음~~

<a id="b-llm"></a>

**LLM 어댑터**
- [x] ~~LLM 공통 어댑터 인터페이스 (provider 추상화)~~
- [x] ~~GPT / Gemini / Claude 클라이언트 구현 + 스트리밍~~
- [x] ~~어댑터가 `history: ChatTurn[]`을 받아 요청에 이어붙임 (`askLlm`/`buildRequest`, `llm/adapter.ts`)~~
- [x] ~~문맥 프롬프트 구성 + 프롬프트 캐싱(비용 절감)~~
- [x] ~~API 키 무효 / 크레딧(사용 한도) 소진 / 요청 과다 / 네트워크 오류를 구분하는 에러 체계 — `QuestionError`(`shared/types.ts`), `question/errors.ts`(메시지), `question/llm/errors.ts`(HTTP 상태코드 분류). UI 렌더링은 미구현(아래 UI 항목)~~
- [x] ~~provider별 실제 사용 모델 확정 — **설정 화면에서 사용자가 선택**하도록 결정·구현. API 키 입력/수정·provider 선택 시 무과금 GET(`question/llm/validate.ts`)으로 유효성 검사 + 사용 가능 모델 목록을 받아 드롭다운으로 고르게 함. 선택값은 `AppSettings.models[provider]` 에 저장되고 `buildRequest()` 가 `settings.models[provider] ?? DEFAULT_MODELS[provider]` 로 사용. `DEFAULT_MODELS`(gpt: `gpt-4o`, gemini: `gemini-pro-latest`, claude: `claude-sonnet-5`)는 미선택 시 fallback 으로만 남김~~
- [x] ~~API 키 유효성 검사 + 사용 모델 드롭다운 — IPC `PROVIDER_VALIDATE`(`validateProvider`) 로 provider별 models 엔드포인트 호출(OpenAI `/v1/models`, Gemini `/v1beta/models`, Anthropic `/v1/models`). **무과금 GET**(토큰 미소비)이라 유효성+모델목록만 확인. 401/403 → 유효하지 않은 키로 분류(`classifyLlmError`). 설정 화면은 0.5초 디바운스 후 호출하고 상태(확인중/유효/에러)+모델 `<select>` 표시. **잔액/크레딧 조회는 세 provider 모두 공개 API 부재로 제외** — 크레딧 부족은 실제 질문 시 에러 배너로 안내~~
- [ ] 비용 고려사항 — 현재 `buildRequest()`가 `history` 전체를 매 요청마다 잘라내기/요약 없이 재전송함(`llm/adapter.ts`). 팝업 세션이 길어질수록 요청당 input 토큰이 선형 증가.
  - [ ] 대화 history 길이 제한 정책 결정 (예: 최근 N턴만 유지, 또는 초과 시 요약으로 압축)
  - [ ] 프롬프트 캐싱을 `cacheableContext`(선택 근방 문맥) 외에 대화 history에도 적용할지 검토 — 현재는 Claude의 `cache_control: ephemeral`도 문맥 블록에만 적용, history 메시지 배열은 캐싱 대상 아님
  - [ ] GPT/Gemini에도 캐싱 연동 검토 — 현재 캐시 제어는 Claude 클라이언트에만 구현됨. GPT는 prefix 자동 캐싱(별도 API 불필요, prefix 안정성 필요), Gemini는 명시적 context caching API(`cachedContents`) 필요
  - [ ] provider별 요청당 비용 추정치 산정 + 설정 화면에 예상 비용/사용량 노출 여부 결정
  - [ ] 팝업 내 선택 범위 재수정 시 문맥 캐시 재사용 — 현재는 선택 근방 문맥(`cacheableContext`)을 한 번에 넘겨 캐싱하는데, 같은 팝업에서 선택 범위를 나중에 바꾸면 LLM에 필요한 근방 문맥이 살짝 달라짐(대부분 겹치고 경계만 약간 이동). 매번 전체를 새로 보내면 낭비가 크므로, 겹치는 prefix 재사용/증분 전송 등으로 캐시 적중을 유지하는 방안 검토(예: 문맥 블록을 넉넉히 한 번 캐싱해두고 선택 마커만 갱신)

<a id="b-feature"></a>

**질문 기능**
- [ ] 발음: IPA / 히라가나 / 병음 + 맥락 의존 발음 판정 — **스텁만 존재**(`question/pronunciation.ts` 가 빈 문자열 반환). LLM 프롬프트 연동 미구현
- [ ] 사전: 언어별 사전 API + 단어 분해 + LLM 뜻 번호 매핑 — **스텁만 존재**(`question/dictionary.ts` 가 빈 문자열 반환)
  - [ ] 언어별 사전 API 소스 확정 필요 — 예: 영어(Free Dictionary API / Merriam-Webster / WordsAPI), 일본어(Jisho API 등 JMdict 기반), 중국어(CC-CEDICT 기반 API 등). 무료/과금 여부·rate limit·라이선스 확인 후 선택
- [x] ~~통합 질문: 자유 프롬프트 입출력 — `askLlm` 전체 파이프라인 완성(`question/index.ts` `runQuestion` → `llm/adapter.ts`, 스트리밍 포함)~~
- [x] ~~자주 쓰는 질문: 등록 / 수정 / 삭제 + 영속화 — `popup/FrequentQuestions.tsx`. main 프로세스 `userData/frequent.json` 에 파일 저장(`main/frequentStore.ts` + IPC `FREQUENT_GET`/`SET`, 렌더러는 `popup/frequentStore.ts` 얇은 래퍼). localStorage 임시 저장에서 이전 완료 → 재시작·재설치 후 유지~~
- [ ] 구글 검색 — 발음/이미지 탭을 **외부 브라우저로 여는 것까지 구현**(`question/google.ts`, `ipc.ts` `OPEN_GOOGLE`). macOS는 `openGoogleSearchInNewWindow`가 `shell.openExternal` 대신 `open -n <url>`(execFile)로 열어 기존 브라우저 창의 새 탭이 아니라 새 창으로 뜨게 함(다른 OS는 `shell.openExternal` 폴백). PLAN §4.2 "팝업 속 팝업"(임베드형 `BrowserWindow` child) 고도화는 미구현

<a id="b-ui"></a>

**UI · 설정**
- [x] ~~팝업 화면: 원문 + 툴바(발음·사전 체크박스 / 입력 / 구글) + 채팅 + 자주쓰는질문 (`PopupScreen.tsx` + `popup/*`)~~
- [x] ~~팝업 UI 다듬기 — 창 크기를 설정 창과 통일(1200×800), 다크→라이트 모드 전환(설정 화면과 동일 팔레트), 선택 하이라이트가 atom·gap 조각마다 라운드가 있어 끊겨 보이던 것을 이어지게 수정, 원문 문맥 박스 내부 스크롤을 없애고 텍스트 양만큼 자동으로 높이 확장, 구글 로고를 발음/이미지 버튼 왼쪽에 배치, 자주 쓰는 질문 순서를 드래그(HTML5 DnD)로 변경(`popup/FrequentQuestions.tsx`)~~
- [x] ~~채팅 세션 상태 유지 — 팝업 = 1세션. `PopupScreen.tsx` 가 `messages` 상태를 누적하고 `question()` 호출 시 `history: ChatTurn[]`(에러 메시지 제외)를 함께 전달~~
- [x] ~~발음·사전 체크박스 토글 동작 (`popup/Toolbar.tsx` + `PopupScreen.tsx` `togglePron`/`toggleDict`; 선택 변경 시 결과 리셋). 단 결과 내용은 발음/사전 스텁이라 비어 있음~~
- [x] ~~스트리밍 렌더 (`QUESTION_STREAM` 수신) — `PopupScreen.tsx` `onQuestionStream` 구독 후 진행 중 말풍선에 델타 append, `popup/Chat.tsx` 가 커서 표시~~
- [x] ~~에러 배너/토스트 — `QuestionResult.error` 존재 시 `error.code`별 안내. `popup/Chat.tsx` 가 `errorTitle(code)` 로 배너 렌더, `PopupScreen.tsx` `InfoRow` 도 에러 렌더. (재시도/설정 이동 버튼은 미구현)~~
- [x] ~~설정 화면 5개 섹션: LLM 선택 / API 키(입력·보기·수정·삭제) / 단축키 / AI 주변 범위(Byte) / 언어 (`SettingsScreen.tsx`). API 키는 사진과 동일하게 현재 선택된 LLM 1개에 대해서만 표시. 단축키는 실제 keydown 캡처로 accelerator 문자열 생성(수식키 필수·F1~F12 예외·Esc 취소). Byte 범위는 **자유 지정**(연속 슬라이더 + 숫자 입력, 상한 4096, `clampByte`)이며 **앞/뒤 예산 분리**(`contextBytesBefore`/`After` + `contextBytesLinked` 로 동일값 잠금) + 미리보기(`@shared/context` `computeContextRange` 공유). API 키 섹션엔 **유효성 검사 상태 + 사용 모델 드롭다운**(위 B-llm 항목) 포함~~
- [x] ~~API 키 `safeStorage` 암호화 저장·로드 영속화 — `keyStore.ts`, `userData/apikeys.json`(암호문 base64)~~
- [x] ~~앱 설정 영속화 (파일 저장) — `settingsStore.ts`, `userData/settings.json`~~

<a id="공동"></a>

## 🤝 공동
- [ ] 모드 전환 단축키 기본값 변경 — `Ctrl+1` → `Alt+Q`(macOS: Electron이 Option 키로 자동 매핑, Windows: Alt 그대로) 로 변경됨(`selection/shortcut.ts`, 설정 화면 요구사항 반영). 담당 A 항목("앱·윈도우·모드")의 "기본 Ctrl+1" 문구는 그대로 두었으니 참고해서 갱신 바람
- [ ] (향후) 단축키 항목 확장 — 현재는 '모드 전환' 단축키 1개만 지원(`AppSettings.modeShortcut`, `selection/shortcut.ts` 의 `currentAccelerator` 단일 변수). 나중에 '선택창(picker) 전환'·'선택 해제' 등도 단축키로 지정하려면: (1) `AppSettings` 에 `pickerShortcut`/`deselectShortcut` 등 필드 추가, (2) `shortcut.ts` 등록 로직을 `Map<action, accelerator>` 로 일반화(액션별 register/unregister), (3) 각 액션 핸들러 연결(전환=picker 라우팅, 선택 해제=트레이 메뉴 동작 재사용), (4) 설정 화면 단축키 캡처 컴포넌트에 항목 추가. ⚠️ 전역 단축키(`globalShortcut`)라 상호/타앱 충돌 검증(`isRegistered()` 로 등록 실패 시 UI 안내) 필요. (A: 등록·핸들러 / B: `AppSettings` 확장·설정 UI)
- [x] ~~A→B 경계 재정의(팝업 기준) 반영 — A는 '팝업 직전 추출 결과(근방 텍스트 + 단어 좌표 + 클릭 기준점)'를 `ExtractedSelection` 으로 넘기고, B가 팝업에서 최종 `SelectionContext` 를 확정. 경계 인터페이스·IPC 채널 실연결 완료(`shared/types.ts`, `SELECTION_EXTRACTED`)~~ (PLAN.md §7/§8 계약 문구 동기화는 별도 확인 권장)
- [x] ~~`SelectionContext` / `QuestionResult` + IPC 채널 확정 (스텁 → 실연결) — `SELECTION_EXTRACTED`/`QUESTION_REQUEST`/`QUESTION_STREAM` 실동작~~
- [ ] 메인/피커/설정 창 통합 — 세 화면이 동시에 보일 필요가 없어 별도 창(피커·설정) 대신 메인 창 하나를 리사이즈(`windows.ts: setMainWindowRoute`/`navigateMainWindow`)해 재사용하도록 변경(`feat/settings-screen`). 전환 시 항상 창을 중앙 정렬하며, 애니메이션 없이 즉시 크기 변경(다른 창이 뜬 것처럼 보이지 않게)
- [x] ~~IPC 허브 A→B 실연결 — 선택 파이프라인(A) → 팝업/질문(B) 이 `ipc.ts` 허브를 통해 실동작(오버레이 클릭 → 팝업 오픈 → 질문 스트리밍)~~
- [ ] 첫 관통 경로: PDF 직접추출 → 통합 질문 — **선택모드 OCR 관통은 Windows·macOS 둘 다 됨**(mac 은 아래 OCR 항목 참고). 남은 건: **직접추출 경로**(`readWindowText` 접근성 API 는 win32 전용, mac 미구현) + **PDF 직접추출 파서 자체 미구현** → 현재는 양 플랫폼 모두 OCR 로만 텍스트를 얻는다. PDF 직접추출을 붙이면 관통 완성.
- [x] ~~배포 패키징(electron-builder) — `electron-builder.yml`(appId `com.nuance`·productName `Nuance` 고정 → userData 경로 안정, 재설치/버전 업 후에도 설정·API 키·자주쓰는질문 유지). scripts: `pack:dir`(스모크) / `dist:mac`·`dist:win`·`dist:linux`. mac `--dir` 패키징 성공 확인(코드서명 없음: `identity: null`). 산출물은 `dist/`(gitignore)~~
  - [ ] 정식 배포 시 코드서명/공증 — mac: hardenedRuntime+notarize(Apple Developer 인증서), win: 서명 인증서. 현재는 사설 배포(미서명)라 Gatekeeper/SmartScreen 경고가 뜸
  - [ ] 앱 아이콘 교체 — 현재 `build/icon.png` 는 기존 256px 을 1024 로 업스케일한 임시본(정식 아이콘으로 교체 필요)
- [ ] `npm install` + `electron-vite dev` 빌드 정상화
  - [x] ~~koffi를 optionalDependencies로 이동 — 맥에서 네이티브 빌드 실패해도 install 유지 (`fix: 969d08f`)~~
  - [ ] npm optional-deps 버그(npm/cli#4828)로 `@rollup/rollup-darwin-arm64` 누락 시: `node_modules`+`package-lock.json` 삭제 후 재설치 (온보딩 메모 필요)
- [ ] 크로스플랫폼(Win / Mac) 동작 점검
  - [x] ~~맥(arm64) 부팅 확인 — win32Capture(koffi)를 동적 import로 격리해 맥에선 미로드, `npm run dev` 정상 기동 (`fix: 969d08f`). 맥은 desktopCapturer 경로 사용(창 목록 실사용엔 화면 기록 권한 필요)~~
  - [ ] Windows 재확인 — win32Capture가 static→동적 import로 바뀌어 Windows 창 목록/캡처 정상 동작 재점검 필요
  - [x] ~~(담당 A) 선택 창 테두리 오버레이 macOS 대응 — `ipc.ts SELECT_WINDOW` 의 비-win32 분기가 `showMacSelectionOverlay(windowId)`(`windows.ts`)를 호출. CoreGraphics `CGWindowListCopyWindowInfo`(koffi, `selection/macWindow.ts`)로 bounds 를 얻어 테두리를 정렬하고 150ms 폴링으로 이동/리사이즈 추적, owner PID 로 `NSRunningApplication` activate(창 맨 앞으로). Accessibility/자동화 권한 불필요~~
    - [ ] mac 오버레이 정밀화(선택) — 폴링만이라 win32 의 즉시 반응 훅 대비 반응이 약간 느림. 멀티 디스플레이/스케일 좌표 정확도, 대상 창이 다른 창에 가려질 때 z-order 처리(현재 alwaysOnTop 'screen-saver')는 실사용 점검 필요.
- [ ] 언어 확장성 — 현재 영/일/중만 지원(PLAN.md §1), 추후 언어 추가를 대비한 구조.
  - [x] ~~`@shared/languages.ts`에 언어별 정적 데이터(이름, 구글 검색 접미어 등) 단일 레지스트리 도입. `Language` 유니온에 언어를 추가하면 `Record<Language, ...>` 사용처가 컴파일 에러로 누락을 알려줌(`question/llm/adapter.ts`, `question/google.ts` 적용 완료)~~
  - [ ] (담당 A) OCR 언어 감지/언어팩을 이 레지스트리와 연동하거나 별도 레지스트리로 통일 (`selection/langDetect.ts`, `selection/ocr.ts`)
  - [ ] (담당 B) 설정 화면 언어 선택지, 언어별 사전 API 소스, 발음 표기 체계(IPA/히라가나/병음 등 — 언어마다 표기 체계 자체가 다름, 데이터 하나로 단순 확장 안 됨) 설계 시 레지스트리 패턴 반영
  - [ ] (담당 B) 문맥 범위 '바이트 예산'의 언어별 형평성 검토 — 같은 의미의 글도 언어마다 바이트가 다름(실측: 세계인권선언 1조 = 영 170B / 일 252B / 중 129B). CJK는 1자=3바이트지만 훨씬 압축적(영 170자 vs 중 43자)이라 두 효과가 부분 상쇄되나 정확히 같진 않음 → 같은 예산이면 중국어가 가장 많이·일본어가 가장 적게 담김. 진짜 정밀한 문맥/비용 통제가 필요하면 바이트 대신 LLM 토큰 기준 예산으로 전환 검토. (설정: `AppSettings.contextBytesBefore/After`, `@shared/context.ts`)

<a id="미해결-문제"></a>

## ⚠️ 미해결 문제

- [ ] (담당 A) 선택 창 테두리 오버레이 — 대상 창과의 실시간 동기화 지연. 대상 창을 드래그로 이동/리사이즈할 때 오버레이가 못 따라가는 프레임이 간헐적으로 있음(어떤 경우엔 창 크기 변화가 먼저 반영되고 테두리가 뒤따라옴, 어떤 경우엔 반대). `WinEventHook`(`EVENT_OBJECT_LOCATIONCHANGE`, `win32Capture.ts`)으로 즉시 반응 + 150ms 폴링 안전망까지 적용했지만, 오버레이 창과 대상 창이 서로 다른 프로세스의 독립된 최상위 창이라 DWM 이 두 창을 같은 컴포지터 프레임에 맞춰준다는 보장이 없어 완전한 동기화는 구조적으로 어려움. 더 근본적인 해결(예: 대상 창을 자식 창으로 편입 등)이 필요하면 위험도·부작용을 먼저 검토할 것.
- [ ] (담당 A) 창 선택 목록 — 최소화된 창 썸네일 캡처 시 화면 구석에 짧은 깜빡임. `captureMinimizedWin32Window`(`win32Capture.ts`)가 DWM Thumbnail 합성 결과를 읽으려고 화면 우하단에 실제로(약 0.1~0.2초) 작은 캡처용 창을 띄웠다가 지운다 — 그 순간이 눈에 보임. `PrintWindow`/화면 밖 위치로는 DWM 합성 결과를 못 읽어서(이 시스템에서 재현·검증됨) 어쩔 수 없이 화면 안에 실제로 띄워야 했음. 완전히 없애려면 접근 방식 자체를 바꿔야 함(예: 최소화된 창은 실시간 썸네일 대신 아이콘+라벨로 표시, 또는 가상 데스크톱 활용 등) — 사용자와 논의 후 보류 중.
