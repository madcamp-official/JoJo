import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatTurn, ExtractedSelection, QuestionResult } from '@shared/types'
import { ContextView } from './popup/ContextView'
import { Toolbar } from './popup/Toolbar'
import { Chat } from './popup/Chat'
import { FrequentQuestions } from './popup/FrequentQuestions'
import { buildSelectionModel, deriveContext } from './popup/selection'
import { mockHobbitExtraction } from './popup/mockSelection'
import { loadFrequent, saveFrequent } from './popup/frequentStore'
import { newId, type ChatMessage } from './popup/types'

// ============================================================================
// 담당 B — 팝업 화면 (PLAN.md §3/§4.2)
// 선택 확정 후 뜨는 검색·채팅 팝업. 위→아래:
//   헤더(드래그 이동) · 원문 문맥(범위 재지정) · 툴바 · 발음/사전 결과 · 채팅 · 자주 쓰는 질문
//
// 데이터 진입:
//   - 실제(담당 A 통합): main 이 createPopupWindow(ctx) 로 넘긴 ExtractedSelection 을
//     getPopupContext()/onPopupContext() 로 받는다.
//   - 데모(현재): ctx 가 없으면 호빗 "well-to-do" 목업으로 fallback 한다.
// ============================================================================

export function PopupScreen() {
  const [baseCtx, setBaseCtx] = useState<ExtractedSelection>(() => mockHobbitExtraction())

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

  const model = useMemo(() => buildSelectionModel(baseCtx), [baseCtx])
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

  async function ask(prompt: string) {
    if (busy) return
    setBusy(true)

    const history: ChatTurn[] = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))

    const userMsg: ChatMessage = { id: newId(), role: 'user', content: prompt }
    const asstId = newId()
    streamingIdRef.current = asstId
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: asstId, role: 'assistant', content: '', streaming: true },
    ])

    const result = await window.nuance.question(currentCtx, { type: 'ask', prompt, history })

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

  // ---- 발음 / 사전 (체크박스 토글) ------------------------------------------
  const [pronOn, setPronOn] = useState(false)
  const [dictOn, setDictOn] = useState(false)
  const [pronResult, setPronResult] = useState<QuestionResult | null>(null)
  const [dictResult, setDictResult] = useState<QuestionResult | null>(null)

  async function togglePron() {
    const next = !pronOn
    setPronOn(next)
    if (!next) return setPronResult(null)
    const r = await window.nuance.question(currentCtx, { type: 'pronunciation' })
    setPronResult(r)
  }
  async function toggleDict() {
    const next = !dictOn
    setDictOn(next)
    if (!next) return setDictResult(null)
    const r = await window.nuance.question(currentCtx, { type: 'dictionary' })
    setDictResult(r)
  }

  // 선택이 바뀌면 이전 발음/사전 결과는 무효 → 다시 체크하도록 리셋
  useEffect(() => {
    setPronOn(false)
    setDictOn(false)
    setPronResult(null)
    setDictResult(null)
  }, [currentCtx.selectedText])

  function google(mode: 'pron' | 'image') {
    window.nuance.openGoogle(mode, currentCtx.selectedText, currentCtx.language)
  }

  // ---- 자주 쓰는 질문 --------------------------------------------------------
  const [frequent, setFrequent] = useState<string[]>(() => loadFrequent())
  function updateFrequent(list: string[]) {
    setFrequent(list)
    saveFrequent(list)
  }

  return (
    <div className="screen popup-screen">
      <header className="popup-header">
        <span className="src">
          {sourceLabel(baseCtx)} · {baseCtx.language.toUpperCase()}
        </span>
        <button className="icon-btn close" title="닫기" onClick={() => window.close()}>
          ✕
        </button>
      </header>

      <div className="popup-body">
        <section className="context">
          <div className="ctx-head">
            <span className="ctx-label">원문 문맥</span>
            <span className="ctx-hint">드래그로 범위를 다시 지정할 수 있어요</span>
          </div>
          <ContextView
            model={model}
            from={range.from}
            to={range.to}
            onChange={(from, to) => setRange({ from, to })}
          />
          <div className="selected-line">
            선택: <b>{currentCtx.selectedText}</b>
          </div>
        </section>

        <Toolbar
          language={currentCtx.language}
          pron={pronOn}
          dict={dictOn}
          onTogglePron={togglePron}
          onToggleDict={toggleDict}
          onGoogle={google}
          disabled={busy}
        />

        {(pronOn || dictOn) && (
          <div className="info-panel">
            {pronOn && <InfoRow label="발음" result={pronResult} />}
            {dictOn && <InfoRow label="사전" result={dictResult} />}
          </div>
        )}

        <Chat messages={messages} onSend={ask} busy={busy} />

        <FrequentQuestions items={frequent} onAsk={ask} onChange={updateFrequent} disabled={busy} />
      </div>
    </div>
  )
}

function InfoRow({ label, result }: { label: string; result: QuestionResult | null }) {
  return (
    <div className="info-row">
      <span className="info-tag">{label}</span>
      {result == null ? (
        <span className="muted">불러오는 중…</span>
      ) : result.error ? (
        <span className="muted">{result.content}</span>
      ) : result.content ? (
        <span>{result.content}</span>
      ) : (
        <span className="muted">아직 구현되지 않은 기능입니다(스텁).</span>
      )}
    </div>
  )
}

function sourceLabel(ex: ExtractedSelection): string {
  return ex.source.appName ?? ex.source.url ?? ex.source.kind
}
