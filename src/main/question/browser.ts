import { execFile } from 'child_process'
import { shell } from 'electron'

// 담당 B — 외부 검색/사전 결과를 기본 브라우저의 새 창으로 여는 공통 로직
// (google.ts 발음/이미지 검색, naver.ts 사전 검색이 공유)

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd, args, (e) => (e ? reject(e) : resolve())))
}

// Chromium 계열 번들 id — 모두 `--new-window <url>` 로 새 창을 연다.
const CHROMIUM_BUNDLES = new Set([
  'com.google.chrome',
  'com.google.chrome.canary',
  'com.microsoft.edgemac',
  'com.brave.browser',
  'com.vivaldi.vivaldi',
  'org.chromium.chromium',
  'company.thebrowser.browser', // Arc
  'ru.yandex.desktop.yandex-browser',
  'com.operasoftware.opera',
])

/** macOS 기본 브라우저의 번들 id(소문자) 조회 — NSWorkspace 표준 API(JXA). 실패 시 null.
 *  LaunchServices plist 직접 파싱은 Safari 기본일 때 항목이 없거나 TCC 로 막혀 불안정 → API 사용. */
function macDefaultBrowserBundleId(): Promise<string | null> {
  const jxa =
    'ObjC.import("AppKit");' +
    'var u=$.NSURL.URLWithString("https://www.google.com");' +
    'var a=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(u);' +
    'a ? ($.NSBundle.bundleWithURL(a).bundleIdentifier.js || "") : ""'
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', jxa], (err, stdout) => {
      if (err) return resolve(null)
      const id = stdout.trim().toLowerCase()
      resolve(id || null)
    })
  })
}

export interface WinBounds {
  x: number
  y: number
  width: number
  height: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Windows 기본 브라우저 실행 파일 경로 조회 — 레지스트리(UserChoice ProgId → open command). 실패 시 null. */
function winDefaultBrowserExe(): Promise<string | null> {
  const q = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('reg', args, (e, out) => (e ? reject(e) : resolve(out))),
    )
  return (async () => {
    try {
      const progOut = await q([
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
        '/v',
        'ProgId',
      ])
      const progId = /ProgId\s+REG_SZ\s+(\S+)/i.exec(progOut)?.[1]
      if (!progId) return null
      const cmdOut = await q(['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'])
      const cmd = /REG_SZ\s+(.+)/i.exec(cmdOut)?.[1]?.trim()
      if (!cmd) return null
      // 값 예: "C:\...\chrome.exe" "%1" → 첫 따옴표 경로(또는 첫 토큰) 추출
      const m = /^"([^"]+)"|^(\S+)/.exec(cmd)
      return m ? (m[1] ?? m[2] ?? null) : null
    } catch {
      return null
    }
  })()
}

/** Windows: 기본 브라우저를 새 창으로(가능하면 위치/크기 지정) 연다. 실패 시 shell.openExternal 폴백. */
async function openWinNewWindow(url: string, b: Box | null): Promise<void> {
  const exe = await winDefaultBrowserExe()
  try {
    if (exe) {
      const lower = exe.toLowerCase()
      if (/(chrome|msedge|edge|brave|vivaldi|opera|chromium)\.exe/.test(lower)) {
        const args = ['--new-window']
        if (b) args.push(`--window-position=${b.x},${b.y}`, `--window-size=${b.w},${b.h}`)
        args.push(url)
        return await run(exe, args)
      }
      if (/firefox\.exe/.test(lower)) {
        return await run(exe, ['-new-window', url])
      }
      return await run(exe, [url]) // 기타 브라우저 — 새 창 보장 안 됨
    }
  } catch {
    /* 폴백 */
  }
  return shell.openExternal(url)
}

/**
 * 주어진 URL 을 기본 브라우저의 **새 창**으로 연다(기존 창의 새 탭이 아니라).
 * bounds 가 주어지면 그 위치·크기로 창을 띄우고 맨 앞으로 올린다(팝업과 겹쳐 보이게).
 * macOS: 기본 브라우저를 감지해 브라우저별로 새 창을 강제한다.
 *  - Chromium 계열: `--new-window --window-position=X,Y --window-size=W,H <url>`
 *    (`open -n` 은 Chrome 이 단일 인스턴스라 무시돼 새 탭으로 열리므로 `--new-window` 를 쓴다)
 *  - Firefox: `--new-window`(정확한 크기 지정은 생략)
 *  - Safari: AppleScript `make new document` + `set bounds` + `activate`
 *  - 감지 실패/그 외: shell.openExternal(새 탭일 수 있음)로 폴백
 * Windows/Linux: 브라우저별 새 창 강제 방법이 제각각이라 우선 shell.openExternal 폴백.
 */
export async function openUrlInNewWindow(url: string, bounds?: WinBounds): Promise<void> {
  const b: Box | null = bounds
    ? {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        w: Math.round(bounds.width),
        h: Math.round(bounds.height),
      }
    : null

  if (process.platform === 'win32') return openWinNewWindow(url, b)
  if (process.platform !== 'darwin') return shell.openExternal(url)

  const bundle = await macDefaultBrowserBundleId()
  try {
    if (bundle && CHROMIUM_BUNDLES.has(bundle)) {
      const args = ['-b', bundle, '--args', '--new-window']
      if (b) args.push(`--window-position=${b.x},${b.y}`, `--window-size=${b.w},${b.h}`)
      args.push(url)
      return await run('open', args)
    }
    if (bundle === 'org.mozilla.firefox') {
      return await run('open', ['-b', bundle, '--args', '--new-window', url])
    }
    if (bundle === 'com.apple.safari' || !bundle) {
      // Safari 는 --new-window 미지원 → AppleScript 로 새 창(new document) + 크기/위치.
      // ⚠️ AppleScript `activate` 는 앱 전체를 활성화해 '다른 Safari 창까지' 앞으로 딸려온다.
      // 그래서 여기선 창만 만들고, 활성화는 아래 NSRunningApplication.activate(옵션 0)로 —
      // '모든 창 올리기' 없이 프론트(새) 창만 앞으로 오게 한다.
      const setBounds = b
        ? `\n  set bounds of front window to {${b.x}, ${b.y}, ${b.x + b.w}, ${b.y + b.h}}`
        : ''
      const script =
        `tell application id "com.apple.Safari"\n` +
        `  make new document with properties {URL:"${url}"}${setBounds}\n` +
        `end tell`
      await run('osascript', ['-e', script])
      const raiseFront =
        'ObjC.import("AppKit");' +
        'var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Safari");' +
        'if(a.count>0){a.objectAtIndex(0).activateWithOptions(0)}'
      await run('osascript', ['-l', 'JavaScript', '-e', raiseFront]).catch(() => {})
      return
    }
    // 알 수 없는 브라우저 — 번들로 열되 새 창/크기 보장은 안 됨
    return await run('open', ['-b', bundle, url])
  } catch {
    return shell.openExternal(url)
  }
}
