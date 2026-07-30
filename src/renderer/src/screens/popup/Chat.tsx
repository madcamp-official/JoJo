import { useEffect, useRef, useState } from 'react'
import type { AnchorHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from './types'

// 담당 B — 채팅 영역 (질문/답변 말풍선 + 스트리밍 렌더 + 입력창) — PLAN.md §5.2

// 마크다운 안 링크(사전 출처 등, senseSelect.ts formatDictionaryAnswer 참고) 클릭 시
// 기본 동작(Electron 렌더러 안에서 그 URL로 그대로 이동해버림 — 팝업 UI가 사라지는
// 문제)을 막고, 구글/네이버 버튼과 동일한 방식(openUrlInNewWindow, 기본 브라우저의
// 새 창)으로 열도록 재정의한다. react-markdown이 만드는 <a> 전부에 적용되므로 채팅에
// 링크가 더 늘어도(예: 다른 사전 소스) 별도 배선 없이 전부 이 경로를 탄다.
function MarkdownLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      onClick={(e) => {
        e.preventDefault()
        if (props.href) void window.nuance.openExternalLink(props.href)
      }}
    />
  )
}

/** react-markdown(정확히는 내부 micromark)의 CommonMark 강조 규칙 때문에, **볼드**의 닫는
 *  `**` 바로 앞이 닫는 문장부호(）」. 등)이고 바로 뒤에 공백/문장부호 없이 다른 글자가
 *  바로 이어지면 그 `**`가 "right-flanking"으로 인정되지 않아 볼드로 파싱되지 않고
 *  별표가 그대로 노출된다(실측: "**清洲（きよす）**는" → 별표 그대로 보임, "**清洲（きよす）**."
 *  → 정상 렌더 — 뒤에 오는 게 마침표인지 조사인지에 따라 갈림, micromark
 *  classify-character.js 직접 확인). 이 앱은 일본어/중국어 표제어+읽기를 볼드로 감싼 뒤
 *  한국어 조사(는/가/을/를 등)를 뒤이어 붙이는 문장이 실제로 자주 나오는데, 조사는 원래
 *  띄어쓰기 없이 붙는 게 맞는 한국어 문법이라 LLM에 "띄어 써 달라"고 시킬 수도 없다 —
 *  렌더링 쪽에서 우회한다. 닫는 `**` 바로 뒤에 폭 0인 U+FEFF(ZERO WIDTH NO-BREAK SPACE)를
 *  끼워 넣는다 — micromark의 공백 판정이 내부적으로 JS 정규식 `\s`를 그대로 쓰는데, 이
 *  `\s`가 U+FEFF를 공백으로 인식하는 걸 이용한 것(실측 확인: U+200B/U+2060 같은 다른
 *  zero-width 문자는 이 판정을 통과 못 해 효과 없었음). 화면엔 아무 폭도 없어 보이지
 *  않는다. **여는** `**` 뒤가 아니라 **닫는** `**` 뒤에만 붙여야 한다 — 여는 쪽에 붙이면
 *  반대로 그 여는 델리미터가 "left-flanking" 자격을 잃어 볼드 자체가 안 열린다. 굵게
 *  강조된 문장부호가 나올 일이 거의 없어 볼드 안에 `*`가 없는 가장 흔한 경우만 다룬다
 *  (안에 `*`가 있는 중첩 강조는 이 정규식에 안 걸려 원래 동작 그대로 — 스코프 밖).  */
const ZWNBSP = '﻿'
function fixAmbiguousBoldClosing(text: string): string {
  return text.replace(/\*\*([^\n*]+?)\*\*/g, (_match, inner: string) => `**${inner}**${ZWNBSP}`)
}

interface Props {
  messages: ChatMessage[]
  onSend: (prompt: string) => void
  busy: boolean
  /** 원문 언어에 맞는 번들 폰트 클래스(lang-ja/lang-zh-hans/lang-zh-hant, PopupScreen.tsx
   *  langFontClassName) — ContextView와 자형을 통일하기 위해 그대로 전달받는다. */
  className?: string
}

export function Chat({ messages, onSend, busy, className }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 새 메시지/스트리밍 청크마다 맨 아래로
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  function submit() {
    const v = input.trim()
    if (!v || busy) return
    onSend(v)
    setInput('')
  }

  return (
    <div className={`chat ${className ?? ''}`}>
      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-empty">선택한 표현에 대해 궁금한 점을 물어보세요.</p>
        )}
        {messages.map((m) => {
          const progressLines = m.progress ?? []
          return (
          <div
            key={m.id}
            className={`bubble ${m.role} ${m.error ? 'error' : ''} ${m.streaming ? 'streaming' : ''}`}
          >
            {/* 진행 상황(사전 검색 단계별 안내) — 답변이 도착하기 전까지만 본문 위에
                흐리게 쌓아 보여준다. 최종 결과가 오면 PopupScreen 이 progress 를 비워
                자동으로 사라진다(마지막 줄만 강조해 "지금 하는 일"을 드러냄). */}
            {progressLines.length > 0 && (
              <div className="bubble-progress">
                {progressLines.map((line, i) => (
                  <div key={i} className={i === progressLines.length - 1 ? 'now' : undefined}>
                    {line}
                  </div>
                ))}
              </div>
            )}
            {m.error ? (
              <div className="err-body">
                <strong>⚠️ {errorTitle(m.error.code)}</strong>
                <span>{m.content}</span>
              </div>
            ) : m.role === 'assistant' ? (
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                  {fixAmbiguousBoldClosing(m.content)}
                </ReactMarkdown>
              </div>
            ) : (
              m.content
            )}
          </div>
          )
        })}
      </div>

      <div className="chat-input">
        <textarea
          rows={1}
          value={input}
          placeholder="궁금한 내용을 입력하세요…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 한글 등 IME 조합 중에 Enter를 누르면, 아직 조합 중인 마지막 글자가 input
            // 상태에 반영(onChange)되기 전에 submit()이 먼저 실행돼 그 글자가 입력창에
            // 남는 문제가 있었다(예: "...출력해" 입력 후 Enter → "해"만 남음) —
            // isComposing 이면 제출하지 않고 IME가 조합을 끝내도록 둔다.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="send-btn" onClick={submit} disabled={busy || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  )
}

function errorTitle(code: string): string {
  switch (code) {
    case 'no_active_provider':
      return 'AI 모델 미설정'
    case 'no_api_key':
    case 'invalid_api_key':
      return 'API 키 문제'
    case 'insufficient_credit':
      return '사용 한도 부족'
    case 'rate_limited':
      return '요청 과다'
    case 'invalid_model':
      return '모델을 찾을 수 없음'
    case 'network_error':
      return '네트워크 오류'
    default:
      return '오류'
  }
}
