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
        // lindera-wasm-nodejs-ipadic 도 같은 이유(.wasm 바이너리를 자기 패키지 폴더 기준
        // 상대경로로 로드, nlp/engines/lindera.ts)로 external 처리한다(예전엔 kuromoji 도
        // 있었으나 Lindera로 완전 대체되며 제거됨).
        // @node-rs/jieba 는 NAPI-RS 가 자동생성한 로더 코드가 Rollup 정적 분석과 안 맞아서
        // (commonjsRequire 재할당, 빌드 에러) external 필수 — chinese-tokenizer 도 예방적으로 같이 뺀다.
        external: [
          'tesseract.js',
          'segmentit',
          'lindera-wasm-nodejs-ipadic',
          '@node-rs/jieba',
          '@node-rs/jieba/dict.js', // dict.js 는 서브패스 import 라 위 '@node-rs/jieba' 항목과 별개로 매칭해야 함
          'chinese-tokenizer',
        ],
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
