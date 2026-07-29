// 공동 소유 — 문장부호를 제외한 "단어" 판정 규칙의 단일 소스.
// 팝업 원문 문맥 atom 분해(renderer/src/screens/popup/selection.ts)와 브라우저 확장의
// 자막 hover 박스 단어 추출(extension/src/domWords.ts)이 공유한다. 공통 핵심 규칙: 문자/
// 숫자 연속(+ 아포스트로피로 이어진 축약형, 예: don't/it's)만 한 단어로 보고, 콤마·마침표
// 등 그 외 문장부호는 단어 경계 밖으로 뺀다(예: "Truthfully," → Truthfully).
// \p{L}\p{N}(유니코드 문자/숫자 속성)이라 라틴뿐 아니라 한글·키릴 등 CJK 가 아닌 모든
// 문자권에 동일하게 적용된다. 한자/가나(CJK)는 이 정규식이 다루지 않고 각 파일이 별도
// 로직(형태소 분석기 등)으로 처리하며, OCR 오버레이의 세로쓰기 일본어(NDLOCR-Lite,
// ocrNdlocr.ts)는 애초에 이 패턴과 무관한 완전히 다른 경로라 영향받지 않는다.
//
// **하이픈 처리는 두 곳이 의도적으로 다르다**(2026-07-29 사용자 결정):
//  - 팝업(WORD_ATOM_PATTERN): 하이픈을 단어 경계로 본다 — "well-to-do"는 well/to/do
//    세 atom으로 쪼개져서, 그중 한 조각만 골라 사전을 찾아볼 수 있어야 한다는 요청.
//  - 확장 hover 박스(HOVER_WORD_ATOM_PATTERN): 하이픈으로 이어진 구간을 한 단어로 묶는다
//    — 자막 화면에서 hover 박스가 "well-to-do"를 세 조각으로 쪼개 보여주면 시각적으로
//    부자연스럽다는 요청. 클릭하면 여전히 팝업이 열리고, 팝업 안에서는 위 규칙대로
//    다시 well/to/do로 쪼개져 보인다 — 두 규칙이 서로 다른 게 아니라 "표시 계층"이 다른
//    것뿐이다.
//
// RegExp 객체 자체를 공유하면 sticky(y)/global(g) 플래그의 lastIndex 상태가 여러 파일에서
// 동시에 쓰일 때 서로 꼬일 수 있어, 패턴 문자열만 export 하고 각자 필요한 플래그로 새
// 인스턴스를 만든다.
export const WORD_ATOM_PATTERN = "[\\p{L}\\p{N}]+(?:['’][\\p{L}]+)*"
export const HOVER_WORD_ATOM_PATTERN = "[\\p{L}\\p{N}]+(?:[-‐'’][\\p{L}\\p{N}]+)*"
