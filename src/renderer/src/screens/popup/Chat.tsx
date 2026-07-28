import { useEffect, useRef, useState } from 'react'
import type { AnchorHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from './types'

// 담당 B — 채팅 영역 (질문/답변 말풍선 + 스트리밍 렌더 + 입력창) — PLAN.md §4.2

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

interface Props {
  messages: ChatMessage[]
  onSend: (prompt: string) => void
  busy: boolean
}

export function Chat({ messages, onSend, busy }: Props) {
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
    <div className="chat">
      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-empty">선택한 표현에 대해 궁금한 점을 물어보세요.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`bubble ${m.role} ${m.error ? 'error' : ''} ${m.streaming ? 'streaming' : ''}`}
          >
            {m.error ? (
              <div className="err-body">
                <strong>⚠️ {errorTitle(m.error.code)}</strong>
                <span>{m.content}</span>
              </div>
            ) : m.role === 'assistant' ? (
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                  {m.content}
                </ReactMarkdown>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          rows={1}
          value={input}
          placeholder="궁금한 내용을 입력하세요…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
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
