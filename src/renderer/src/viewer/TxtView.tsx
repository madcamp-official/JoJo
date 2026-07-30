import type { ViewerFilePayload } from '@shared/types'

// txt — 빈 줄로 문단을 나눠 <p> 로 그린다. 호버 스택의 기본 문단 선택자가 <p> 라
// (webArticle.ts) 별도 설정 없이 웹페이지와 똑같이 동작한다.
export function TxtView({ file, fontSize }: { file: ViewerFilePayload; fontSize: number }) {
  const paragraphs = (file.text ?? '').split(/\n{2,}/).filter((p) => p.trim())
  return (
    <article className="viewer-doc" style={{ fontSize }}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </article>
  )
}
