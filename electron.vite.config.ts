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
    build: {
      rollupOptions: {
        // tesseract.js 는 워커 스크립트 경로를 자기 자신의 __dirname 기준 상대경로로
        // 계산한다(worker/node/defaultOptions.js). 번들에 인라인되면 __dirname 이
        // out/main 이 되어 그 경로 계산이 깨진다(node_modules/tesseract.js 를 못 찾음)
        // — external 로 빼서 런타임에 node_modules 에서 그대로 require 되게 한다.
        external: ['tesseract.js'],
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
