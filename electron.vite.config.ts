import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite: main / preload / renderer 3개 빌드를 관리한다.
// 각 파이프라인(pipelineA/B)과 shared 는 main 번들에 포함된다.
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
  },
})
