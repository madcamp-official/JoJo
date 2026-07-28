// 크롬 확장(MV3) 번들러 — extension/src/*.ts → extension/dist/*.js + manifest 복사.
// content script 는 ES module 이 될 수 없고 background 도 단일 파일로 자립하므로 둘 다 IIFE 로 번들한다.
import { build, context } from 'esbuild'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(root, 'extension/src')
const outDir = resolve(root, 'extension/dist')
const watch = process.argv.includes('--watch')

const entries = ['background', 'content']

const buildOptions = {
  entryPoints: entries.map((name) => resolve(srcDir, `${name}.ts`)),
  outdir: outDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  sourcemap: watch,
  logLevel: 'info',
}

function copyManifest() {
  copyFileSync(resolve(root, 'extension/manifest.json'), resolve(outDir, 'manifest.json'))
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

if (watch) {
  const ctx = await context({
    ...buildOptions,
    plugins: [
      {
        name: 'copy-manifest',
        setup(b) {
          b.onEnd(() => copyManifest())
        },
      },
    ],
  })
  await ctx.watch()
  console.log('[build-extension] watching extension/src → extension/dist')
} else {
  await build(buildOptions)
  copyManifest()
  console.log('[build-extension] built extension/dist')
}
