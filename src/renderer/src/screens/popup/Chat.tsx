import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from './types'

// 담당 B — 채팅 영역 (질문/답변 말풍선 + 스트리밍 렌더 + 입력창) — PLAN.md §4.2

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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
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
