// 담당 B — 프롬프트 템플릿 치환 유틸 (PLAN.md §5.2)
// `{{key}}` 형태의 플레이스홀더를 vars 값으로 치환한다. 매칭되는 값이 없으면 빈 문자열로 치환.
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '').trim()
}
