import { app, Notification, shell } from 'electron'

// 담당 A — 자동 업데이트(2026-07-31, 사용자 요청). GitHub Releases 로 배포하고
// (electron-builder.yml: publish), 두 플랫폼을 다르게 처리한다:
//  - Windows: `electron-updater` 로 실제 자동 다운로드+설치까지 — NSIS 설치본은 체크섬
//    기반이라 코드서명 없이도 정상 동작한다(신뢰할 수 있는 개발자 서명이 아니라는 SmartScreen
//    경고는 최초 설치 시에만 뜸, 업데이트 자체와는 무관).
//  - macOS: `electron-updater`(Squirrel.Mac)의 자동 설치는 앱이 서명돼 있어야 안정적으로
//    동작하는데, 지금은 미서명 사설 배포(electron-builder.yml: mac.identity: null)라 이
//    경로를 안 쓴다 — 대신 GitHub Releases API로 최신 태그만 조회해 새 버전이 있으면 알림만
//    띄우고, 클릭하면 릴리스 페이지로 안내한다("자동 다운로드/설치"가 아니라 "알림"만
//    지원하는 게 사용자가 이미 이해하고 있던 macOS 쪽 한계와 일치).
const GITHUB_OWNER = 'madcamp-official'
const GITHUB_REPO = 'JoJo'

/** 앱 시작 시 1회 호출 — 개발 모드(`npm run dev`)에서는 아무 것도 하지 않는다(패키징된
 *  빌드에만 있는 업데이트 피드 메타데이터가 필요해서 electron-updater 가 그 상태에선
 *  에러를 내고, macOS 쪽도 배포판이 아닌데 알림을 띄울 이유가 없다). */
export function startAutoUpdateCheck(): void {
  if (!app.isPackaged) return
  if (process.platform === 'win32') {
    void checkWindowsUpdate()
  } else if (process.platform === 'darwin') {
    void checkMacUpdateAndNotify()
  }
}

async function checkWindowsUpdate(): Promise<void> {
  try {
    // electron-updater 는 무거운 만큼(코드서명 검증 로직 등) 필요한 플랫폼에서만 로드한다.
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (err) => console.error('[autoUpdate] 업데이트 확인 실패:', err))
    // 다운로드까지 자동으로 끝내고, 설치 준비가 되면 OS 알림을 띄운 뒤 앱 종료 시 설치한다
    // (electron-updater 기본 동작 — checkForUpdatesAndNotify 가 알림까지 포함).
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (err) {
    console.error('[autoUpdate] Windows 업데이트 확인 실패:', err)
  }
}

interface GithubRelease {
  tag_name: string
  html_url: string
}

async function checkMacUpdateAndNotify(): Promise<void> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    )
    if (!res.ok) return // 릴리스가 아직 없거나(첫 배포 전) API 제한 등 — 조용히 무시
    const release = (await res.json()) as GithubRelease
    const latestVersion = release.tag_name.replace(/^v/, '')
    if (!isNewerVersion(latestVersion, app.getVersion())) return

    const notification = new Notification({
      title: 'Nuance 업데이트',
      body: `새 버전 ${latestVersion}이 나왔습니다. 클릭하면 다운로드 페이지로 이동합니다.`,
    })
    notification.on('click', () => {
      void shell.openExternal(release.html_url)
    })
    notification.show()
  } catch (err) {
    console.error('[autoUpdate] macOS 업데이트 확인 실패:', err)
  }
}

/** "1.2.10" > "1.2.9" 같은 걸 문자열 비교(">")로 하면 틀리므로 점 단위로 숫자 비교한다. */
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}
