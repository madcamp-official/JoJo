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
import { sentenceEnd, sentenceStart } from '@shared/context'
import { DICTIONARY_QUESTION, PRONUNCIATION_QUESTION } from '@shared/questionText'
import { ContextView } from './popup/ContextView'
import { Toolbar } from './popup/Toolbar'
import { Chat } from './popup/Chat'
import { FrequentQuestions } from './popup/FrequentQuestions'
import {
  buildDisplayText,
  buildSelectionModel,
  deriveContext,
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
// 담당 B — 팝업 화면 (PLAN.md §3/§4.2)
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
  const [measuredRange, setMeasuredRange] = useState<{ start: number; end: number } | null>(null)
  // 측정 대상 텍스트를 앵커 주변 일정 문자 수로 제한 — extracted.text 전체(문서 전체)를
  // 매 문자 Range 쿼리로 재는 건 낭비이고, 실제로 필요한 3~7줄보다 훨씬 넉넉한 예산이라
  // 잘릴 걱정 없이 성능만 보호한다.
  const MEASURE_TEXT_BUDGET = 4000
  useLayoutEffect(() => {
    setMeasuredRange(null) // baseCtx 가 바뀌면 재측정 전까지 문단 기반 근사치로 되돌아감
    const el = ctxRootRef.current
    if (!el) return
    const fullText = baseCtx.text
    const sliceStart = Math.max(0, baseCtx.anchor.start - MEASURE_TEXT_BUDGET)
    const sliceEnd = Math.min(fullText.length, baseCtx.anchor.end + MEASURE_TEXT_BUDGET)
    const measured = measureVisualLineRange(
      el,
      fullText.slice(sliceStart, sliceEnd),
      baseCtx.anchor.start - sliceStart,
      baseCtx.anchor.end - sliceStart,
      DISPLAY_CONTEXT_LINES_BEFORE,
      DISPLAY_CONTEXT_LINES_AFTER,
    )
    if (!measured) return
    const absStart = measured.start + sliceStart
    const absEnd = measured.end + sliceStart
    // sentenceEnd(text, p)는 "p가 아직 문장 중간이면 그 문장 끝까지 확장"하는 함수라,
    // absEnd(슬라이스 끝 — 다음 줄의 "첫 글자" 오프셋, exclusive)를 그대로 넘기면 그
    // 위치가 하필 다음 문장의 시작과 겹칠 때(줄 기반 자막처럼 "한 줄 = 한 문장"인
    // 텍스트에서 흔함) "이 문장이 아직 안 끝났다"고 오인해 그 다음 문장 전체를 통째로
    // 삼켜버리는 버그가 있었다(실사용 확인, 2026-07-29 — "course" 선택 시 그 뒤로
    // 원래 3줄이어야 할 범위에 무관한 한 문장이 더 붙어 나옴). "포함된 마지막 글자"
    // (absEnd - 1) 기준으로 확인해야 이미 문장이 끝난 위치를 "아직 안 끝남"으로
    // 오판하지 않는다 — absStart(포함된 첫 글자, inclusive)는 애초에 이 문제가 없어
    // sentenceStart 는 그대로 둔다.
    setMeasuredRange({
      start: sentenceStart(fullText, absStart),
      end: sentenceEnd(fullText, Math.max(absStart, absEnd - 1)),
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
  const lastSpanRef = useRef<{ start: number; end: number } | null>(null)
  const prevBaseCtxRef = useRef(baseCtx)

  function updateRange(from: number, to: number): void {
    setRange({ from, to })
    const a = model.atoms[from]
    const b = model.atoms[to]
    if (a && b) lastSpanRef.current = { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) }
  }

  // model 이 바뀔 때(baseCtx 자체가 바뀜 / charLevel 토글 / jaResult·zhWords 도착 등) 항상
  // model.initialFrom/To(=처음 클릭된 anchor)로 리셋하면, "글자 단위" 토글처럼 atom
  // 경계만 재분할되고 사용자가 실제로 드래그해둔 선택은 그대로 유지돼야 하는 경우에도
  // 선택이 초기화돼버리는 버그가 있었다(실사용 확인, 2026-07-29 — 글자 단위 선택 토글을
  // 누르면 드래그해둔 범위가 사라짐). baseCtx 자체가 바뀐 경우(진짜 다른 선택으로 교체)만
  // initialFrom/To로 리셋하고, 그 외(같은 baseCtx인데 atoms 구조만 바뀐 경우)는 직전
  // 선택의 문자 범위(lastSpanRef)와 겹치는 새 atom 인덱스로 재매핑해 선택을 유지한다.
  useEffect(() => {
    const baseCtxChanged = prevBaseCtxRef.current !== baseCtx
    prevBaseCtxRef.current = baseCtx
    const span = baseCtxChanged ? null : lastSpanRef.current

    if (span) {
      let newFrom = -1
      let newTo = -1
      for (let i = 0; i < model.atoms.length; i++) {
        const atom = model.atoms[i]!
        if (atom.end > span.start && atom.start < span.end) {
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
  useEffect(() => {
    if (!currentCtx.selectedText) return
    navigator.clipboard.writeText(currentCtx.selectedText).catch(() => {
      // 클립보드 접근 실패는 조용히 무시 — 핵심 기능(선택/질문)에 영향 없음
    })
  }, [currentCtx.selectedText])

  // ---- 사전 소스 선택(임시 디버깅용, 2026-07-28) -----------------------------
  // en/ja/zh 사전 어댑터가 각자 다른 워크트리에서 병렬 구현 중이라, 실제 폴백
  // 오케스트레이션이 갖춰지기 전까지 어느 소스로 검색할지 직접 골라볼 수 있게 한다.
  // 언어가 바뀔 때마다 그 언어에 실제로 구현된(파일이 존재하는) 소스 목록을 다시
  // 조회하고, 폴백 순위 1순위를 기본 선택값으로 삼는다 — main/question/dictionary/
  // registry.ts 가 자동 감지하므로 여기서는 그냥 받아서 보여주기만 하면 된다.
  const [dictSources, setDictSources] = useState<DictionarySourceOption[]>([])
  const [selectedSource, setSelectedSource] = useState<DictionarySourceId | undefined>(undefined)
  // 기본값은 켜짐(직접 선택) — 사용자 요청(2026-07-28)으로 정식 폴백 체인(dictionary.ts
  // FALLBACK_CHAINS) 대신 위 드롭다운에서 고른 소스를 기본으로 강제 호출한다. 꺼서
  // 정식 폴백 체인을 다시 켤 수도 있다(디버깅/비교용).
  const [forceSource, setForceSource] = useState(true)
  useEffect(() => {
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
          {sourceLabel(baseCtx)} · {LANGUAGE_LABEL[baseCtx.language]}
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
          </div>
          <ContextView
            rootRef={ctxRootRef}
            model={model}
            from={range.from}
            to={range.to}
            onChange={(from, to) => updateRange(from, to)}
            charLevel={charLevel}
            className={
              baseCtx.language === 'ja'
                ? 'lang-ja'
                : baseCtx.language === 'zh-Hans' || baseCtx.language === 'zh-Hant'
                  ? 'lang-zh'
                  : undefined
            }
          />
        </section>

        <Toolbar
          onPron={askPronunciation}
          onDict={askDictionary}
          onGoogle={google}
          onNaverDict={naverDict}
          disabled={busy}
          dictSources={dictSources}
          selectedSource={selectedSource}
          onSelectSource={setSelectedSource}
          forceSource={forceSource}
          onToggleForceSource={setForceSource}
          showCharLevelToggle={baseCtx.language !== 'en'}
          charLevel={charLevel}
          onToggleCharLevel={setCharLevel}
        />

        <Chat messages={messages} onSend={ask} busy={busy} />

        <FrequentQuestions items={frequent} onAsk={ask} onChange={updateFrequent} disabled={busy} />
      </div>
    </div>
  )
}

// 넷플릭스 워치 URL처럼 트래킹 쿼리스트링이 길게 붙는 출처는 원문 그대로 보여주면
// (CSS 말줄임만 믿으면) 전체 헤더 폭을 URL 혼자 다 잡아먹어, 그 뒤에 이어 붙는 언어
// 라벨(LANGUAGE_LABEL)이 화면 밖으로 밀려 아예 안 보이는 문제가 있었다(사용자 피드백,
// 2026-07-29 — 넷플릭스 URL 헤더에서 "· English/日本語" 부분이 안 보임). 여기서 먼저
// 적당한 길이로 잘라 "..."을 붙여두면, 뒤에 오는 언어 라벨은 항상 보이는 폭 안에 들어온다.
const SOURCE_LABEL_MAX_LENGTH = 60

function sourceLabel(ex: ExtractedSelection): string {
  const raw = ex.source.appName ?? ex.source.url ?? ex.source.kind
  return raw.length > SOURCE_LABEL_MAX_LENGTH ? `${raw.slice(0, SOURCE_LABEL_MAX_LENGTH)}...` : raw
}

const LANGUAGE_LABEL: Record<ExtractedSelection['language'], string> = {
  en: 'English',
  ja: '日本語',
  'zh-Hans': '中文(简体)',
  'zh-Hant': '中文(繁體)',
}
