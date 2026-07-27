# Nuance 구현 TODO

담당별 구현 체크리스트(작업의 단일 소스). **분업 경계 = 팝업창**: A는 팝업이 뜨기 전까지의 로직(창 선택·캡처·오버레이·모드·텍스트 추출·단어 좌표·클릭 감지), B는 팝업이 뜬 이후의 모든 로직(팝업 내 범위 확정·문맥 구성·발음/사전/질문·결과 렌더·설정 화면)을 담당한다. 설계·인터페이스 계약은 [PLAN.md](PLAN.md) 참고 — §8(2인 분업 / 인터페이스 계약), §10(프로젝트 구조).

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
- [x] 창 선택 UI + `desktopCapturer` 창 목록/선택 — **다른 가상 데스크탑(Space)의 창까지 보여주는 확장은 시도했다가 되돌림**(`feat/mac-other-space-window`→`fix/mac-window-list-slow`로 이어졌던 `listWindowsMac`/`macWindow.ts: listAllMacWindows`). 목록이 지저분해지는 등 UX가 오히려 나빠져 원복 — macOS도 다시 Windows와 동일하게 `desktopCapturer`(현재 Space에 보이는 창만) 하나로 목록을 구성한다(`listWindowsElectron`). Space별 탭 구분 시도(비공개 SkyLight API)도 신뢰도 문제로 보류했던 건이라 관련 TODO 항목도 함께 정리함. **자기 자신(Nuance) 창 제외** — win32 경로(`listWindowsWin32`)는 `BrowserWindow.getAllWindows()`의 hwnd로 이미 걸러내고 있었는데, `listWindowsElectron`(macOS/Linux 경로)엔 이 필터가 없어서 목록에 앱 자신의 창(빈 화면)이 함께 떴다 — `win.getMediaSourceId()`로 자기 창들의 desktopCapturer 소스 id를 모아 동일하게 제외하도록 수정(`capture.ts`).
- [x] 선택된 창 테두리 색 표시 (일반=파랑 / 선택=보라) — Windows: 대상 창에 정렬+실시간 추적. **macOS: 구현됨** — `showMacSelectionOverlay`(`windows.ts`)가 CoreGraphics `CGWindowListCopyWindowInfo`(koffi, `selection/macWindow.ts`)로 desktopCapturer window id 의 실제 bounds 를 얻어 테두리를 정렬하고, `MAC_TRACK_INTERVAL_MS`(16ms) 고빈도 폴링으로 이동/리사이즈를 따라간다(Windows 폴백 폴링의 150ms보다 촘촘함). bounds 를 못 구하면(예: 창이 닫힘) 테두리를 숨긴다(`hideMacOverlay`) — 별도 디스플레이 전체 테두리 폴백은 없음. `MAC_OCCLUSION_EVERY`(6틱=~96ms)마다 z-순서를 확인해 대상 창이 다른 앱 창에 가리면 테두리를 숨긴다(`isMacTargetCovered`). **추가 권한 프롬프트 없음**(창 geometry 조회는 권한 불필요, 창 목록엔 이미 화면기록 권한 사용). osascript(자동화 권한) 방식은 unsigned dev 앱에서 프롬프트가 안 떠 폐기.
- [x] 백그라운드 실행 + 트레이 아이콘 (창 선택 해제 / 창 선택 전환 / 설정)
- [x] 투명·클릭스루 오버레이 윈도우 (선택 창에 정렬 · 이동/리사이즈 추적) — Windows: WinEventHook + 폴백 폴링(150ms, `TRACK_FALLBACK_INTERVAL_MS`). macOS: CGWindowList bounds 폴링(`MAC_TRACK_INTERVAL_MS`=16ms)으로 정렬+이동/리사이즈 추적 — win32 는 즉시 반응 훅이 있지만 mac 은 폴링만인데, 폴링 주기 자체는 Windows 폴백(150ms)보다 오히려 촘촘함(16ms). z-order 재적용(`syncOverlayZOrder`)은 원래 포그라운드 전환 이벤트에서만 돌았는데, 메모장 탭 전환처럼 같은 창 안에서 내부적으로 다시 그려지는 경우(포그라운드 이벤트가 안 뜸) 오버레이가 뒤로 밀리는 문제가 있어 150ms 폴백 폴링에도 같이 넣음(`windows.ts: trackSelectionOverlay`).
- [x] 창 선택 시 대상 창 맨 앞으로 — Windows: `bringWindowToForeground`(win32Capture). macOS: 창의 owner PID(CGWindowList)로 `NSRunningApplication.activateWithOptions:`(objc, koffi, `selection/macWindow.ts`). raise 가 실패해도 테두리/추적은 정상 동작(try/catch 로 degrade). CoreGraphics/objc 네이티브 바인딩은 실기기(맥 arm64)에서 bounds·PID 조회·클래스 로드까지 검증됨.
- [x] 모드 전환 전역 단축키(기본 Alt+Q) + `MODE_CHANGED` 통지

<a id="a-coord"></a>

**단어 감지 · 좌표 매핑 (오버레이)**
- [x] 단어 bbox 좌표 확보 → 커서 좌표 ↔ 단어 매핑 — **Windows 전용, macOS 미구현**(캡처가 `captureFocusedWindow`/win32Capture 기반이라 macOS에선 애초에 OCR 자체가 안 돎; bbox 보정 중 원점 보정도 `getCaptureOriginOffset`으로 win32 전용 API 사용. 배율 보정만은 Electron `screen` API 기반이라 플랫폼 무관). 매핑 로직(`shared/wordMapping.ts: findWordAtPoint`)·오버레이·OCR 파이프라인이 실 데이터로 완전히 연결됨. 선택 모드 진입 시 캐시된 OCR 결과(`extractionCache.ts`)의 단어 bbox를 메인→오버레이로 IPC 통지(`windows.ts: sendOverlayWords`, `preload: onExtractionWords`)해서 `Overlay.tsx`가 **실제 단어 위치**로 hover/클릭 판정을 한다(`MOCK_WORDS` 자리표시자는 제거됨). bbox 정확도를 위해 두 가지 보정을 적용: (1) 물리 픽셀(캡처·OCR) → DIP(오버레이 렌더링) 배율 보정(`windows.ts: getPhysicalToDipScale`) — 디스플레이 배율 100% 아닐 때 어긋나는 문제, (2) 캡처 좌표계(`GetWindowRect`, 안 보이는 리사이즈 테두리 포함) ↔ 오버레이 좌표계(`DWMWA_EXTENDED_FRAME_BOUNDS`, 실제 보이는 프레임) 원점 차이 보정(`win32Capture.ts: getCaptureOriginOffset`). 단어 박스 높이는 단어 자체 bbox 대신 그 단어가 속한 줄(line) bbox 를 써서 같은 줄 단어들의 높이를 통일함(`ocr.ts`). 화면에 그리는 박스는 hover 판정용 bbox 와 별개로 좌우에 각각 2px 시각적 여백을 둬서 글자 획(L/T/I 등)과 테두리가 안 겹치게 함(`Overlay.tsx: WORD_BOX_PADDING`).
- [x] hover 시 커서 모양 변경 — **데스크톱 커서 모양만 구현**, 실제 단어 bbox 기준으로 동작(`windows.ts: setOverlayInteractive`가 실제 텍스트 위에서만 클릭스루 해제 → CSS `cursor: pointer` 반영 + 보라 박스 표시). ~~(확장) 단어 사각형 하이라이트~~는 PLAN.md상 브라우저 확장(extension/) 쪽 기능인데, 확장이 아직 전혀 구현 안 된 상태(native messaging 등 기반 자체가 없음)라 의도적으로 건너뜀 — 확장 작업 시작할 때 별도로 처리 필요.
- [x] 단어 클릭 감지 → 팝업 트리거 (팝업 직전까지가 A 경계) — `Overlay.tsx`가 선택 모드 동안 오버레이를 인터랙티브 상태로 두고(현재는 텍스트 위에서만, 위 항목 참고) 클릭 시 `extractSelection(point)` 호출, `ipc.ts`의 `SELECTION_EXTRACTED` 핸들러가 결과로 바로 `createPopupWindow()`를 호출해 팝업을 연다.
- [x] 산출: 근방 추출 텍스트 + 단어 좌표 + 클릭 기준점을 B로 전달 (최종 선택 확정은 B가 팝업에서 수행) — `runSelectionPipeline`(`selection/index.ts`)이 캐시된 추출 결과에서 클릭 좌표에 해당하는 단어를 찾아 `ExtractedSelection`(`text`+`anchor`+`words`+`source`+`extraction`)을 만들어 B(`PopupScreen.tsx`)로 전달. 단, 앞뒤 문맥(`text`) 자체는 페이지 전체가 아니라 OCR/캡처 단위(현재 화면에 보이는 범위)로 한정됨 — 스크롤되어 화면 밖에 있는 텍스트는 애초에 캡처되지 않아 문맥에 포함 안 됨.

<a id="a-extract"></a>

**추출 판정 · 실행**
- [x] ~~OCR 사용 여부 판정~~ → **구현은 됐지만 지금 파이프라인에서는 미사용으로 보류**(아래 이유). `decideOcr.ts`의 접근성 텍스트 읽기(`accessibility.ts: readWindowText`)는 **Windows 전용, macOS 미구현** — 함수 자체에 `process.platform !== 'win32'` 가드가 있어 macOS에서는 항상 null 반환(항상 OCR로 폴백하는 셈). `decideOcr.ts`(`decideExtraction`)가 접근성 텍스트(표준 Edit/RichEdit 컨트롤)로 direct vs OCR을 판정하고 `extractDirect.ts`가 direct 추출을 구현해뒀는데, direct 추출은 화면 좌표(bbox)를 만들 수 없어서 "클릭한 단어 기준 앞뒤 범위만 팝업에 표시"하는 지금 UX(좌표 필수)와 근본적으로 안 맞는다 — 좌표 때문에 결국 항상 OCR을 돌려야 해서 direct 판정 자체가 무의미해짐. `extractionCache.ts`는 이 둘을 호출하지 않고 항상 OCR만 쓴다. 나중에 "OCR 좌표 + 접근성 텍스트로 내용만 교체"하는 하이브리드로 갈 수도 있지만 두 추출 결과를 매칭시켜야 해서 별도 작업 필요.
- [x] 판정 캐싱: 모드 진입 시 1회 — `extractionCache.ts`. **캐싱 로직 자체(단일 슬롯, 무효화 시점 등)는 플랫폼 무관**하지만, 실제로 캐시를 채우는 `captureFocusedWindow()`(`capture.ts`)가 Windows 전용이라(비-win32에서 예외 throw) **지금은 사실상 Windows 전용으로만 동작**함 — macOS 캡처 구현되면 이 캐싱 로직은 그대로 재사용 가능. 클릭마다 캡처+OCR을 새로 돌리면 매번 1~3초씩 걸려서, 선택 모드 진입(`shortcut.ts: toggleMode`) 시 미리 캡처+OCR 해 캐시해두고 클릭 시엔 캐시를 즉시 사용하도록 변경. 선택 모드를 나갔다 다시 들어올 때마다 항상 새로 캡처+OCR 한다(그 사이 스크롤 등으로 내용이 바뀌었을 수 있어서 "재진입 = 최신화"로 결정). 창 재선택/선택 해제 시 캐시 무효화(`ipc.ts`/`tray.ts`). ~~URL 키~~ 방식이 아니라 "현재 선택된 창 1개"만 캐시하는 단일 슬롯 구조로 구현(URL 기반 캐싱은 브라우저 확장 경로가 생기면 별도 추가 필요). 캐시가 준비되면 오버레이로도 단어 bbox를 통지(`windows.ts: sendOverlayWords`)해서 hover/클릭이 실제 텍스트 위에서만 되게 함(`Overlay.tsx`). 선택 모드 진입 직후부터(클릭 시가 아니라) 캐시가 준비될 때까지 오버레이 상단에 스피너+"텍스트 추출 중…" 배너를 표시(`Overlay.tsx: extracting` 상태, **플랫폼 무관** — 순수 렌더러 UI). 실패 시에도 빈 배열을 통지해 배너가 안 멈추게 처리.
- [x] OCR 대상 영역 지정 — 창 전체를 OCR 하지 않고 사용자가 드래그로 지정한 영역만 인식하도록 변경(`regionSelection.ts` + `ocr.ts: runOcr` 의 Tesseract `rectangle` 옵션). 이걸로 "메뉴바·상태표시줄이 같이 인식되는" 문제를 위치 휴리스틱(`removeNoise`) 없이도 근본적으로 피할 수 있음(사용자가 처음부터 본문만 감싸면 됨). 창당 영역은 한 번만 지정하고 재사용(`shortcut.ts: toggleMode` — 영역 있으면 바로 OCR, 없으면 `REGION_SELECTION_NEEDED` 로 오버레이에 드래그 요청). 드래그 중엔 캡처 도구처럼 화면 전체를 어둡게 하고 드래그 사각형 안만 원래 밝기로 보이게 함(`Overlay.tsx: .region-dim`, box-shadow 스포트라이트 트릭). 이 어두운 레이어가 오버레이의 모드 테두리(outline)까지 덮어버려서, 같은 색 테두리를 DOM 순서상 맨 뒤(=항상 맨 위)에 `border`로 한 번 더 그려 덮어씌움(`Overlay.tsx: .region-border-topcoat`) — 인셋을 미세 조정해 맞추는 방식은 서브픽셀 반올림 오차로 흰 틈/겹침이 생겨 폐기하고 이 방식으로 정착. 오버레이 창 자체는 `resizable: false`/`movable: false`로 고정(영역 드래그 중 오버레이가 완전 인터랙티브 상태가 되는데, 이때 대상 창 가장자리를 드래그하면 오버레이 자신이 OS 리사이즈로 잡혀 대상 창과 따로 노는 문제가 있었음). 드래그 완료 직후 브라우저가 자동으로 발생시키는 click 이벤트를 단어 클릭으로 오인해 팝업이 뜨는 문제가 있어 ref 로 한 번 소비하도록 처리(`Overlay.tsx: justSubmittedRegionRef`). 창 크기가 바뀌면 이전 영역 좌표가 안 맞으므로 자동 무효화(영역 + 캐시된 단어를 비워 박스가 더 이상 안 뜨게 함) — **선택 모드 자체는 유지**하고, 오버레이 배너로 안내하면서 바로 영역 재선택 드래그 모드로 자동 진입(`windows.ts: onWindowResized`, 크기 변화만 감지해 위치 이동과 구분; `shortcut.ts` — 별도 트레이 메뉴 없이 자동 트리거). 단어 hover/클릭은 영역 재선택 중엔 비활성화됨. 화면 내용이 바뀌는 걸 감지해 영역 안에서만 자동 재추출하는 기능(바로 아래 항목)의 "어디를 감시할지" 기준이 됨.
- [x] 영역 경계에서 잘린 단어 제외 — 영역 지정에 의존(이제 Windows/macOS 공통). `ocr.ts`: 영역 안에서 텍스트 일부만 보이는 단어가 여전히 hover/클릭 가능한 문제를 세 가지 서로 다른 판정으로 잡는다. 1) `isWordClippedByRegion` — 단어 bbox 가 지정 영역 경계(Tesseract `rectangle` 크롭 경계)에 거의 붙어있으면 제외. 사용자가 영역을 여백 없이 딱 맞춰 잡은 경우엔 잘 잡지만, 영역을 넉넉하게(여백 포함) 잡으면 실제 잘림이 화면 안쪽(예: 원본 앱의 스크롤 패널 경계)에서 일어나 이 방식만으론 못 잡는 사례가 있어 아래 두 방식을 추가. 2) `looksTruncated` — 인식 신뢰도(Tesseract `confidence`) 기반, 단어 평균이 `MIN_WORD_CONFIDENCE`(90) 미만이거나 글자 하나라도 `MIN_SYMBOL_CONFIDENCE`(75) 미만이면 제외(위치 무관, 실사용 확인하며 임계값을 55→75→90 으로 계속 올림 — 정상 단어 오탐 없이 잘린 단어를 더 잡아내는 방향으로 튜닝 중). 3) `findEdgeClippedLines` — 영역의 맨 위/아래 줄만 따로 확인해, 그 줄의 bbox 높이가 나머지 줄 높이 중앙값의 `EDGE_LINE_HEIGHT_RATIO`(0.95) 미만이면(경계가 줄 중간을 가로질러 위/아래 절반만 보임) 그 줄 전체를 통째로 제외. 비교 기준이 될 다른 줄이 최소 2개는 있어야 해서 전체 줄 수가 3개 미만이면 이 판정은 건너뜀. 세 판정 모두 오탐(정상 단어가 같이 빠짐) 위험을 감수하고 "잘린 텍스트는 아예 안 보이게"를 우선하는 방향으로 잡음 — 실사용하며 임계값 조정 중.
- [x] 영역 내용 변화 감지 → 자동 재추출 — 영역 지정에 동반 제약(이제 Windows/macOS 공통). `changeWatcher.ts`: 선택 모드에서 영역이 확정돼 있는 동안 500ms 마다 영역만 크롭 캡처해 직전 캡처와 픽셀(RGBA 중 R 채널) 비교, 다른 비율이 임계값(2%)을 넘으면 "변화"로 판정. 스크롤처럼 계속 움직이는 동안엔 재추출을 걸지 않기 위해, 변화가 감지될 때마다 800ms 대기 타이머를 리셋하고 그 시간 동안 추가 변화가 없어야 실제로 재추출한다(디바운스). 창 크기 변경 이벤트는 명시적으로 다루지 않음 — 그건 `onWindowResized`가 이미 영역을 무효화하고 재선택을 요구하는 별도 경로라 겹치지 않게 분리했고, 리사이즈 시 이 워처도 함께 멈춘다(`shortcut.ts: onWindowResized`). 재추출은 `extractionCache.ts: refreshExtractionCache()`를 그대로 재사용 — 이미 "최신 호출의 inFlight promise만 캐시에 반영" 구조라 재추출 도중 또 변화가 감지돼도 이전 추출 결과는 자연히 버려지고 최신 것만 반영됨(별도 취소 로직 불필요). 변화가 인식되는 즉시 기존 단어 박스를 비우고(`sendOverlayWords([])`), 디바운스가 끝나 실제 재추출이 시작되면 초기 진입 때와 같은 "텍스트 추출 중…" 배너를 띄운다(`EXTRACTION_STARTED` 채널, `Overlay.tsx`) — 완료되면 `EXTRACTION_WORDS`가 배너를 끄고 새 박스로 채운다. 시작/정지는 영역이 확정되는 시점(`shortcut.ts: toggleMode`의 기존 영역 재사용 분기, `ipc.ts: SUBMIT_REGION`)과 영역이 사라지는 시점(모드 이탈, 리사이즈, 창 재선택)에 맞춰 호출.
- [x] ~~창 재선택 시 선택 모드 자동 해제 — `shortcut.ts: resetToNormalMode()`, `ipc.ts`의 `SELECT_WINDOW` 핸들러에서 호출. **플랫폼 무관**(네이티브 API 없이 모드 상태만 토글) — Windows/macOS 둘 다 동작.~~
- [ ] 직접 추출 파서: txt / epub / pdf + 좌표 매핑
- [ ] 접근성 API(AX/UIA)로 전자책 뷰어 렌더 텍스트 추출
- [ ] 언어 자동 감지 (유니코드 블록 기반 경량 분류) — 현재 `detectLanguage()`는 항상 `'en'` 반환하는 스텁.
- [x] OCR 엔진 연동 — **범용 엔진(전체 언어 공통/자동감지용) + 언어별 최적 엔진(개별 특화) 이중 구조**로 결정.
  - [x] 범용 엔진: **Tesseract.js** 채택 확정 및 연동 완료 — `ocr.ts`: `captureFocusedWindow()`(창 캡처 → PNG) → `createWorker` → `recognize(image, {}, {blocks:true})` → block/paragraph/line 을 평탄화해 단어별 bbox 추출. 언어별 워커를 재사용(언어 바뀌면 재생성)하고, `detectLanguage()`가 고른 `Language`로 traineddata를 선택. 실제 창 캡처 + OCR 로 검증됨(단, 언어 자동 감지가 스텁이라 항상 `eng` 모델 사용 — 한국어 등 미지원 언어 인식 시 깨진 텍스트가 나오는 게 정상, 언어 자동 감지 구현 후 해소).
  - [x] **창 캡처 크로스플랫폼** — OCR 엔진(Tesseract)은 PNG 버퍼만 받으므로 플랫폼 무관, 캡처만 분기. Windows: win32 `PrintWindow`. **macOS: 내장 `screencapture -o -l<windowID>`**(`capture.ts`, 네이티브 해상도라 PrintWindow 동급 품질). mac 은 물리 픽셀(Retina 2x)이라 `alignWordsToOverlay`(`extractionCache.ts`) darwin 분기에서 bbox 를 `scaleFactor` 로 나눠 오버레이 DIP 에 정합. `screencapture -l` 실기기 동작 확인(760×460 창 → 1520×920 PNG).
    - [ ] mac 실사용 검증 — 실제 선택모드에서 단어 hover/클릭 좌표가 정확히 맞는지(배율·프레임 미세보정 필요 여부) GUI 확인 필요. **화면 기록 권한** 최초 허용 + 앱 재시작 1회 필요.
    - [x] OCR 대상 영역 지정(바로 위 항목) — **macOS 좌표 변환 구현 완료**(`regionSelection.ts: submitRegionFromOverlay`). win32는 `getCaptureOriginOffset`+`getPhysicalToDipScale`로 원점·배율을 함께 보정하지만, macOS는 `alignWordsToOverlay`(`extractionCache.ts`) darwin 분기와 대칭으로 원점 오프셋 없이 `getMacWindowBounds`+`screen.getDisplayMatching().scaleFactor` 배율 보정만 적용(캡처·오버레이 원점이 창 좌상단으로 동일해서). 영역 내용 변화 감지(`changeWatcher.ts`)는 영역 지정에 의존하므로 이제 macOS에서도 함께 동작.
  - [ ] 언어별 특화 엔진: 영어/일본어/중국어 각각 Tesseract보다 더 정확한 전용 엔진이 있는지 벤치마킹 후 결정 (예: 중국어는 PaddleOCR 등) — 나중에 진행. 결정되면 언어별로 다른 엔진을 호출하도록 라우팅 필요(의존성 여러 개 추가되는 만큼 복잡도 증가 감안).
  - [x] ~~중국어 간체/번체 자동 판별 — `TESS_LANG.zh` 를 `chi_sim` 단일 언어팩에서 `chi_sim+chi_tra`(Tesseract 가 `+` 로 합쳐진 문자열을 내부에서 분리해 두 언어팩을 함께 로드, `createWorker.js` 확인됨)로 변경. 사용자가 간체/번체를 미리 고르지 않아도 Tesseract 가 글자마다 더 맞는 사전으로 인식(`ocr.ts` `TESS_LANG`).~~
  - [x] ~~일본어·중국어 OCR 단어 재분할(의미 단위) — Tesseract 자체 단어 경계는 공백이 없는 CJK 에서 신뢰하기 어려워서, 줄(line) 단위로 글자(symbol) bbox 를 모두 이어붙인 뒤 언어별 형태소 분석기로 다시 분리하도록 변경(`ocr.ts` `buildCjkLineWords`). 일본어는 kuromoji(IPADIC, `main/nlp/japanese.ts`), 중국어는 segmentit(jieba 스타일, 순수 JS라 네이티브 빌드 불필요, `main/nlp/chinese.ts`). 잘린 단어 제외(`isWordClippedByRegion`/`looksTruncated`) 판정은 기존처럼 Tesseract 단어 단위로 먼저 하고, 살아남은 단어들만 연속 구간(run)으로 이어 분석기를 돌려 필터링된 자리에서 단어가 잘못 이어붙지 않게 함. 각 단어의 bbox 는 가로(x0/x1)만 구성 글자 bbox 들의 min/max 로 계산하고, 세로(y/height)는 기존 `splitWordBySymbols` 와 동일하게 줄(line) bbox 를 그대로 써서 같은 줄 단어들의 높이를 통일함(`buildCjkLineWords`). kuromoji 사전(.dat.gz)과 segmentit 사전 데이터가 실제 파일 경로로 로드돼야 해서 두 패키지 모두 `electron.vite.config.ts` main 번들 external 에 추가(tesseract.js 와 동일 이유 — 인라인되면 자기 패키지 폴더 기준 상대경로 계산이 깨짐). kuromoji 사전 로드(~1초)는 앱 시작 시 미리 예열(`main/index.ts` `warmJapaneseTokenizer`)해 첫 사용 지연을 없앰.~~
- [x] ~~좌표 기반 노이즈 제거(제목·페이지번호·메뉴바·상태표시줄)~~ → **위치 휴리스틱 방식은 삭제함**(`ocr.ts: removeNoise` 및 관련 상수/헬퍼 제거). "OCR 대상 영역 지정" 기능이 생기면서 사용자가 드래그로 본문만 감싸면 메뉴바·상태표시줄·페이지 번호는 애초에 캡처/OCR 대상에서 빠지게 됐고, 그러면서 이 휴리스틱은 "주로 걸러내는 로직"이 아니라 오탐 위험을 감수하는 보조 안전망 정도로 위상이 축소됐었음 — 실효성 대비 유지 비용(정확도 낮음, 언어별 단어 목록 관리 필요)이 안 맞아서 코드째로 걷어냄. 필요해지면 그때 다시 붙이거나 아래 반복 기반 방식으로 대체.
- [ ] 반복 기반 노이즈 제거 — 같은 창을 여러 번 캡처했을 때 같은 위치에 반복되는 텍스트(헤더/워터마크 등)를 찾아 제거하는 방식. 최근 캡처 몇 개를 기억해두는 히스토리 저장소가 새로 필요하고, 첫 캡처에는 비교 대상이 없어 효과가 없음(재진입을 몇 번 해야 누적됨). **우선순위 낮음** — 영역 지정 기능으로 메뉴바/상태바 문제 자체가 대부분 해소돼서, 이 방식이 굳이 필요한 남은 케이스(제목처럼 애매한 텍스트가 지정 영역 안에 반복적으로 딸려오는 경우 등)가 많지 않음. 필요성이 실사용에서 재확인되면 그때 추가.
- [ ] 페이지 경계 문장 이어붙이기 — 미구현.

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
- [x] ~~팝업 내 범위 지정 — 영어=단어(atom) 단위, 하이픈 단어는 조각별 선택 가능(`popup/selection.ts`). 중국어(한자)는 글자 하나가 atom 하나(문자 단위 세밀 선택). 일본어는 한자는 마찬가지로 글자 단위, 가나가 섞이면 kuromoji 형태소 분석(IPC `TOKENIZE_JA` → `main/nlp/japanese.ts`) 결과의 품사 태그로 의미 단위 병합 — 조사(助詞)는 항상 독립 atom, 조동사(助動詞)로 시작하는 토큰만 앞 atom 에 이어붙여 동사 어간+어미를 하나로 취급(예: "渡った" → 渡 / った, `selection.ts` `segmentKanaRunWithTokens`). kuromoji 결과가 도착하기 전 짧은 순간은 Intl.Segmenter 기반 즉석 대체 규칙(`segmentKanaRunFallback`)으로 먼저 그리고, 도착하면 `PopupScreen.tsx` 가 재계산해 교체.~~
- [x] ~~팝업 미리보기 데모를 언어별(영어/일본어/중국어) 3개 버튼으로 확장 — 기존 호빗 "well-to-do" 목업 하나뿐이던 것을, 일본어(《容疑者Xの献身》"新大橋")·중국어(《三体》"天线") 목업을 `popup/mockSelection.ts` 에 추가(`mockDevotionExtraction`/`mockThreeBodyExtraction`, 대상 단어가 원문에 여러 번 나올 때 몇 번째 등장을 anchor 로 쓸지 지정하는 `occurrence` 옵션 포함). `MainScreen.tsx` 데모 버튼이 `window.nuance.openPopup(demo?)` 로 언어 태그를 넘기면 `main/windows.ts` `createPopupWindow(ctx, demo)` 가 팝업 창을 `#/popup?demo=ja|zh` 해시로 로드하고, `App.tsx` `getRoute()` 는 해시의 `?` 앞부분만 라우트로 보도록 수정(쿼리 무시), `PopupScreen.tsx` 가 그 쿼리값으로 초기 목업을 선택. 담당 A 선택 파이프라인이 실제 `ExtractedSelection` 을 넘기기 시작하면 이 데모 버튼들은 제거될 임시 기능.~~
- [x] ~~클릭(단어) vs 드래그(범위) 구분 — `popup/ContextView.tsx` 가 mousedown+mouseenter+전역 mouseup 으로 처리(클릭=단일 atom, 드래그=범위). 단어 사이(공백·문장부호) gap 에서 mousedown 해도 그 gap 인접 단어를 anchor 로 드래그가 시작되고, 드래그 중 gap 을 지날 때도 진행 방향에 맞는 인접 단어까지 선택이 확장됨(gap 도 onMouseEnter 로 처리). atom(단어) hover 시 커서를 `pointer` 로 표시(`styles.css` `.ctx-text .atom`). 드래그가 시작되면 어떤 세그먼트 위에 있든 커서가 텍스트(I-beam)로 고정되도록 `.ctx-text` 에 `dragging` 클래스를 붙임(`styles.css` `.ctx-text.dragging`)~~
- [x] ~~최종 선택 확정 → `SelectionContext` 생성 (`popup/selection.ts` `deriveContext`) — 초기엔 앞뒤 문맥을 `precedingText`/`followingText`로 미리 잘라 담았으나, 팝업 표시 범위(256바이트 창)가 LLM에 보내는 문맥까지 제한해버리는 버그가 있어 `fullText`+`selStart`/`selEnd`(원문 좌표)만 넘기고 LLM 문맥 자르기는 `buildContextBlock`(`llm/adapter.ts`)이 설정값 기준으로 별도 수행하도록 변경(`fix: 1b7f0a1`)~~
- [x] ~~팝업 원문 문맥 표시 범위를 선택 앞뒤 각 512바이트로 제한 — `buildSelectionModel`(`popup/selection.ts`)이 A가 넘긴 추출 텍스트 전체를 그대로 보여주던 것을, `@shared/context.ts` `computeContextRange` 로 앞뒤 512바이트(+문장 경계까지 확장, 부족하면 있는 만큼만) 잘라 표시하도록 변경. 데모 목업(`popup/mockSelection.ts`)도 문장 수 기반 사전 트리밍을 없애고 원문 전체를 넘기도록 정리해 동일 로직을 그대로 시연~~
- [x] ~~문장 경계 판정이 영어 약어·이니셜·소수점·줄임표(`Mr.`/`e.g.`/`i.e.`/`U.S.`/`3.14`/`J. K.`/`...`)의 `.`을 문장 끝으로 오인해 LLM 문맥·팝업 표시 범위가 조기에 잘리던 문제 수정 — `@shared/context.ts` `isAbbreviationDot`. CJK 종결부호(`。！？…`)는 영향 없음~~
- [x] ~~새 문단 시작에 들여쓰기(`PARAGRAPH_INDENT`, `popup/selection.ts` `indentParagraphs`)로 넣은 공백이 화면에 안 보이던 버그 수정 — `.ctx-text`가 `white-space: pre-line`이라 줄바꿈(`\n`) 직후의 일반 스페이스(U+0020)는 CSS 공백 축약 규칙상 렌더링 시 제거된다. `PARAGRAPH_INDENT`를 축약 대상이 아닌 non-breaking space(U+00A0)로 변경~~

<a id="b-llm"></a>

**LLM 어댑터**
- [x] ~~LLM 공통 어댑터 인터페이스 (provider 추상화)~~
- [x] ~~GPT / Gemini / Claude 클라이언트 구현 + 스트리밍~~
- [x] ~~어댑터가 `history: ChatTurn[]`을 받아 요청에 이어붙임 (`streamLlm`, `llm/adapter.ts`)~~
- [x] ~~문맥 프롬프트 구성 + 프롬프트 캐싱(비용 절감)~~
- [x] ~~API 키 무효 / 크레딧(사용 한도) 소진 / 요청 과다 / 네트워크 오류를 구분하는 에러 체계 — `QuestionError`(`shared/types.ts`), `question/errors.ts`(메시지), `question/llm/errors.ts`(HTTP 상태코드 분류). UI 렌더링은 미구현(아래 UI 항목)~~
- [x] ~~provider별 실제 사용 모델 확정 — **설정 화면에서 사용자가 선택**하도록 결정·구현. API 키 입력/수정·provider 선택 시 무과금 GET(`question/llm/validate.ts`)으로 유효성 검사 + 사용 가능 모델 목록을 받아 드롭다운으로 고르게 함. 선택값은 `AppSettings.models[provider]` 에 저장되고 `streamLlm()` 이 `settings.models[provider] || DEFAULT_MODELS[provider]` 로 사용(`||`: "Default" 옵션 선택 시 저장되는 빈 문자열도 `??`와 달리 없는 값으로 취급해 기본 모델로 대체됨 — 원래 `??`였다가 빈 문자열이 그대로 API에 전송되는 버그가 있어 수정됨). `DEFAULT_MODELS`(gpt: `gpt-4o`, gemini: `gemini-pro-latest`, claude: `claude-sonnet-5`)는 미선택 시 fallback 으로만 남김~~
- [x] ~~API 키 유효성 검사 + 사용 모델 드롭다운 — IPC `PROVIDER_VALIDATE`(`validateProvider`) 로 provider별 models 엔드포인트 호출(OpenAI `/v1/models`, Gemini `/v1beta/models`, Anthropic `/v1/models`). **무과금 GET**(토큰 미소비)이라 유효성+모델목록만 확인. 401/403 → 유효하지 않은 키로 분류(`classifyLlmError`). 설정 화면은 0.5초 디바운스 후 호출하고 상태(확인중/유효/에러)+모델 `<select>` 표시. **잔액/크레딧 조회는 세 provider 모두 공개 API 부재로 제외** — 크레딧 부족은 실제 질문 시 에러 배너로 안내~~

<a id="b-feature"></a>

**질문 기능**
- [x] ~~발음: IPA / 히라가나 / 병음 + 맥락 의존 발음 판정 — `question/pronunciation.ts` 가 전용 시스템 프롬프트(`prompts/pronunciation.txt`)로 `llm/adapter.ts` `streamLlm`(구 `askLlm` 오케스트레이션을 'ask'/'pronunciation' 공용으로 일반화)을 호출해 문맥 기반 발음을 스트리밍 반환. 언어별 표기 체계는 `shared/languages.ts` `pronunciationNotation`에 등록. 지역별 발음이 여러 개일 땐 `[미국]`/`[영국]`(영어), `[대륙]`/`[대만]`(중국어) 순으로 대괄호 라벨을 발음 앞에 붙이고, 근거(`근거:`)는 의미 중의성(품사·뜻 차이)을 판정해 발음을 좁힌 경우에만 작성 — 단순 지역/격식 변이거나 발음이 하나뿐이면 생략. `llm/adapter.ts` `LlmRequest.temperature` 를 추가해 GPT/Gemini/Claude 클라이언트 모두 전달하도록 배선하고, 발음 질문은 형식이 고정된 판정 작업이라 `temperature=0.2`로 낮춰 응답 이탈(문맥과 무관한 토큰 삽입 등)을 줄임(`pronunciation.ts` `PRONUNCIATION_TEMPERATURE`). `ask`(자유 질문)는 다양성을 위해 기본값 유지~~
- [ ] 사전: 언어별 사전 API + 단어 분해 + LLM 뜻 번호 매핑 — **스텁만 존재**(`question/dictionary.ts` 가 빈 문자열 반환). 소스 구성은 확정 완료(PLAN.md §5), 아래는 구현 세부 작업 목록(아직 착수 전).
  - [ ] `shared/types.ts`의 `Language` 타입 확장 — `'zh'` 단일값을 `'zh-Hans' | 'zh-Hant'`로 분리(또는 `zh` + 별도 script 필드). `SelectionContext`/`ExtractedSelection` 등 이 타입을 쓰는 모든 곳에 영향.
  - [ ] `selection/langDetect.ts` 구현 — 현재 항상 `'en'` 반환하는 스텁. 유니코드 블록 기반 언어 판별 + 중국어는 스크립트(간체/번체) 판별까지 포함(변환이 아니라 판별이라 상대적으로 신뢰도 높게 가능 — 스크립트별 고유 한자 존재).
  - [ ] en 어댑터: Merriam-Webster(키 등록, 무료 개인용 티어) → WordNet(로컬 데이터셋 번들) → Wiktionary(en.wiktionary.org 또는 kaikki.org 추출 데이터, 신조어 전용 최종 폴백) 순차 폴백 구현
  - [ ] ja 어댑터: Kotobank(스크래핑) → JMdict(로컬 데이터셋 번들, jmdict-simplified 등) → Wiktionary(en.wiktionary.org의 ja 항목) 순차 폴백 구현
  - [ ] zh 어댑터: zh-Hans는 汉典(`/hans/`, 스크래핑) → CC-CEDICT(로컬 데이터셋), zh-Hant는 萌典(스크래핑) → 汉典(`/hant/`) → CC-CEDICT, 공통 최종 폴백으로 Wiktionary(en.wiktionary.org의 zh 항목)
  - [ ] 한국어 설명 처리 — 사전 API는 원어 sense 목록만 제공, LLM이 문맥 판정 + 한국어 설명을 함께 생성하도록 프롬프트 구성
  - [ ] (선택) 스크래핑 소스(Kotobank/汉典/萌典)의 안정성 대비 — 페이지 구조 변경/일시 차단 시 다음 폴백 단계로 자연스럽게 넘어가도록 에러 처리
  - [ ] 상업화 시 재검토(별도 트리거 필요, 지금은 미착수) — en: MW 제외하고 WordNet+Wiktionary만 / ja: Kotobank 제외하고 JMdict+日本語WordNet(NICT) 조합으로 교체 / zh: 汉典·萌典 제외하고 CC-CEDICT 중심 + 有道詞典 API(유료) 검토. 상세 근거는 PLAN.md §5 참고
- [x] ~~네이버 사전 바로가기 — 위 LLM 뜻 번호 판정과는 별개로, 툴바에 네이버 로고 + [사전] 버튼을 추가해 언어별(en/ja/zh) 네이버 사전 페이지를 외부 브라우저 새 창으로 연다(`question/naver.ts` `naverDictionaryUrl`, 언어별 서브도메인은 `shared/languages.ts` `naverDictSubdomain`). 새 창 열기 로직은 기존 `google.ts`에 있던 것을 `question/browser.ts`(`openUrlInNewWindow`)로 분리해 구글/네이버가 공유. 네이버는 공식 API가 없고 스크래핑은 ToS 위반 소지가 있어, LLM 뜻 번호 판정과 달리 "사용자가 직접 찾아보는" 바로가기 용도로만 제공~~
- [x] ~~통합 질문: 자유 프롬프트 입출력 — `askLlm` 전체 파이프라인 완성(`question/index.ts` `runQuestion` → `llm/adapter.ts`, 스트리밍 포함)~~
- [x] ~~자주 쓰는 질문: 등록 / 수정 / 삭제 + 영속화 — `popup/FrequentQuestions.tsx`. main 프로세스 `userData/frequent.json` 에 파일 저장(`main/frequentStore.ts` + IPC `FREQUENT_GET`/`SET`, 렌더러는 `popup/frequentStore.ts` 얇은 래퍼). localStorage 임시 저장에서 이전 완료 → 재시작·재설치 후 유지~~
- [x] ~~구글 검색 — 발음/이미지 탭을 **외부 브라우저로 여는 것까지 구현**(`question/google.ts`, `ipc.ts` `OPEN_GOOGLE`). 기본 브라우저 번들을 감지해 브라우저별로 분기: Chromium 계열은 `open -b <bundle> --args --new-window --window-position=... --window-size=... <url>`(mac), Firefox는 `--new-window`, Safari는 AppleScript로 새 문서+위치 지정 — `open -n`은 Chrome이 단일 인스턴스라 무시되고 새 탭으로 열려버려서 쓰지 않는다(코드 주석에 명시). Windows도 레지스트리로 기본 브라우저를 찾아 `--new-window`를 강제하는 별도 로직(`openWinNewWindow`)이 있고, 감지 실패 시(및 Linux)에만 `shell.openExternal`로 폴백. PLAN §4.2 "팝업 속 팝업"(임베드형 `BrowserWindow` child)은 채택하지 않기로 확정 — 현재의 외부 브라우저 새 창 방식이 최종 구현.~~

<a id="b-ui"></a>

**UI · 설정**
- [x] ~~팝업 화면: 원문 + 툴바(발음·사전 버튼 / 입력 / 구글) + 채팅 + 자주쓰는질문 (`PopupScreen.tsx` + `popup/*`)~~
- [x] ~~팝업 UI 다듬기 — 창 크기를 설정 창과 통일(1200×800), 다크→라이트 모드 전환(설정 화면과 동일 팔레트), 선택 하이라이트가 atom·gap 조각마다 라운드가 있어 끊겨 보이던 것을 이어지게 수정, 원문 문맥 박스 내부 스크롤을 없애고 텍스트 양만큼 자동으로 높이 확장, 구글 로고를 발음/이미지 버튼 왼쪽에 배치, 자주 쓰는 질문 순서를 드래그(HTML5 DnD)로 변경(`popup/FrequentQuestions.tsx`)~~
- [x] ~~툴바 버튼 그룹 순서 반전 — 구글(발음/이미지) 그룹을 왼쪽, AI(발음/사전) 그룹을 오른쪽으로 배치 변경(`popup/Toolbar.tsx`). 구글 로고도 `AI` 배지와 동일한 `.llm-badge` 스타일(패딩·라운드)로 감싸 두 그룹의 배치감을 통일(`styles.css` `.llm-badge`에 `inline-flex` 정렬 추가)~~
- [x] ~~채팅 세션 상태 유지 — 팝업 = 1세션. `PopupScreen.tsx` 가 `messages` 상태를 누적하고 `question()` 호출 시 `history: ChatTurn[]`(에러 메시지 제외)를 함께 전달~~
- [x] ~~발음·사전 버튼 — 토글이 아니라 원샷 액션(`popup/Toolbar.tsx` `onPron`/`onDict` + `PopupScreen.tsx` `askPronunciation`/`askDictionary`). 누르면 즉시 채팅에 고정 라벨('발음 질문'/'사전 검색')로 질문이 남고 답변이 다른 채팅 메시지와 동일하게 스트리밍됨. 발음은 LLM 연동 완료, 사전은 아직 스텁이라 빈 답변~~
- [x] ~~스트리밍 렌더 (`QUESTION_STREAM` 수신) — `PopupScreen.tsx` `onQuestionStream` 구독 후 진행 중 말풍선에 델타 append, `popup/Chat.tsx` 가 커서 표시~~
- [x] ~~에러 배너/토스트 — `QuestionResult.error` 존재 시 `error.code`별 안내. `popup/Chat.tsx` 가 `errorTitle(code)` 로 배너 렌더(발음/사전도 채팅 메시지로 통합되면서 에러도 같은 경로로 렌더됨, 구 `InfoRow`는 제거됨). (재시도/설정 이동 버튼은 미구현)~~
- [x] ~~설정 화면 5개 섹션: LLM 선택 / API 키(입력·보기·수정·삭제) / 단축키 / 문맥 범위(Byte, 구 "AI 주변 범위") / 언어 (`SettingsScreen.tsx`). API 키는 사진과 동일하게 현재 선택된 LLM 1개에 대해서만 표시. 단축키는 실제 keydown 캡처로 accelerator 문자열 생성(수식키 필수·F1~F12 예외·Esc 취소), OS별 표시·Cmd/Ctrl 이중 지원·해제는 위 공동 항목 참고. Byte 범위는 **자유 지정**(연속 슬라이더 + 숫자 입력, 상한은 고정값이 아니라 설정 화면 미리보기 텍스트 길이로 동적 계산되는 `BYTE_MAX`, `clampByte`)이며 **앞/뒤 예산 분리**(`contextBytesBefore`/`After` + `contextBytesLinked` 로 동일값 잠금) + 미리보기(`@shared/context` `computeContextRange` 공유). API 키 섹션엔 **유효성 검사 상태 + 사용 모델 드롭다운**(위 B-llm 항목) 포함~~
- [x] ~~API 키 `safeStorage` 암호화 저장·로드 영속화 — `keyStore.ts`, `userData/apikeys.json`(암호문 base64)~~
- [x] ~~앱 설정 영속화 (파일 저장) — `settingsStore.ts`, `userData/settings.json`~~
- [x] ~~아이콘/UI 통일 정리 — 이모지(⌨️/ℹ️/💸/⚙️) 를 SVG 아이콘으로 교체, 항목별로 제각각이던 수정/삭제 버튼을 공용 `EditDeleteGroup`(`screens/EditDeleteGroup.tsx`, 연필+휴지통 아이콘 쌍)으로 통일해 자주 쓰는 질문·API 키·단축키에 동일 적용. 연필/휴지통/설정 톱니 아이콘은 손으로 그린 SVG 대신 `lucide-react`(Pencil/Trash2/Settings)로 교체(`screens/icons.tsx`). 눈(EyeOff) 아이콘의 슬래시 방향과 눈 윤곽 틈이 어긋나 구멍처럼 보이던 것도 수정~~
- [x] ~~팝업 전체 글자 크기 확대(`styles.css` `.popup-screen` 이하 대부분의 `font-size`를 2px씩 상향: 기본 14→16px, 라벨류 12→14px, 채팅/입력 13→15px 등) + 툴바 구글 로고 왼쪽 여백 추가(`.toolbar`에 `padding-left: 8px`)~~

<a id="공동"></a>

## 🤝 공동
- [x] ~~모드 전환 단축키 기본값 변경 — `Ctrl+1` → `Alt+Q`(macOS: Electron이 Option 키로 자동 매핑, Windows: Alt 그대로) 로 변경 완료(`selection/shortcut.ts` 34행 등 문구 갱신됨)~~
- [x] ~~단축키 macOS Cmd/Ctrl 둘 다 지원 + 해제 가능 — Electron 의 `CommandOrControl` 은 macOS 에서 Cmd 하나로만 고정 매핑돼 물리 Ctrl 키가 반응하지 않던 것을, `Control` 조합도 함께 등록해(`shortcut.ts` `expandAccelerator`) Cmd/Ctrl 둘 다 실제로 동작하게 함. 설정 화면 표시도 실제 동작에 맞춰 "Cmd/Ctrl"(그 외 OS는 "Ctrl")로 보여주고(`SettingsScreen.tsx` `formatAccelerator`), 방향키·Esc·Del 등도 흔한 약어/기호로 표시. 단축키 행이 `EditDeleteGroup`(연필=변경/휴지통=해제)으로 바뀌어 빈 문자열(해제 상태)로 설정 가능(`ipc.ts`/`updateModeShortcut` 이 빈 문자열도 처리하도록 수정)~~
- [ ] (향후) 단축키 항목 확장 — 현재는 '모드 전환' 단축키 1개만 지원(`AppSettings.modeShortcut`, `selection/shortcut.ts` 의 `currentAccelerators`, macOS 에선 Cmd/Ctrl 이중 등록으로 배열). 나중에 '선택창(picker) 전환'·'선택 해제' 등도 단축키로 지정하려면: (1) `AppSettings` 에 `pickerShortcut`/`deselectShortcut` 등 필드 추가, (2) `shortcut.ts` 등록 로직을 `Map<action, accelerator[]>` 로 일반화(액션별 register/unregister), (3) 각 액션 핸들러 연결(전환=picker 라우팅, 선택 해제=트레이 메뉴 동작 재사용), (4) 설정 화면 단축키 캡처 컴포넌트에 항목 추가. ⚠️ 전역 단축키(`globalShortcut`)라 상호/타앱 충돌 검증(`isRegistered()` 로 등록 실패 시 UI 안내) 필요. (A: 등록·핸들러 / B: `AppSettings` 확장·설정 UI)
- [x] ~~모든 창에 OS 수준 기본 우클릭 메뉴 — Electron 은 우클릭 메뉴를 자동으로 붙여주지 않아 지금까지 어느 창에서도 반응이 없던 것을, `electron-context-menu` 로 잘라내기/복사/붙여넣기·맞춤법 제안·macOS 찾아보기·서비스 메뉴까지 구성해 앱의 모든 창(메인/설정/팝업/오버레이)에 공통 적용(`main/contextMenu.ts`, `main/index.ts` `registerContextMenu()`)~~
- [x] ~~A→B 경계 재정의(팝업 기준) 반영 — A는 '팝업 직전 추출 결과(근방 텍스트 + 단어 좌표 + 클릭 기준점)'를 `ExtractedSelection` 으로 넘기고, B가 팝업에서 최종 `SelectionContext` 를 확정. 경계 인터페이스·IPC 채널 실연결 완료(`shared/types.ts`, `SELECTION_EXTRACTED`)~~
- [x] ~~`SelectionContext` / `QuestionResult` + IPC 채널 확정 (스텁 → 실연결) — `SELECTION_EXTRACTED`/`QUESTION_REQUEST`/`QUESTION_STREAM` 실동작~~
- [x] ~~메인/피커/설정 창 통합 — 세 화면이 동시에 보일 필요가 없어 별도 창(피커·설정) 대신 메인 창 하나를 리사이즈(`windows.ts: setMainWindowRoute`/`navigateMainWindow`)해 재사용하도록 변경. 전환 시 항상 창을 중앙 정렬하며, 애니메이션 없이 즉시 크기 변경(다른 창이 뜬 것처럼 보이지 않게). `ipc.ts`/`tray.ts`가 실제로 호출하고, `App.tsx`가 해시 라우트로 `SettingsScreen`/`WindowPickerScreen`을 같은 창 안에서 전환한다 — 별도 `BrowserWindow`는 더 이상 생성되지 않는다.~~
- [x] ~~IPC 허브 A→B 실연결 — 선택 파이프라인(A) → 팝업/질문(B) 이 `ipc.ts` 허브를 통해 실동작(오버레이 클릭 → 팝업 오픈 → 질문 스트리밍)~~
- [ ] 첫 관통 경로: PDF 직접추출 → 통합 질문 — **선택모드 OCR 관통은 Windows·macOS 둘 다 됨**(mac 은 아래 OCR 항목 참고). 남은 건: **직접추출 경로**(`readWindowText` 접근성 API 는 win32 전용, mac 미구현) + **PDF 직접추출 파서 자체 미구현** → 현재는 양 플랫폼 모두 OCR 로만 텍스트를 얻는다. PDF 직접추출을 붙이면 관통 완성.
- [x] ~~배포 패키징(electron-builder) — `electron-builder.yml`(appId `com.nuance`·productName `Nuance` 고정 → userData 경로 안정, 재설치/버전 업 후에도 설정·API 키·자주쓰는질문 유지). scripts: `pack:dir`(스모크) / `dist:mac`·`dist:win`·`dist:linux`. mac `--dir` 패키징 성공 확인(코드서명 없음: `identity: null`). 산출물은 `dist/`(gitignore)~~
  - [ ] 정식 배포 시 코드서명/공증 — mac: hardenedRuntime+notarize(Apple Developer 인증서), win: 서명 인증서. 현재는 사설 배포(미서명)라 Gatekeeper/SmartScreen 경고가 뜸
  - [ ] mac entitlements 파일 추가 — 화면 기록(`desktopCapturer`/`screencapture`)·손쉬운 사용(창 활성화 등) 권한을 쓰는데 `.entitlements` 파일 자체가 없음. 지금은 미서명 상태라 TCC가 서명 여부와 무관하게 권한 다이얼로그를 띄워줘서 우연히 동작하지만, hardened runtime 전환 시 선언 안 된 권한 호출이 조용히 거부/크래시할 수 있어 코드서명/공증과 함께 반드시 추가 필요
  - [ ] 앱 아이콘 교체 — 현재 `build/icon.png` 는 기존 256px 을 1024 로 업스케일한 임시본(정식 아이콘으로 교체 필요)
- [x] ~~`npm install` + `electron-vite dev` 빌드 정상화~~
  - [x] ~~koffi를 optionalDependencies로 이동 — 맥에서 네이티브 빌드 실패해도 install 유지 (`fix: 969d08f`)~~
- [ ] 크로스플랫폼(Win / Mac) 동작 점검
  - [x] ~~맥(arm64) 부팅 확인 — win32Capture(koffi)를 동적 import로 격리해 맥에선 미로드, `npm run dev` 정상 기동 (`fix: 969d08f`). 맥은 desktopCapturer 경로 사용(창 목록 실사용엔 화면 기록 권한 필요)~~
  - [ ] Windows 재확인 — win32Capture가 static→동적 import로 바뀌어 Windows 창 목록/캡처 정상 동작 재점검 필요
  - [x] ~~(담당 A) 선택 창 테두리 오버레이 macOS 대응 — `ipc.ts SELECT_WINDOW` 의 비-win32 분기가 `showMacSelectionOverlay(windowId)`(`windows.ts`)를 호출. CoreGraphics `CGWindowListCopyWindowInfo`(koffi, `selection/macWindow.ts`)로 bounds 를 얻어 테두리를 정렬하고 16ms 폴링(`MAC_TRACK_INTERVAL_MS`)으로 이동/리사이즈 추적, owner PID 로 `NSRunningApplication` activate(창 맨 앞으로). Accessibility/자동화 권한 불필요~~
    - [ ] mac 오버레이 정밀화(선택) — win32 는 즉시 반응 훅(WinEventHook)까지 있는 반면 mac 은 순수 폴링(16ms)뿐이라 이론상 프레임 사이 지연이 있을 수 있음(폴링 주기 자체는 짧음). 멀티 디스플레이/스케일 좌표 정확도, 대상 창이 다른 창에 가려질 때 z-order 처리(현재 `setAlwaysOnTop(true, 'floating')`)는 실사용 점검 필요.
- [ ] 언어 확장성 — 현재 영/일/중만 지원(PLAN.md §1), 추후 언어 추가를 대비한 구조.
  - [x] ~~`@shared/languages.ts`에 언어별 정적 데이터(이름, 구글 검색 접미어 등) 단일 레지스트리 도입. `Language` 유니온에 언어를 추가하면 `Record<Language, ...>` 사용처가 컴파일 에러로 누락을 알려줌(`question/llm/adapter.ts`, `question/google.ts` 적용 완료)~~
  - [ ] (담당 A) OCR 언어 감지/언어팩을 이 레지스트리와 연동하거나 별도 레지스트리로 통일 (`selection/langDetect.ts`, `selection/ocr.ts`)
  - [ ] (담당 B) 설정 화면 언어 선택지, 언어별 사전 API 소스, 발음 표기 체계(IPA/히라가나/병음 등 — 언어마다 표기 체계 자체가 다름, 데이터 하나로 단순 확장 안 됨) 설계 시 레지스트리 패턴 반영

<a id="미해결-문제"></a>

## ⚠️ 미해결 문제

- [ ] (담당 B) LLM 비용 고려사항 — 현재 `streamLlm()`이 `history` 전체를 매 요청마다 잘라내기/요약 없이 재전송함(`llm/adapter.ts`). 팝업 세션이 길어질수록 요청당 input 토큰이 선형 증가.
  - [ ] 대화 history 길이 제한 정책 결정 (예: 최근 N턴만 유지, 또는 초과 시 요약으로 압축)
  - [ ] 프롬프트 캐싱을 `cacheableContext`(선택 근방 문맥) 외에 대화 history에도 적용할지 검토 — 현재는 Claude의 `cache_control: ephemeral`도 문맥 블록에만 적용, history 메시지 배열은 캐싱 대상 아님
  - [ ] GPT/Gemini에도 캐싱 연동 검토 — 현재 캐시 제어는 Claude 클라이언트에만 구현됨. GPT는 prefix 자동 캐싱(별도 API 불필요, prefix 안정성 필요), Gemini는 명시적 context caching API(`cachedContents`) 필요
  - [ ] provider별 요청당 비용 추정치 산정 + 설정 화면에 예상 비용/사용량 노출 여부 결정
  - [ ] 팝업 내 선택 범위 재수정 시 문맥 캐시 재사용 — 현재는 선택 근방 문맥(`cacheableContext`)을 한 번에 넘겨 캐싱하는데, 같은 팝업에서 선택 범위를 나중에 바꾸면 LLM에 필요한 근방 문맥이 살짝 달라짐(대부분 겹치고 경계만 약간 이동). 매번 전체를 새로 보내면 낭비가 크므로, 겹치는 prefix 재사용/증분 전송 등으로 캐시 적중을 유지하는 방안 검토(예: 문맥 블록을 넉넉히 한 번 캐싱해두고 선택 마커만 갱신)
- [ ] (담당 B) 문맥 범위 '바이트 예산'의 언어별 형평성 검토 — 같은 의미의 글도 언어마다 바이트가 다름(실측: 세계인권선언 1조 = 영 170B / 일 252B / 중 129B). CJK는 1자=3바이트지만 훨씬 압축적(영 170자 vs 중 43자)이라 두 효과가 부분 상쇄되나 정확히 같진 않음 → 같은 예산이면 중국어가 가장 많이·일본어가 가장 적게 담김. 진짜 정밀한 문맥/비용 통제가 필요하면 바이트 대신 LLM 토큰 기준 예산으로 전환 검토. (설정: `AppSettings.contextBytesBefore/After`, `@shared/context.ts`)
- [ ] (담당 A) 선택 창 테두리 오버레이 — 대상 창과의 실시간 동기화 지연. 대상 창을 드래그로 이동/리사이즈할 때 오버레이가 못 따라가는 프레임이 간헐적으로 있음(어떤 경우엔 창 크기 변화가 먼저 반영되고 테두리가 뒤따라옴, 어떤 경우엔 반대). `WinEventHook`(`EVENT_OBJECT_LOCATIONCHANGE`, `win32Capture.ts`)으로 즉시 반응 + 150ms 폴링 안전망까지 적용했지만, 오버레이 창과 대상 창이 서로 다른 프로세스의 독립된 최상위 창이라 DWM 이 두 창을 같은 컴포지터 프레임에 맞춰준다는 보장이 없어 완전한 동기화는 구조적으로 어려움. 더 근본적인 해결(예: 대상 창을 자식 창으로 편입 등)이 필요하면 위험도·부작용을 먼저 검토할 것.
- [ ] (담당 A) 창 선택 목록 — 최소화된 창 썸네일 캡처 시 화면 구석에 짧은 깜빡임. `captureMinimizedWin32Window`(`win32Capture.ts`)가 DWM Thumbnail 합성 결과를 읽으려고 화면 우하단에 실제로(약 0.1~0.2초) 작은 캡처용 창을 띄웠다가 지운다 — 그 순간이 눈에 보임. `PrintWindow`/화면 밖 위치로는 DWM 합성 결과를 못 읽어서(이 시스템에서 재현·검증됨) 어쩔 수 없이 화면 안에 실제로 띄워야 했음. 완전히 없애려면 접근 방식 자체를 바꿔야 함(예: 최소화된 창은 실시간 썸네일 대신 아이콘+라벨로 표시, 또는 가상 데스크톱 활용 등) — 사용자와 논의 후 보류 중.
- [ ] (담당 A) Windows — 다른 가상 데스크탑(Virtual Desktop)의 창 선택 지원 여부 미확인. `listWin32Windows`(`win32Capture.ts`)의 `EnumWindows` 자체는 가상 데스크탑과 무관하게 모든 최상위 창을 순회하지만, 열거 시 쓰는 `isCloaked()`(`DWMWA_CLOAKED`) 필터가 다른 가상 데스크탑에 있는 창까지 걸러내고 있는지 실기(Windows, 다중 가상 데스크탑 환경)로 확인 안 됨. 걸러진다면 `IsWindowOnCurrentVirtualDesktop`을 함께 확인해 걸러내는 대신 목록에 포함시키고, 캡처(`PrintWindow`/DWM Thumbnail)가 다른 가상 데스크탑 창에서도 실제로 되는지도 별도 검증 필요(COM `IVirtualDesktopManager` 바인딩 추가가 필요할 수 있음). macOS는 다른 Space 창까지 보여주는 시도를 했다가 UX 문제로 원복했음(위 "앱·윈도우·모드" 항목 참고) — 다시 시도할 경우 Space별 탭 구분(비공개 SkyLight `CGSCopySpacesForWindows`, 신뢰도 낮아 보류했었음)까지 함께 재검토할 것.
