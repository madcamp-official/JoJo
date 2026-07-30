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

/** cacheableContext(문맥 블록)를 system 프롬프트에 합쳐 넣는다 — GPT/Gemini 는 Claude 와
 *  달리 문맥을 별도 캐시 블록으로 분리하는 API 제어가 없어(Claude 는 cache_control 로
 *  system 배열의 별도 원소에 붙임, claude.ts 참고) 이 방식(system 뒤에 이어붙여 prefix
 *  재사용에 의존)을 쓴다. 두 어댑터가 이 병합 문자열을 각자 복제해 갖고 있던 것을
 *  통합했다(2026-07-30). */
export function mergeSystemWithContext(system: string, cacheableContext?: string): string {
  return cacheableContext ? `${system}\n\n[문맥]\n${cacheableContext}` : system
}

/** 일부 provider/모델 세대는 temperature 기본값(1) 외의 값을 400 으로 거부한다(거부
 *  조건은 provider/모델 등급마다 다르다 — gpt.ts/claude.ts 의 실측 확인 주석 참고). 첫
 *  요청이 400이고 그 provider의 거부 신호(isTemperatureRejection)와 일치할 때만
 *  temperature 없이 한 번 더 요청한다 — 매번 무조건 생략하지 않아야, temperature 를
 *  받아주는 모델로 바뀌었을 때 원래 의도(응답 안정성)가 그대로 산다. GPT/Claude 어댑터가
 *  이 재시도 구조를 각자 복제해 갖고 있던 것을 통합했다(2026-07-30). */
export async function withTemperatureFallback(
  request: (includeTemperature: boolean) => Promise<Response>,
  isTemperatureRejection: (detail: string) => boolean,
): Promise<Response> {
  let res = await request(true)
  if (!res.ok && res.status === 400) {
    const detail = await res.clone().text()
    if (isTemperatureRejection(detail)) {
      res = await request(false)
    }
  }
  return res
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
