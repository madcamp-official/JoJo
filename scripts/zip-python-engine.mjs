// Python OCR 엔진(PyInstaller freeze 산출물)을 R2 업로드용 zip으로 압축한다.
// build-python-engines.sh 가 python/dist-py/nuance-py-main, python/dist-py-ndlocr/nuance-py-ndlocr
// 를 만들어두면, 이 스크립트가 플랫폼 접미사를 붙여 dist/ 에 zip 두 개를 만든다.
// (zip 안에는 각 onedir 폴더 자체가 최상위에 오게 한다 — 앱이 압축 해제 후 그 폴더
// 이름으로 실행 파일 경로를 찾으므로, extract-zip 결과 트리와 pythonEngineInstall.ts
// 의 경로 계산이 반드시 일치해야 한다.)
import archiver from 'archiver'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'dist') // electron-builder 산출물과 같은 폴더

const platTag = process.platform === 'win32' ? 'win' : 'mac'

const bundles = [
  { dir: resolve(root, 'python/dist-py/nuance-py-main'), name: `nuance-py-main-${platTag}.zip` },
  { dir: resolve(root, 'python/dist-py-ndlocr/nuance-py-ndlocr'), name: `nuance-py-ndlocr-${platTag}.zip` },
]

mkdirSync(outDir, { recursive: true })

for (const { dir, name } of bundles) {
  if (!existsSync(dir)) {
    console.error(`[zip-python-engine] ${dir} 가 없습니다 — 먼저 scripts/build-python-engines.sh 를 실행하세요.`)
    process.exit(1)
  }
  const outFile = resolve(outDir, name)
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outFile)
    const archive = archiver('zip', { zlib: { level: 6 } }) // 레벨 9는 GB급 바이너리에서 압축 시간 대비 이득이 작아 6으로 절충
    archive.on('error', reject)
    output.on('close', () => {
      console.log(`[zip-python-engine] ${outFile} (${(archive.pointer() / 1e6).toFixed(1)} MB)`)
      resolvePromise()
    })
    archive.pipe(output)
    // false = dir 내용물이 아니라 dir 자체(폴더명 포함)를 zip 최상위에 둠 — extract-zip
    // 결과가 <extractDir>/nuance-py-main/... 구조가 되도록.
    archive.directory(dir, dir.split('/').pop())
    archive.finalize()
  })
}
