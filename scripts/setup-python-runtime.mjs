// 담당 A — CI에서 python/.venv 를 그대로 패키징하면 안 되는 문제(2026-07-31, 사용자 확인
// 후 결정) 때문에 만든 스크립트. venv 는 자기 완결적이지 않다 — Windows venv 의
// Scripts\python.exe 는 pyvenv.cfg 의 home 값으로 "만들 때 쓴 원본 Python 설치 경로"를
// 계속 참조하는데, 그 경로는 CI 러너(GitHub Actions 호스트)에만 있고 최종 사용자
// 컴퓨터에는 없다 — venv 를 그대로 복사해서 배포하면 조용히 실행이 안 된다.
//
// 대신 python-build-standalone(https://github.com/astral-sh/python-build-standalone)의
// "install_only" 배포판을 쓴다 — DLL/표준 라이브러리까지 폴더 하나에 전부 들어있는
// 완전 독립 배포판으로, 원래 경로 의존성이 없어 다른 컴퓨터로 그대로 복사해도 동작한다
// (uv/rye/pdm 등이 격리 인터프리터를 만들 때 쓰는 것과 같은 방식). 이 배포판의 python 을
// 그대로 인터프리터로 써서 `pip install`을 하면(venv 를 따로 안 만들고 배포판 자체에
// 바로 설치) site-packages 까지 포함해 폴더 전체가 재배치 가능해진다.
//
// 사용법: node scripts/setup-python-runtime.mjs <general|ndlocr>
//  - general → requirements.txt 를 python/runtime/ 에 설치 (DocLayout-YOLO/PaddleOCR/Yomitoku/Sudachi)
//  - ndlocr  → requirements-ndlocr.txt 를 python/runtime-ndlocr/ 에 설치 (NDLOCR-Lite,
//              공용 쪽과 numpy/opencv/onnxruntime 버전이 충돌해 격리 필요 — python/README.md 참고)
//
// electron-builder.yml 의 extraResources 가 이 두 폴더(+ *.py 스크립트)를 패키지에 그대로
// 넣는다. 런타임 경로 해석은 pythonServer.ts: PYTHON_ROOT 참고 — 패키징된 앱에서는 이
// 폴더를, 개발 환경에서는 기존 .venv/.venv-ndlocr-test(python/README.md 로 사람이 직접
// 만든 것)를 쓴다.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PYTHON_DIR = join(ROOT, 'python')

// python-build-standalone 릴리스 고정 — 배포판을 바꿀 땐 여기 태그/버전만 올리면 된다.
// (2026-07-31 시점 최신 태그로 확인: https://github.com/astral-sh/python-build-standalone/releases)
const RELEASE_TAG = '20260728'
const PY_VERSION = '3.12.13'

const TARGETS = {
  general: { requirements: 'requirements.txt', dir: 'runtime' },
  ndlocr: { requirements: 'requirements-ndlocr.txt', dir: 'runtime-ndlocr' },
}

function platformTriple() {
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc' // GitHub windows-latest = x64
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  throw new Error(`지원하지 않는 플랫폼: ${process.platform} (release.yml 은 windows-latest/macos-latest 만 빌드함)`)
}

function pythonBinIn(runtimeDir) {
  return process.platform === 'win32' ? join(runtimeDir, 'python.exe') : join(runtimeDir, 'bin', 'python3')
}

async function downloadFile(url, destPath) {
  console.log(`[python-runtime] 다운로드: ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFileSync } = await import('node:fs')
  writeFileSync(destPath, buf)
  console.log(`[python-runtime] 저장 완료: ${destPath} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`)
}

// __pycache__/*.pyc 는 site-packages 를 그대로 옮겨도 다시 생성 가능한 캐시라 지운다 —
// 재현 가능한 산출물 크기를 줄이는 가장 안전한 트리밍(실제 코드/데이터는 안 건드림).
function pruneCaches(dir) {
  let removed = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__pycache__') {
        rmSync(p, { recursive: true, force: true })
        removed++
        continue
      }
      removed += pruneCaches(p)
    } else if (name.endsWith('.pyc') || name.endsWith('.pyo')) {
      rmSync(p, { force: true })
      removed++
    }
  }
  return removed
}

async function main() {
  const targetName = process.argv[2]
  const target = TARGETS[targetName]
  if (!target) {
    console.error(`사용법: node scripts/setup-python-runtime.mjs <${Object.keys(TARGETS).join('|')}>`)
    process.exit(1)
  }

  const runtimeDir = join(PYTHON_DIR, target.dir)
  const requirementsPath = join(PYTHON_DIR, target.requirements)
  if (!existsSync(requirementsPath)) throw new Error(`requirements 파일 없음: ${requirementsPath}`)

  if (existsSync(runtimeDir)) {
    console.log(`[python-runtime] 기존 ${target.dir} 삭제 후 재생성`)
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  mkdirSync(runtimeDir, { recursive: true })

  const triple = platformTriple()
  const assetName = `cpython-${PY_VERSION}+${RELEASE_TAG}-${triple}-install_only.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${assetName}`

  const tmpFile = join(os.tmpdir(), assetName)
  await downloadFile(url, tmpFile)

  // 아카이브 최상위가 "python/" 폴더 하나라 --strip-components=1 로 그 껍데기를 벗기고
  // runtimeDir 바로 밑에 bin/lib(또는 Windows 는 python.exe 등)가 오게 한다.
  console.log(`[python-runtime] 압축 해제 → ${runtimeDir}`)
  execFileSync('tar', ['-xzf', tmpFile, '-C', runtimeDir, '--strip-components=1'], { stdio: 'inherit' })
  rmSync(tmpFile, { force: true })

  const pythonBin = pythonBinIn(runtimeDir)
  if (!existsSync(pythonBin)) throw new Error(`압축 해제했는데 인터프리터가 없음: ${pythonBin}`)

  console.log(`[python-runtime] pip install -r ${target.requirements}`)
  // 배포판 자체(venv 아님)에 바로 설치 — 이래야 폴더 전체가 재배치 가능한 채로 site-packages
  // 까지 포함하게 된다. --no-cache-dir 로 pip 다운로드 캐시가 이 폴더 밖(HOME)에 남게 해
  // 산출물 크기에 안 섞이게 한다.
  execFileSync(pythonBin, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', 'pip'], { stdio: 'inherit' })
  execFileSync(pythonBin, ['-m', 'pip', 'install', '--no-cache-dir', '-r', requirementsPath], {
    stdio: 'inherit',
    cwd: PYTHON_DIR, // requirements-ndlocr.txt 의 git+https 의존성 등이 상대경로를 안 쓰지만, 관례상 python/ 기준으로 맞춤
  })

  const removed = pruneCaches(runtimeDir)
  console.log(`[python-runtime] __pycache__/*.pyc ${removed}개 정리`)
  console.log(`[python-runtime] 완료: ${runtimeDir}`)
}

main().catch((err) => {
  console.error('[python-runtime] 실패:', err)
  process.exit(1)
})
