/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_OPENAI_API_KEY?: string
  readonly MAIN_VITE_GEMINI_API_KEY?: string
  readonly MAIN_VITE_CLAUDE_API_KEY?: string
  readonly MAIN_VITE_ACTIVE_PROVIDER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
