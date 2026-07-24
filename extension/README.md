# Nuance Browser Extension (담당 A)

브라우저 내부에서 자막/DOM 텍스트를 추출하고, 선택 모드 시 단어 하이라이트를 그려
데스크톱 앱과 **native messaging**으로 통신하는 Manifest V3 확장.

## 역할 (PLAN.md §4.1)
- 유튜브: URL 기반 원어 자막 추출
- 넷플릭스: 현재 에피소드 원어 자막 추출
- 웹페이지: DOM 텍스트 추출(태그 제외, 문단 잇기) + 탭/URL 변화 감지
- 선택 모드: 단어 주변 사각형 하이라이트

## 개발
`background.ts` / `content.ts` 를 `background.js` / `content.js` 로 번들해야 한다.
TODO: 번들러(vite/esbuild) 설정 + native messaging host 매니페스트 등록.
