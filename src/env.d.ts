/// <reference types="electron-vite/node" />

// 텍스트를 문자열 그대로 번들에 인라인한다 (프롬프트 템플릿 등). Vite 코어 기능이라 확장자 무관하게 동작.
declare module '*?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly MAIN_VITE_GPT_API_KEY?: string
  readonly MAIN_VITE_GEMINI_API_KEY?: string
  readonly MAIN_VITE_CLAUDE_API_KEY?: string
  readonly MAIN_VITE_ACTIVE_PROVIDER?: string
  readonly MAIN_VITE_MW_COLLEGIATE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
