# Nuance Browser Extension (담당 A)

브라우저 내부에서 자막/DOM 텍스트를 추출하고, 선택 모드 시 단어 하이라이트를 그려
데스크톱 앱과 **로컬 WebSocket 서버**로 통신하는 Manifest V3 확장.

## 역할 (PLAN.md §5.1)
- 유튜브: URL 기반 원어 자막 추출
- 넷플릭스: 현재 에피소드 원어 자막 추출
- 웹페이지: DOM 텍스트 추출(태그 제외, 문단 잇기) + 탭/URL 변화 감지
- 선택 모드: 단어 주변 사각형 하이라이트

## 구현 현황
- [x] ~~유튜브 자막 추출~~ (`youtube.ts`, `timedtext.ts`, `captionParse.ts`)
- [x] ~~넷플릭스 자막 추출~~ (`netflix.ts`, `netflixNetworkHook.ts`, `networkHook.ts`)
- [x] ~~웹페이지 DOM 텍스트 추출~~ (`webArticle.ts`, `articleHighlight.ts`, `domWords.ts`)
- [x] ~~선택 모드 단어 하이라이트~~ (`highlight.ts`, `hoverBox.ts`, `wordSegments.ts`)
- [x] ~~번들러(esbuild) 설정~~ (`scripts/build-extension.mjs`, `npm run build:ext` / `watch:ext`)

## 개발
`background.ts` / `content.ts` 등 `extension/src/*.ts`는 esbuild로 `extension/dist/`에
번들된다. `npm run build:ext`(1회 빌드) 또는 `npm run watch:ext`(감시 빌드)를 사용한다.

데스크톱 앱(Electron main)은 native messaging host를 등록하지 않는다 — 앱이 로컬
WebSocket 서버를 열고(`src/main/extension/bridge.ts`), 확장의 background가 여기 접속해
활성 탭 변화·자막·클릭 이벤트 등을 주고받는다.
