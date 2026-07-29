import { LlmHttpError } from './errors'

// 담당 B — SSE(Server-Sent Events) 스트림 파서 (provider 공통)
// fetch 응답 body 를 읽어 각 이벤트의 `data:` 페이로드 문자열을 순차 방출한다.

export async function* readSse(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error('스트림 응답 body 가 없습니다')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  function* emit(rawEvent: string): Generator<string> {
    for (const line of rawEvent.split('\n')) {
      const m = /^data:\s?(.*)$/.exec(line)
      if (m) yield m[1]
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Gemini(streamGenerateContent)는 SSE 줄바꿈을 \r\n(CRLF)으로 보낸다(GPT/Claude는
      // \n) — 실측 확인(2026-07-29, 실API 직접 호출 바이트 덤프): "\n\n" 그대로 찾으면
      // 이벤트 구분자가 "\r\n\r\n"라 절대 못 찾고, 매 줄 끝에 남는 "\r" 때문에 아래
      // emit() 의 정규식(`.`이 개행류 문자는 매칭 안 함, `\r` 포함)도 매 줄마다 실패해서
      // Gemini 응답에서만 텍스트를 단 한 글자도 못 뽑는 조용한 버그가 있었다 — 예외 없이
      // `full`이 빈 문자열로 끝나 호출부가 "정상 응답인데 내용이 없음"으로만 보였다
      // (사전 질문이 "문맥에 맞는 뜻을 찾지 못했습니다"로 항상 실패, 자유 질문/발음 질문도
      // 똑같이 빈 답변이었을 것). \r\n → \n 으로 정규화해 두 표기를 모두 지원한다.
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let sep: number
      // 이벤트는 빈 줄(\n\n)로 구분된다.
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        yield* emit(buf.slice(0, sep))
        buf = buf.slice(sep + 2)
      }
    }
    // 스트림이 \n\n 없이 끝난 경우 남은 버퍼를 마지막 이벤트로 처리한다.
    buf += decoder.decode().replace(/\r\n/g, '\n')
    if (buf.trim()) yield* emit(buf)
  } finally {
    reader.releaseLock()
  }
}

/** 응답이 실패면 본문을 읽어 LlmHttpError 를 던진다 (호출부에서 classifyLlmError 로 분류). */
export async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    /* ignore */
  }
  throw new LlmHttpError(res.status, detail, `${label} 요청 실패 (${res.status}): ${detail.slice(0, 500)}`)
}
