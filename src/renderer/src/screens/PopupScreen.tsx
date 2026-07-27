import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatTurn,
  ExtractedSelection,
  JaTokenizeResult,
  QuestionRequest,
  QuestionResult,
  ZhWord,
} from '@shared/types'
import { DICTIONARY_QUESTION, PRONUNCIATION_QUESTION } from '@shared/questionText'
import { ContextView } from './popup/ContextView'
import { Toolbar } from './popup/Toolbar'
import { Chat } from './popup/Chat'
import { FrequentQuestions } from './popup/FrequentQuestions'
import { buildDisplayText, buildSelectionModel, deriveContext } from './popup/selection'
import {
  mockDevotionExtraction,
  mockHobbitExtraction,
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
//   - 데모(현재): ctx 가 없으면 목업으로 fallback한다 — 기본은 호빗 "well-to-do",
//     MainScreen 의 언어별 데모 버튼으로 열었을 때(#/popup?demo=ja 또는 zh)는
//     각각 《容疑者Xの献身》"新大橋" / 《三体》"天线"(간체).
// ============================================================================

/** 팝업 창 URL 해시(#/popup?demo=zh)에서 demo 쿼리값을 읽는다. */
function getDemoParam(): string | null {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('demo')
}

function initialMockExtraction(): ExtractedSelection {
  switch (getDemoParam()) {
    case 'ja':
      return mockDevotionExtraction()
    case 'zh-Hans':
      return mockThreeBodyExtraction()
    default:
      return mockHobbitExtraction()
  }
}

export function PopupScreen() {
  const [baseCtx, setBaseCtx] = useState<ExtractedSelection>(initialMockExtraction)

  // main 에서 실제 컨텍스트를 받으면 교체(초기 조회 + 창 재사용 시 갱신 통지)
  useEffect(() => {
    let active = true
    window.nuance.getPopupContext().then((ctx) => {
      if (active && ctx) setBaseCtx(ctx)
    })
    return window.nuance.onPopupContext((ctx) => {
      if (ctx) setBaseCtx(ctx)
    })
  }, [])

  // Esc 로 팝업 닫기 (헤더 ✕ 와 동일 동작)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 일본어는 가나 조각을 main/nlp/japanese.ts 의 활성 엔진(JA_ENGINE) 품사 기반으로
  // 병합한다 — 사전/모델 로드가 끝날 때까지의 짧은 순간은 즉석 대체 규칙(selection.ts
  // segmentKanaRunFallback)으로 먼저 그린다. displayText 는 형태소 분석에 넘길 대상
  // 문자열(atom 과 무관)이라 먼저 따로 계산한다. engine 태그를 같이 받아야 selection.ts
  // 가 IPADIC/UniDic 중 맞는 병합 함수를 고를 수 있다.
  const displayText = useMemo(() => buildDisplayText(baseCtx).displayText, [baseCtx])
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

  // 중국어는 segmentit(main/nlp/chinese.ts) 단어 경계를 그대로 atom 으로 쓴다 — OCR 단어
  // 클릭(main/selection/ocr.ts)과 동일한 분석 결과라 병합 규칙 없이 바로 쓸 수 있다.
  const [zhWords, setZhWords] = useState<ZhWord[] | undefined>(undefined)
  useEffect(() => {
    setZhWords(undefined)
    if (baseCtx.language !== 'zh-Hans' && baseCtx.language !== 'zh-Hant') return
    let active = true
    window.nuance.tokenizeChinese(displayText).then((words) => {
      if (active) setZhWords(words)
    })
    return () => {
      active = false
    }
  }, [baseCtx.language, displayText])

  const model = useMemo(
    () => buildSelectionModel(baseCtx, jaResult, zhWords),
    [baseCtx, jaResult, zhWords],
  )
  const [range, setRange] = useState({ from: model.initialFrom, to: model.initialTo })

  // baseCtx(=model)가 바뀌면 초기 선택으로 리셋
  useEffect(() => {
    setRange({ from: model.initialFrom, to: model.initialTo })
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

  // ---- 채팅 상태 -------------------------------------------------------------
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const streamingIdRef = useRef<string | null>(null)

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
        <button className="icon-btn close" title="닫기" onClick={() => window.close()}>
          ✕
        </button>
      </header>

      <div className="popup-body">
        <section className="context">
          <div className="ctx-head">
            <span className="ctx-label">범위 지정</span>
            <span className="ctx-hint">드래그로 범위를 다시 지정할 수 있어요</span>
          </div>
          <ContextView
            model={model}
            from={range.from}
            to={range.to}
            onChange={(from, to) => setRange({ from, to })}
          />
        </section>

        <Toolbar
          onPron={askPronunciation}
          onDict={askDictionary}
          onGoogle={google}
          onNaverDict={naverDict}
          disabled={busy}
        />

        <Chat messages={messages} onSend={ask} busy={busy} />

        <FrequentQuestions items={frequent} onAsk={ask} onChange={updateFrequent} disabled={busy} />
      </div>
    </div>
  )
}

function sourceLabel(ex: ExtractedSelection): string {
  return ex.source.appName ?? ex.source.url ?? ex.source.kind
}

const LANGUAGE_LABEL: Record<ExtractedSelection['language'], string> = {
  en: 'English',
  ja: '日本語',
  'zh-Hans': '中文(简体)',
  'zh-Hant': '中文(繁體)',
}
