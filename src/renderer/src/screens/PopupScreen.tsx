import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatTurn,
  DictionarySourceId,
  DictionarySourceOption,
  ExtractedSelection,
  JaTokenizeResult,
  QuestionRequest,
  QuestionResult,
  ZhWord,
} from '@shared/types'
import { sentenceEnd, skipPartialSentenceForward } from '@shared/context'
import { DICTIONARY_QUESTION, PRONUNCIATION_QUESTION } from '@shared/questionText'
import { getLanguageName, hasNaverDict, isFullLanguage, isRtlLanguage } from '@shared/languages'
import { DEFAULT_MODELS } from '@shared/providers'
import { ContextView } from './popup/ContextView'
import { Toolbar } from './popup/Toolbar'
import { Chat } from './popup/Chat'
import { FrequentQuestions } from './popup/FrequentQuestions'
import {
  buildDisplayText,
  buildSelectionModel,
  deriveContext,
  displayOffsetToAbsolute,
  DISPLAY_CONTEXT_LINES_AFTER,
  DISPLAY_CONTEXT_LINES_BEFORE,
} from './popup/selection'
import { measureVisualLineRange } from './popup/measureLines'
import {
  mockBankExtraction,
  mockDevotionExtraction,
  mockHobbitExtraction,
  mockTaipeiBankExtraction,
  mockThreeBodyExtraction,
} from './popup/mockSelection'
import { loadFrequent, saveFrequent } from './popup/frequentStore'
import { newId, type ChatMessage } from './popup/types'

// ============================================================================
// 담당 B — 팝업 화면 (PLAN.md §4/§5.2)
// 선택 확정 후 뜨는 검색·채팅 팝업. 위→아래:
//   헤더(드래그 이동) · 원문 문맥(범위 재지정) · 툴바(발음/사전 버튼 포함) · 채팅 · 자주 쓰는 질문
// 발음/사전 버튼은 토글이 아니라 원샷 액션: 누르면 즉시 채팅에 실제 LLM 요청 문구
// (PRONUNCIATION_QUESTION/DICTIONARY_QUESTION, @shared/questionText)로 질문이 남고
// LLM 응답이 다른 채팅 메시지와 동일하게 스트리밍된다.
//
// 데이터 진입:
//   - 실제(담당 A 통합): main 이 createPopupWindow(ctx) 로 넘긴 ExtractedSelection 을
//     getPopupContext()/onPopupContext() 로 받는다.
//   - 데모: MainScreen 의 팝업 미리보기 버튼으로 열었을 때만(#/popup?demo=hobbit 등)
//     목업으로 채운다. 기본(영어)은 호빗 "well-to-do", 그 외엔 각각 《容疑者Xの献身》
//     "新大橋" / 《三体》"天线"(간체) 등.
//
// **demo 쿼리가 없으면 절대 목업으로 fallback 하지 않는다**(2026-07-29 수정) — 예전엔
// MainScreen 의 기본(영어) 데모 버튼이 demo 인자 없이 openPopup() 을 호출해서, 그 URL
// 해시가 실사용(선택 확정 → createPopupWindow(ctx))과 똑같이 '#/popup'(쿼리 없음)이 됐다.
// 그래서 실사용 중 어떤 이유로든(레이스 등) getPopupContext() 가 null 을 반환하면 실제
// 클릭과 무관하게 호빗 "well-to-do" 데모가 뜨는 문제가 있었다(사용자 제보, "자막 누르면
// 뜬금없이 호빗 데모창이 뜬다"). MainScreen 의 기본 데모 버튼도 이제 명시적으로
// openPopup('hobbit') 을 호출하도록 바꿔서, "demo 쿼리가 아예 없음"은 이제 항상
// "실사용인데 ctx 가 아직 없음(로딩 중)"만을 뜻한다 — 이 경우 목업 대신 빈 화면을 유지한다.
// ============================================================================

/** 팝업 창 URL 해시(#/popup?demo=hobbit)에서 demo 쿼리값을 읽는다. */
function getDemoParam(): string | null {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('demo')
}

/** demo 쿼리에 매칭되는 목업이 있으면 반환, 없으면(실사용) null. */
function mockExtractionForDemoParam(demo: string | null): ExtractedSelection | null {
  switch (demo) {
    case 'hobbit':
      return mockHobbitExtraction()
    case 'ja':
      return mockDevotionExtraction()
    case 'zh-Hans':
      return mockThreeBodyExtraction()
    case 'zh-Hant':
      return mockTaipeiBankExtraction()
    case 'en-bank':
      return mockBankExtraction()
    default:
      return null
  }
}

// 실제 ctx 도착 전(getPopupContext() IPC 왕복이 끝나기 전) 첫 렌더용 빈 자리표시자.
function emptyExtraction(): ExtractedSelection {
  return {
    text: '',
    anchor: { start: 0, end: 0 },
    words: [],
    language: 'en',
    source: { kind: 'web' },
    extraction: 'direct',
  }
}

export function PopupScreen() {
  const [baseCtx, setBaseCtx] = useState<ExtractedSelection>(emptyExtraction)

  // 헤더에 "영어(자동 판별)"/"영어(사용자 지정)"처럼 언어가 어떻게 정해졌는지 보여주기 위한
  // 값 — 언어 판별 자체(OCR/자막/웹 5개 지점, `getLanguageOverride() ?? detect...()` 패턴)에
  // source 필드를 추가로 꿰는 대신, 이 설정이 전역이라 "지금 설정값이 auto가 아니면 이 팝업의
  // language도 그걸로 정해졌다"고 봐도 안전하다는 점을 이용해 팝업이 뜰 때 설정을 한 번만
  // 조회한다(2026-07-30, 사용자 요청 — 자동판별인지 수동 지정인지 분간이 안 간다는 피드백).
  const [languageOverridden, setLanguageOverridden] = useState(false)
  // 툴바 "AI" 배지 옆에 지금 실제로 호출되는 모델을 보여주기 위한 값(2026-07-30, 사용자
  // 요청) — llm/adapter.ts의 `settings.models[provider] || DEFAULT_MODELS[provider]`와
  // 동일한 계산을 그대로 재사용해, 사용자가 모델을 직접 고르지 않았을 때도(기본값 적용)
  // 실제 호출되는 모델명이 어긋나지 않게 한다. provider 를 아직 안 골랐으면(llm === null)
  // null — Toolbar 가 이 경우 "AI"만 보여주고 괄호를 생략한다.
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    window.nuance.getSettings().then((s) => {
      if (!active) return
      setLanguageOverridden(s.language !== 'auto')
      setCurrentModel(s.llm ? s.models[s.llm] || DEFAULT_MODELS[s.llm] : null)
    })
    return () => {
      active = false
    }
  }, [])

  // main 에서 실제 컨텍스트를 받으면 교체(초기 조회 + 창 재사용 시 갱신 통지). 초기 조회가
  // null 이어도 demo 쿼리가 없으면(=실사용) 목업으로 fallback 하지 않는다 — demo 쿼리가
  // 있을 때(MainScreen 미리보기 버튼)만 그 목업으로 확정한다. 위 모듈 주석 참고.
  useEffect(() => {
    let active = true
    window.nuance.getPopupContext().then((ctx) => {
      if (!active) return
      if (ctx) {
        setBaseCtx(ctx)
        return
      }
      const mock = mockExtractionForDemoParam(getDemoParam())
      if (mock) setBaseCtx(mock)
    })
    return window.nuance.onPopupContext((ctx) => {
      if (ctx) setBaseCtx(ctx)
    })
  }, [])

  // 창이 빈 자리표시자(emptyExtraction)로 먼저 페인트된 뒤 실제 내용으로 바뀌는 깜빡임을
  // 없애려고(2026-07-29 사용자 피드백), 메인이 창을 숨겨둔 채로 이 신호를 기다린다
  // (windows.ts: createPopupWindow). baseCtx 가 실제 값(위 useEffect 에서 온 ctx/mock)으로
  //바뀐 뒤 두 번의 requestAnimationFrame(브라우저가 그 프레임을 실제로 그렸다고 볼 수
  // 있는 표준적인 방법 — 1번만으로는 페인트 전일 수 있음)을 기다렸다가 통지한다. 팝업이
  // 열려있는 내내(글자 단위 토글, 선택 범위 변경 등으로 baseCtx 가 다시 바뀌는 경우는
  // 없음) 딱 한 번만 필요하므로 baseCtx 참조가 최초 자리표시자에서 벗어나는 순간에만 실행.
  const notifiedReadyRef = useRef(false)
  useEffect(() => {
    if (notifiedReadyRef.current) return
    if (!baseCtx.text) return // 아직 자리표시자(emptyExtraction) — 실제 내용이 아님
    notifiedReadyRef.current = true
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => window.nuance.notifyPopupContentReady())
    })
    return () => cancelAnimationFrame(raf1)
  }, [baseCtx])

  // Esc 로 팝업 닫기 (헤더 ✕ 와 동일 동작)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 원문 문맥 표시 범위(2026-07-29, 사용자 요청) — 팝업이 실제로 렌더링되는 너비/폰트
  // 기준 "화면상 줄"(단순 '\n' 문단 구분이 아니라 자동 줄바꿈까지 반영)로 선택 앞뒤
  // 2줄을 잡되(처음엔 3줄이었으나 자막류 텍스트에서 너무 길어 보인다는 피드백으로 축소),
  // 문장 경계까지는 확장한다(그래서 총 줄 수가 5줄보다 늘어날 수 있음 — 의도된 동작).
  // 여기서의 "확장"은 창이 문장을 중간에 자를 때만 바깥으로 늘리는 것이지, 이미 문장이
  // 깔끔하게 끝나는 지점이면 그대로 유지된다(sentenceEnd 는 이미 끝난 문장을 다시 안
  // 늘림) — linesAfter 만큼 뒤에 오는 줄 자체는 항상 고정 개수만큼 보여준다(그 줄들이
  // 각각 온전한 문장이어도 줄임 대상이 아님). DOM 측정(measureLines.ts)이 필요해
  // 컨테이너가 실제로 마운트된 뒤에만 가능하므로, 마운트 전엔 buildDisplayText 의 문단 기반 근사치로 먼저 그리고
  // 측정이 끝나면 이 값으로 교체해 다시 그린다. **팝업이 뜬 뒤 창 크기가 바뀌어도
  // 재측정하지 않는다** — 의존성 배열이 baseCtx 뿐이라 resize 이벤트와 무관하게 처음
  // 계산한 범위를 그대로 유지한다(사용자 요청 — "떠 있는 상태에서 너비가 바뀌어도
  // 보이는 텍스트 범위는 그대로"). displayText(아래, 형태소 분석 대상)와 model(atom
  // 계산)이 같은 범위를 봐야 하므로 이 state 를 두 곳보다 먼저 선언해 공유한다.
  const ctxRootRef = useRef<HTMLDivElement>(null)
  // baseCtx 와 함께 저장해서, 아래에서 항상 "이 measured 가 지금 baseCtx 기준으로 계산된
  // 게 맞는지"를 직접 확인하고 쓴다(바로 아래 measuredRange 파생값 참고) — 2026-07-29,
  // 팝업 창 재사용(windows.ts: createPopupWindow) 도입 후 발견된 버그 수정. baseCtx 가
  // 바뀌면 이 effect 가 setMeasured(null) 을 거쳐 새로 측정하는데, 그 리셋이 반영되기
  // 전(같은 커밋의 첫 렌더)엔 이전 baseCtx 기준으로 계산된 값이 새 baseCtx 와 함께
  // 그대로 쓰였다 — 이전엔 클릭마다 창을 새로 만들어(baseCtx 가 처음부터 null) 이런
  // "다른 baseCtx 의 잔여값"이 존재할 수 없었지만, 재사용 이후엔 실제로 발생해 그 잘못된
  // 범위가 range 리셋 로직(아래 lastSpanRef)에 한 번 새겨져 버리면 창이 다시 켜져도
  // 엉뚱한 줄이 선택된 채로 남았다(사용자 재현: "팝업이 뜬 채로 다른 텍스트 박스를 누르면
  // 가끔 엉뚱한 다른 줄이 선택됨"). ctx 를 같이 저장해 항상 지금 baseCtx 것인지 확인하면,
  // 이 "한 프레임짜리 불일치"가 애초에 밖으로 새어나가지 않는다.
  const [measured, setMeasured] = useState<{
    ctx: ExtractedSelection
    range: { start: number; end: number }
  } | null>(null)
  const measuredRange = measured?.ctx === baseCtx ? measured.range : null
  // 측정 대상 텍스트를 앵커 주변 일정 문자 수로 제한 — extracted.text 전체(문서 전체)를
  // 매 문자 Range 쿼리로 재는 건 낭비이고, 실제로 필요한 3~7줄보다 훨씬 넉넉한 예산이라
  // 잘릴 걱정 없이 성능만 보호한다.
  const MEASURE_TEXT_BUDGET = 4000
  useLayoutEffect(() => {
    const el = ctxRootRef.current
    if (!el) return
    const fullText = baseCtx.text
    const sliceStart = Math.max(0, baseCtx.anchor.start - MEASURE_TEXT_BUDGET)
    const sliceEnd = Math.min(fullText.length, baseCtx.anchor.end + MEASURE_TEXT_BUDGET)
    const measuredSpan = measureVisualLineRange(
      el,
      fullText.slice(sliceStart, sliceEnd),
      baseCtx.anchor.start - sliceStart,
      baseCtx.anchor.end - sliceStart,
      DISPLAY_CONTEXT_LINES_BEFORE,
      DISPLAY_CONTEXT_LINES_AFTER,
    )
    if (!measuredSpan) return
    const absStart = measuredSpan.start + sliceStart
    const absEnd = measuredSpan.end + sliceStart
    // sentenceEnd(text, p)는 "p가 아직 문장 중간이면 그 문장 끝까지 확장"하는 함수라,
    // absEnd(슬라이스 끝 — 다음 줄의 "첫 글자" 오프셋, exclusive)를 그대로 넘기면 그
    // 위치가 하필 다음 문장의 시작과 겹칠 때(줄 기반 자막처럼 "한 줄 = 한 문장"인
    // 텍스트에서 흔함) "이 문장이 아직 안 끝났다"고 오인해 그 다음 문장 전체를 통째로
    // 삼켜버리는 버그가 있었다(실사용 확인, 2026-07-29 — "course" 선택 시 그 뒤로
    // 원래 3줄이어야 할 범위에 무관한 한 문장이 더 붙어 나옴). "포함된 마지막 글자"
    // (absEnd - 1) 기준으로 확인해야 이미 문장이 끝난 위치를 "아직 안 끝남"으로
    // 오판하지 않는다 — absStart(포함된 첫 글자, inclusive)는 애초에 이 문제가 없다.
    //
    // 시작 경계는 sentenceStart(뒤로 확장해 문장을 포함) 대신 skipPartialSentenceForward
    // 를 쓴다 — "N줄 전" 위치가 여러 줄에 걸친 긴 문장 중간에 걸리면, 뒤로 확장해 그
    // 문장 전체를 끌어오는 대신 그 문장을 통째로 버리고 다음 문장 시작까지 건너뛴다(창이
    // 커지는 대신 줄어드는 쪽). RoyalRoad 실측(2026-07-30)으로 원인 확정 — "There was no
    // way...exorbitant."라는 긴 문장 중간에 2줄 경계가 걸리자 그 문장 전체가 앞에 통째로
    // 붙어 2줄이 5~6줄로 불어났었다. 모든 소스(OCR/자막/웹) 공통 — "N줄 전/후"는 소스와
    // 무관한 공용 규칙이라 소스별로 다르게 동작할 이유가 없다(2026-07-30 사용자 지적으로
    // web 전용 분기를 걷어냄 — 애초에 p가 이미 문장 시작이면 그대로 반환하는 함수라
    // 대부분의 OCR/자막에는 사실상 no-op이다).
    setMeasured({
      ctx: baseCtx,
      range: {
        start: skipPartialSentenceForward(fullText, absStart),
        end: sentenceEnd(fullText, Math.max(absStart, absEnd - 1)),
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCtx])

  // 일본어는 가나 조각을 main/nlp/japanese.ts 의 활성 엔진(JA_ENGINE) 품사 기반으로
  // 병합한다 — 사전/모델 로드가 끝날 때까지의 짧은 순간은 즉석 대체 규칙(selection.ts
  // segmentKanaRunFallback)으로 먼저 그린다. displayText 는 형태소 분석에 넘길 대상
  // 문자열(atom 과 무관)이라 먼저 따로 계산한다. engine 태그를 같이 받아야 selection.ts
  // 가 IPADIC/UniDic 중 맞는 병합 함수를 고를 수 있다. measuredRange 가 반영되기 전/후로
  // model(atom 계산)과 같은 범위를 봐야 하므로 여기도 같은 인자를 넘긴다.
  const displayText = useMemo(
    () => buildDisplayText(baseCtx, measuredRange ?? undefined).displayText,
    [baseCtx, measuredRange],
  )
  const [jaResult, setJaResult] = useState<JaTokenizeResult | undefined>(undefined)
  useEffect(() => {
    setJaResult(undefined)
    if (baseCtx.language !== 'ja') return
    let active = true
    window.nuance.tokenizeJapanese(displayText).then((result) => {
      if (active) setJaResult(result)
    })
    return () => {
      active = false
    }
  }, [baseCtx.language, displayText])

  // 중국어는 main/nlp/chinese.ts 가 정한 단어 경계를 그대로 atom 으로 쓴다 — OCR 단어
  // 클릭(main/selection/ocr.ts)과 동일한 분석 결과라 병합 규칙 없이 바로 쓸 수 있다.
  const [zhWords, setZhWords] = useState<ZhWord[] | undefined>(undefined)
  useEffect(() => {
    setZhWords(undefined)
    if (baseCtx.language !== 'zh-Hans' && baseCtx.language !== 'zh-Hant') return
    let active = true
    window.nuance.tokenizeChinese(displayText, baseCtx.language).then((words) => {
      if (active) setZhWords(words)
    })
    return () => {
      active = false
    }
  }, [baseCtx.language, displayText])

  // ja/zh 전용 "글자 단위" 선택 토글(2026-07-28) — 기본은 단어 단위(false), 켜면 한자를
  // 한 글자씩 개별 선택할 수 있게 한다(selection.ts buildSelectionModel/tokenizeAtoms 참고).
  // en 등 다른 언어에선 Toolbar 가 토글 자체를 숨긴다.
  const [charLevel, setCharLevel] = useState(false)

  const model = useMemo(
    () => buildSelectionModel(baseCtx, jaResult, zhWords, charLevel, measuredRange ?? undefined),
    [baseCtx, jaResult, zhWords, charLevel, measuredRange],
  )
  const [range, setRange] = useState({ from: model.initialFrom, to: model.initialTo })
  // range 가 가리키는 atom 인덱스는 model(atoms 배열)이 바뀌면 의미가 달라진다(아래 참고) —
  // "지금 선택된 문자 범위"를 atom 인덱스와 별개로 기억해뒀다가, model 이 바뀌어도 같은
  // 문자 범위를 새 atom 인덱스로 재매핑하는 데 쓴다.
  //
  // **원문(extracted.text) 절대 좌표로 기억한다**(2026-07-30 수정) — 예전엔 displayText
  // 좌표로 기억했는데, model 이 바뀌는 이유 중 measuredRange 도착(근사 창 → 측정 창)은
  // atoms 구조만이 아니라 표시 창 시작점(windowStart) 자체가 이동해서, 낡은 표시 좌표를
  // 새 창의 atoms 에 그대로 얹으면 수십 자 뒤의 엉뚱한 단어(들)로 재매핑됐다(실사용 확인,
  // "yet 을 눌렀는데 sandy hole 이 선택됨" — 창 이동량만큼 밀리므로 클릭마다 밀림량도
  // 달라 보였음). 절대 좌표로 기억하고 비교할 때도 각 atom 을 절대 좌표로 변환하면
  // 창이 어떻게 바뀌든 항상 같은 원문 범위를 가리킨다.
  const lastSpanRef = useRef<{ start: number; end: number } | null>(null)
  const prevBaseCtxRef = useRef(baseCtx)

  function updateRange(from: number, to: number): void {
    setRange({ from, to })
    const a = model.atoms[from]
    const b = model.atoms[to]
    if (a && b) {
      lastSpanRef.current = {
        start: displayOffsetToAbsolute(model, Math.min(a.start, b.start)),
        end: displayOffsetToAbsolute(model, Math.max(a.end, b.end)),
      }
    }
  }

  // model 이 바뀔 때(baseCtx 자체가 바뀜 / charLevel 토글 / jaResult·zhWords 도착 등) 항상
  // model.initialFrom/To(=처음 클릭된 anchor)로 리셋하면, "글자 단위" 토글처럼 atom
  // 경계만 재분할되고 사용자가 실제로 드래그해둔 선택은 그대로 유지돼야 하는 경우에도
  // 선택이 초기화돼버리는 버그가 있었다(실사용 확인, 2026-07-29 — 글자 단위 선택 토글을
  // 누르면 드래그해둔 범위가 사라짐). baseCtx 자체가 바뀐 경우(진짜 다른 선택으로 교체)만
  // initialFrom/To로 리셋하고, 그 외(같은 baseCtx인데 atoms 구조만 바뀐 경우)는 직전
  // 선택의 문자 범위(lastSpanRef, 원문 절대 좌표)와 겹치는 새 atom 인덱스로 재매핑해
  // 선택을 유지한다.
  useEffect(() => {
    const baseCtxChanged = prevBaseCtxRef.current !== baseCtx
    prevBaseCtxRef.current = baseCtx
    const span = baseCtxChanged ? null : lastSpanRef.current

    if (span) {
      let newFrom = -1
      let newTo = -1
      for (let i = 0; i < model.atoms.length; i++) {
        const atom = model.atoms[i]!
        const atomStart = displayOffsetToAbsolute(model, atom.start)
        const atomEnd = displayOffsetToAbsolute(model, atom.end)
        if (atomEnd > span.start && atomStart < span.end) {
          if (newFrom < 0) newFrom = i
          newTo = i
        }
      }
      if (newFrom >= 0) {
        updateRange(newFrom, newTo)
        return
      }
    }
    updateRange(model.initialFrom, model.initialTo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // 현재 선택 범위로부터 질문에 넘길 컨텍스트를 파생
  const currentCtx = useMemo(
    () => deriveContext(baseCtx, model, range.from, range.to),
    [baseCtx, model, range],
  )

  // 선택 범위가 바뀔 때마다(초기 선택 포함) 현재 선택된 표현을 클립보드에 자동 복사한다
  // — 팝업에서 원문 문맥을 재지정해가며 찾아본 단어를 바로 다른 곳에 붙여넣고 싶을 때를
  // 위함. 빈 문자열까지 복사하면 사용자가 다른 데서 복사해둔 내용을 덮어써버리므로 제외.
  // navigator.clipboard 가 아니라 메인 프로세스 클립보드(IPC)를 쓴다(2026-07-30) —
  // navigator.clipboard 는 문서가 포커스돼 있어야 동작해서, 첫 페인트 전까지 숨겨진 채로
  // 만들어지는 팝업의 "뜬 직후" 초기 복사가 조용히 실패했다(사용자 제보 — 팝업이 뜬
  // 직후엔 복사가 안 되고 범위를 손으로 바꾼 뒤부터만 됐던 원인).
  useEffect(() => {
    if (!currentCtx.selectedText) return
    void window.nuance.copyToClipboard(currentCtx.selectedText)
  }, [currentCtx.selectedText])

  // ---- 사전 소스 직접 선택(정식 기능, 2026-07-30 격상) -----------------------
  // 사용자가 특정 사전 소스(MW/JMdict/汉典 등)로 직접 검색하고 싶을 때 골라 쓰는 기능.
  // 언어가 바뀔 때마다 그 언어에 실제로 구현된(파일이 존재하는) 소스 목록을 다시
  // 조회하고, 폴백 순위 1순위를 기본 선택값으로 삼는다 — main/question/dictionary/
  // registry.ts 가 자동 감지하므로 여기서는 그냥 받아서 보여주기만 하면 된다.
  const [dictSources, setDictSources] = useState<DictionarySourceOption[]>([])
  const [selectedSource, setSelectedSource] = useState<DictionarySourceId | undefined>(undefined)
  // 기본값은 꺼짐(정식 폴백 체인, dictionary.ts FALLBACK_CHAINS) — "직접 선택"은 사용자가
  // 드롭다운에서 고른 소스 하나로 강제 조회하고 싶을 때 직접 켜는 정식 기능(2026-07-30
  // 격상, 원래는 디버깅용으로 기본 켜짐이었음).
  const [forceSource, setForceSource] = useState(false)
  useEffect(() => {
    // tier2/3(사전 소스 자체가 없는 언어)는 조회할 필요가 없다 — 빈 배열로 두면
    // Toolbar 가 이미 showAiDictionary=false 로 드롭다운 자체를 숨긴다.
    if (!isFullLanguage(currentCtx.language)) {
      setDictSources([])
      setSelectedSource(undefined)
      return
    }
    let active = true
    void window.nuance.getDictionarySources(currentCtx.language).then((sources) => {
      if (!active) return
      setDictSources(sources)
      setSelectedSource(sources[0]?.id)
    })
    return () => {
      active = false
    }
  }, [currentCtx.language])

  // ---- 채팅 상태 -------------------------------------------------------------
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const streamingIdRef = useRef<string | null>(null)

  // 팝업 창이 닫혔다 새로 뜨는 대신 재사용되면서(2026-07-29, windows.ts: createPopupWindow)
  // 새 baseCtx 를 받을 때마다 이전 대화를 비운다 — 창을 매번 새로 만들던 때는 이게 저절로
  // 됐지만, 이제는 명시적으로 지워야 이전 선택의 채팅 로그가 새 선택 화면에 남아 헷갈리는
  // 문제(창을 재사용했던 예전 버전에서 실제로 있었던 사용자 불만)가 재발하지 않는다.
  useEffect(() => {
    setMessages([])
    setBusy(false)
    streamingIdRef.current = null
  }, [baseCtx])

  // 스트리밍 델타 라우팅 — 진행 중 assistant 말풍선에 append
  useEffect(() => {
    return window.nuance.onQuestionStream((chunk: QuestionResult) => {
      const id = streamingIdRef.current
      if (!id) return
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m
          if (chunk.error) return { ...m, content: chunk.content, error: chunk.error, streaming: false }
          if (chunk.meta?.streaming) return { ...m, content: m.content + chunk.content }
          return m
        }),
      )
    })
  }, [])

  // 채팅창에 사용자 말풍선(userLabel)을 남기고 req 를 요청, 답변을 assistant 말풍선에 스트리밍한다.
  async function send(userLabel: string, req: QuestionRequest) {
    if (busy) return
    setBusy(true)

    const userMsg: ChatMessage = { id: newId(), role: 'user', content: userLabel }
    const asstId = newId()
    streamingIdRef.current = asstId
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: asstId, role: 'assistant', content: '', streaming: true },
    ])

    const result = await window.nuance.question(currentCtx, req)

    setMessages((prev) =>
      prev.map((m) =>
        m.id === asstId
          ? { ...m, content: result.content, error: result.error, streaming: false }
          : m,
      ),
    )
    streamingIdRef.current = null
    setBusy(false)
  }

  function ask(prompt: string) {
    const history: ChatTurn[] = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))
    return send(prompt, { type: 'ask', prompt, history })
  }

  // 발음 / 사전 버튼 — 누르면 즉시 요청. 채팅창 라벨은 실제 LLM user 메시지에서
  // "[선택된 표현]" 자리표시자만 실제 선택 텍스트로 바꿔 보여준다(LLM에 보내는 req 는 그대로).
  function askPronunciation() {
    return send(PRONUNCIATION_QUESTION.replace('[선택된 표현]', currentCtx.selectedText), {
      type: 'pronunciation',
    })
  }
  function askDictionary() {
    return send(DICTIONARY_QUESTION.replace('[선택된 표현]', currentCtx.selectedText), {
      type: 'dictionary',
      source: forceSource ? selectedSource : undefined,
    })
  }

  function google(mode: 'pron' | 'image') {
    window.nuance.openGoogle(mode, currentCtx.selectedText, currentCtx.language)
  }

  function naverDict() {
    window.nuance.openNaverDict(currentCtx.selectedText, currentCtx.language)
  }

  // ---- 자주 쓰는 질문 (main 프로세스 userData/frequent.json 에 영속) --------
  const [frequent, setFrequent] = useState<string[]>([])
  useEffect(() => {
    let active = true
    void loadFrequent().then((list) => {
      if (active) setFrequent(list)
    })
    return () => {
      active = false
    }
  }, [])
  function updateFrequent(list: string[]) {
    setFrequent(list)
    saveFrequent(list)
  }

  return (
    <div className="screen popup-screen">
      <header className="popup-header">
        <span className="src">
          {sourceLabel(baseCtx)} · {getLanguageName(baseCtx.language)}({languageSourceLabel(languageOverridden)})
        </span>
        <span className="esc-hint">ESC</span>
        <button className="icon-btn close" title="닫기" onClick={() => window.close()}>
          ✕
        </button>
      </header>

      <div className="popup-body">
        <section className="context">
          <div className="ctx-head">
            <span className="ctx-label">범위 지정</span>
            <span className="ctx-hint">선택한 표현은 자동으로 클립보드에 복사돼요</span>
            {isCjkLikeLanguage(baseCtx.language) && (
              <label className="char-level-toggle ctx-char-level-toggle">
                <input
                  type="checkbox"
                  checked={charLevel}
                  disabled={busy}
                  onChange={(e) => setCharLevel(e.target.checked)}
                />
                문자 단위 선택
              </label>
            )}
          </div>
          <ContextView
            rootRef={ctxRootRef}
            model={model}
            from={range.from}
            to={range.to}
            onChange={(from, to) => updateRange(from, to)}
            charLevel={charLevel}
            dir={isRtlLanguage(baseCtx.language) ? 'rtl' : 'ltr'}
            className={langFontClassName(baseCtx.language)}
          />
        </section>

        <Toolbar
          onPron={askPronunciation}
          onDict={askDictionary}
          onGoogle={google}
          onNaverDict={naverDict}
          disabled={busy}
          currentModel={currentModel}
          showNaverDict={hasNaverDict(baseCtx.language)}
          showAiDictionary={isFullLanguage(baseCtx.language)}
          dictSources={dictSources}
          selectedSource={selectedSource}
          onSelectSource={setSelectedSource}
          forceSource={forceSource}
          onToggleForceSource={setForceSource}
        />

        <Chat messages={messages} onSend={ask} busy={busy} className={langFontClassName(baseCtx.language)} />

        <FrequentQuestions items={frequent} onAsk={ask} onChange={updateFrequent} disabled={busy} />
      </div>
    </div>
  )
}

// 넷플릭스 워치 URL처럼 트래킹 쿼리스트링이 길게 붙는 출처는 원문 그대로 보여주면
// (CSS 말줄임만 믿으면) 전체 헤더 폭을 URL 혼자 다 잡아먹어, 그 뒤에 이어 붙는 언어
// 라벨이 화면 밖으로 밀려 아예 안 보이는 문제가 있었다(사용자 피드백, 2026-07-29 —
// 넷플릭스 URL 헤더에서 "· English/日本語" 부분이 안 보임). 여기서 먼저 적당한 길이로
// 잘라 "..."을 붙여두면, 뒤에 오는 언어 라벨은 항상 보이는 폭 안에 들어온다.
const SOURCE_LABEL_MAX_LENGTH = 60

// youtube/netflix는 URL(시청 기록·영상 ID 노출)을 그대로 보여주지 않고 서비스 이름으로,
// txt/ocr/pdf/epub은 appName이 아직 없어(readActiveWindow 미구현) kind 자체를 라벨로 쓰되
// 대문자 표기로 통일한다(사용자 요청, 2026-07-30).
const SOURCE_KIND_LABEL: Partial<Record<ExtractedSelection['source']['kind'], string>> = {
  youtube: 'Youtube',
  netflix: 'Netflix',
  txt: 'TXT',
  ocr: 'OCR',
  pdf: 'PDF',
  epub: 'EPUB'
}

function sourceLabel(ex: ExtractedSelection): string {
  const fixed = SOURCE_KIND_LABEL[ex.source.kind]
  const raw = fixed ?? ex.source.appName ?? ex.source.url ?? ex.source.kind
  return raw.length > SOURCE_LABEL_MAX_LENGTH ? `${raw.slice(0, SOURCE_LABEL_MAX_LENGTH)}...` : raw
}

function languageSourceLabel(isManual: boolean): string {
  return isManual ? '사용자 지정' : '자동 판별'
}

// ja/zh-Hans/zh-Hant만 "글자 단위" 토글이 있다 — 형태소 분석(jaResult/zhWords)으로 만든
// 단어 단위 atom이 있어야 그걸 글자 단위로 재분할하는 토글이 의미가 있다. 태국어/라오어
// (공백 없는 tier2 언어)는 애초에 단어 단위 옵션 자체가 없어(형태소 분석기 미지원,
// 2026-07-30 결정) 토글 없이 항상 글자 단위다 — buildSelectionModel/selection.ts 참고.
function isCjkLikeLanguage(lang: ExtractedSelection['language']): boolean {
  return lang === 'ja' || lang === 'zh-Hans' || lang === 'zh-Hant'
}

// 일본어/중국어는 body 기본 폰트(Noto Sans KR)에 가나/한자 글리프가 없어 OS 시스템 폰트로
// 폴백되는데, 원문 문맥(ContextView)만 이 클래스로 번들 Noto Sans JP/SC/TC를 명시하고
// 채팅(LLM 응답)은 빠져 있어 같은 팝업 안에서 자형이 서로 달라 보이는 문제가 있었다
// (2026-07-30 사용자 지적) — 채팅에도 같은 클래스를 적용해 통일한다.
function langFontClassName(lang: ExtractedSelection['language']): string | undefined {
  switch (lang) {
    case 'ja':
      return 'lang-ja'
    case 'zh-Hans':
      return 'lang-zh-hans'
    case 'zh-Hant':
      return 'lang-zh-hant'
    default:
      return undefined
  }
}
