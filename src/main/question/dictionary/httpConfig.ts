// 汉典(zdic.net)/daijisen(kotobank.jp) 스크래핑 어댑터가 공유하는 User-Agent — 두 사이트
// 모두 일반 브라우저 User-Agent가 아니면(예: 툴 기본 User-Agent) 존재하는 페이지도 404를
// 반환하는 현상이 실측 확인됐다(hanyu.ts 상단 주석 참고). 두 어댑터가 우연히 같은 문자열을
// 각자 상수로 들고 있어(2026-07-30) 단일 소스로 통합 — Wiktionary 등 공식 API를 쓰는
// 어댑터는 Wikimedia User-Agent 정책(wiktionary.ts 참고)을 따로 지켜야 해서 이 상수를
// 쓰지 않는다.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
