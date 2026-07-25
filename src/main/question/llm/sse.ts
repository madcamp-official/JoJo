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
      buf += decoder.decode(value, { stream: true })

      let sep: number
      // 이벤트는 빈 줄(\n\n)로 구분된다.
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        yield* emit(buf.slice(0, sep))
        buf = buf.slice(sep + 2)
      }
    }
    // 스트림이 \n\n 없이 끝난 경우 남은 버퍼를 마지막 이벤트로 처리한다.
    buf += decoder.decode()
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
