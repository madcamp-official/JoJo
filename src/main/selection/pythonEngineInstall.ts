import { app, Notification } from 'electron'
import https from 'node:https'
import extractZip from 'extract-zip'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

// 담당 A — Python OCR 엔진(PyInstaller freeze 산출물)을 패키지된 앱이 첫 사용 시점에
// R2에서 내려받아 캐싱한다. electron-builder 설치 파일 자체에는 넣지 않는다 —
// torch/paddle 등을 합쳐 번들 하나가 GB 단위라(scripts/build-python-engines.sh 주석
// 참고) 설치 파일에 그대로 박으면 GitHub Release 파일당 2GB 제한에 걸리고, 처음부터
// 다 받아야 해서 설치 자체가 무거워진다. 대신 사전/폰트처럼 "필요할 때" 받는 기존
// 패턴(python/README.md의 모델 가중치 지연 다운로드)을 엔진 전체로 확장한 것이다.
//
// 개발 모드(app.isPackaged === false)에서는 전혀 관여하지 않는다 — pythonServer.ts가
// 그대로 로컬 venv(python/.venv)를 직접 스폰한다.

export type EngineBundle = 'main' | 'ndlocr'

const PLATFORM_TAG = process.platform === 'win32' ? 'win' : 'mac'

function bundleFileName(bundle: EngineBundle): string {
  return `nuance-py-${bundle}-${PLATFORM_TAG}.zip`
}

// zip 안에는 onedir 폴더 자체(nuance-py-main/, nuance-py-ndlocr/)가 최상위로 들어있다
// (scripts/zip-python-engine.mjs 참고) — 압축 해제 디렉터리 밑에 그대로 남는다.
function extractedRoot(bundle: EngineBundle): string {
  return join(app.getPath('userData'), 'python-engines', `nuance-py-${bundle}`)
}

function versionMarkerPath(bundle: EngineBundle): string {
  return join(app.getPath('userData'), 'python-engines', `.${bundle}-version`)
}

function isInstalledForCurrentVersion(bundle: EngineBundle): boolean {
  try {
    return readFileSync(versionMarkerPath(bundle), 'utf-8').trim() === app.getVersion()
  } catch {
    return false
  }
}

const MAX_REDIRECTS = 5

// R2 공개 URL(커스텀 도메인 등)이 302로 리다이렉트할 수 있어 Node 내장 https(자동
// 리다이렉트 없음)로 직접 몇 단계까지 따라간다 — 이것만을 위해 별도 패키지를 추가하지
// 않는다.
function downloadFile(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function get(currentUrl: string, redirectsLeft: number): void {
      https
        .get(currentUrl, (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            if (redirectsLeft <= 0) {
              reject(new Error(`엔진 다운로드 실패: 리다이렉트가 너무 많음 (${url})`))
              return
            }
            get(res.headers.location, redirectsLeft - 1)
            return
          }
          if (status !== 200) {
            reject(new Error(`엔진 다운로드 실패: HTTP ${status} (${currentUrl})`))
            res.resume()
            return
          }
          const total = Number(res.headers['content-length'] ?? 0)
          let received = 0
          let lastLoggedPct = -1
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (total > 0) {
              const pct = Math.floor((received / total) * 100)
              if (pct !== lastLoggedPct && pct % 10 === 0) {
                lastLoggedPct = pct
                onProgress?.(pct)
              }
            }
          })
          pipeline(res, createWriteStream(destPath)).then(resolve, reject)
        })
        .on('error', reject)
    }
    get(url, MAX_REDIRECTS)
  })
}

// 같은 bundle을 동시에 요청하는 여러 워커(layout_detect/ocr_paddle/ocr_yomitoku/
// sudachi_tokenize가 전부 'main'을 씀)가 각자 따로 GB 단위 zip을 받지 않도록, bundle별
// 진행 중인 설치 Promise를 공유한다.
const inFlight = new Map<EngineBundle, Promise<string>>()

/** 지정한 bundle이 준비돼 있는지 확인하고, 없거나 버전이 안 맞으면 R2에서 받아 설치한
 *  뒤 압축 해제된 루트 경로(onedir 폴더)를 반환한다. */
export function ensurePythonEngine(bundle: EngineBundle): Promise<string> {
  if (isInstalledForCurrentVersion(bundle)) return Promise.resolve(extractedRoot(bundle))

  const existing = inFlight.get(bundle)
  if (existing) return existing

  const task = installEngine(bundle).finally(() => inFlight.delete(bundle))
  inFlight.set(bundle, task)
  return task
}

async function installEngine(bundle: EngineBundle): Promise<string> {
  const baseUrl = import.meta.env.MAIN_VITE_PY_ENGINE_BASE_URL
  if (!baseUrl) {
    throw new Error(
      'MAIN_VITE_PY_ENGINE_BASE_URL 미설정 — Python OCR 엔진을 받을 수 없다(빌드 시 .env에 설정 필요)',
    )
  }

  const root = extractedRoot(bundle)
  const engineRootDir = join(app.getPath('userData'), 'python-engines')
  mkdirSync(engineRootDir, { recursive: true })

  // 이전 버전 잔재를 지우고 새로 받는다(버전마다 site-packages 내용이 달라질 수 있어
  // 뒤섞이면 위험 — 통째로 지우고 다시 받는 쪽이 안전하다).
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })

  const fileName = bundleFileName(bundle)
  const url = `${baseUrl.replace(/\/$/, '')}/${app.getVersion()}/${fileName}`
  const zipPath = join(app.getPath('temp'), fileName)

  console.log(`[pythonEngineInstall] ${bundle} 엔진 다운로드 시작: ${url}`)
  const notice = new Notification({
    title: 'Nuance',
    body: `OCR 엔진을 처음 준비하고 있습니다(최대 수 분 소요, 1회만)…`,
  })
  notice.show()

  try {
    await downloadFile(url, zipPath, (pct) => console.log(`[pythonEngineInstall] ${bundle} ${pct}%`))
    await extractZip(zipPath, { dir: engineRootDir })
    writeFileSync(versionMarkerPath(bundle), app.getVersion())
    console.log(`[pythonEngineInstall] ${bundle} 엔진 설치 완료: ${root}`)
    return root
  } catch (err) {
    // 실패해도 앱을 죽이지 않는다 — 호출부(pythonServer.ts)가 이 reject를 기존 ENOENT
    // 폴백과 동일하게 처리해 해당 OCR 기능만 조용히 빠지게 한다(python/README.md의
    // "이 설정 없이 앱을 실행하면" 원칙 그대로).
    if (existsSync(root)) rmSync(root, { recursive: true, force: true }) // 부분 압축해제 잔재 제거
    throw err
  } finally {
    rmSync(zipPath, { force: true })
  }
}

/** 설치된(또는 설치될) bundle 안에서 실행 파일의 절대 경로를 계산한다. 실제로 존재하는지는
 *  ensurePythonEngine이 끝난 뒤 호출부가 필요시 확인한다. */
export function frozenExecutablePath(bundle: EngineBundle, exeName: string): string {
  const name = process.platform === 'win32' ? `${exeName}.exe` : exeName
  return join(extractedRoot(bundle), name)
}
