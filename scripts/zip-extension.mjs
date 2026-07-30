// 크롬 확장(extension/dist, build:ext 산출물)을 GitHub Release 첨부용 zip으로 압축한다.
// Chrome 웹 스토어에 안 올리고 "압축해제된 확장 프로그램 로드"로 사이드로드하는 배포
// 방식이라(2026-07-31, 사용자 결정), zip 안에는 dist 내용물이 최상위에 바로 오게 한다 —
// 압축 해제 시 폴더 하나 더 감싸지 않아야 "그 폴더 선택"이 바로 된다.
import archiver from 'archiver'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distExtDir = resolve(root, 'extension/dist')
const outDir = resolve(root, 'dist') // electron-builder 산출물과 같은 폴더 — 릴리스 업로드 스크립트가 한 곳만 보면 됨
const { version } = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(resolve(root, 'extension/manifest.json'), 'utf-8')))
const outFile = resolve(outDir, `nuance-extension-${version}.zip`)

if (!existsSync(distExtDir)) {
  console.error('[zip-extension] extension/dist 가 없습니다 — 먼저 npm run build:ext 를 실행하세요.')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const output = createWriteStream(outFile)
const archive = archiver('zip', { zlib: { level: 9 } })

archive.on('error', (err) => {
  throw err
})
output.on('close', () => {
  console.log(`[zip-extension] ${outFile} (${archive.pointer()} bytes)`)
})

archive.pipe(output)
archive.directory(distExtDir, false) // false = extension/dist 내용물을 zip 최상위에 바로 둠
await archive.finalize()
