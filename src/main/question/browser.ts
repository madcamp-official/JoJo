import { execFile, spawn } from 'child_process'
import { shell } from 'electron'

// 담당 B — 외부 검색/사전 결과를 기본 브라우저의 새 창으로 여는 공통 로직
// (google.ts 발음/이미지 검색, naver.ts 사전 검색이 공유)

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd, args, (e) => (e ? reject(e) : resolve())))
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, (e, stdout) => (e ? reject(e) : resolve(stdout.trim()))),
  )
}

/** 지금 맨 앞에 있는(사용자가 보고 있던) 앱의 번들 id — Safari 를 활성화하기 직전에
 *  불러 기억해둔다(아래 watchSafariWindowAndRestoreFocus 참고). macDefaultBrowserBundleId
 *  와 같은 NSWorkspace API 패턴, 대상만 "기본 브라우저"가 아니라 "현재 활성 앱"으로 다름. */
function frontmostAppBundleId(): Promise<string | null> {
  const jxa =
    'ObjC.import("AppKit");' +
    'var a=$.NSWorkspace.sharedWorkspace.frontmostApplication;' +
    'a ? (a.bundleIdentifier.js || "") : ""'
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', jxa], (err, stdout) => {
      if (err) return resolve(null)
      const id = stdout.trim()
      resolve(id || null)
    })
  })
}

/**
 * Safari 는 단일 프로세스라 창을 여러 개 열어도 전부 같은 앱 인스턴스에 속한다 — 그래서
 * "새 창(예: 사전 조회 결과)만 열고 싶다"는 의도와 달리, 그 창을 활성화하면 Safari
 * 앱 전체가 활성 앱이 되고, 나중에 사용자가 **그 창을 닫으면** macOS가 같은 앱의 다음
 * 창(사용자가 원래 띄워놨던 다른 Safari 창들)을 자동으로 앞에 올려버린다(사용자 보고,
 * 2026-07-28) — Safari 창끼리는 OS 차원에서 서로 "독립"될 수 없는 구조적 한계.
 *
 * 우회책: 그 창을 실제로 만들기 직전의 "원래 활성 앱"을 기억해뒀다가, 백그라운드에서
 * (메인 흐름을 안 막고) 그 창이 사라질 때까지 주기적으로 확인 → 사라지면 원래 앱을
 * 다시 활성화한다. 사용자가 그 창을 닫는 순간 Safari의 다른 창이 아니라 원래 있던
 * 앱으로 돌아가게 되어, 다른 Safari 창들이 "끌려 나오는" 것처럼 보이지 않는다.
 * 이 프로세스는 완전히 분리(detached)돼 있어 앱 종료와도 무관하게 혼자 끝까지 돈다.
 */
function watchSafariWindowAndRestoreFocus(windowId: string, originalBundleId: string | null): void {
  if (!originalBundleId || originalBundleId === 'com.apple.safari') return
  const jxa =
    'ObjC.import("AppKit");' +
    `var id=${windowId};` +
    'var safari=Application("Safari");' +
    'safari.includeStandardAdditions=true;' +
    // 창이 사라질 때까지 1초 간격으로 확인(최대 30분 — 무한 대기 방지).
    'for(var i=0;i<1800;i++){' +
    '  try{if(!safari.windows().some(function(w){return w.id()===id})) break}catch(e){break}' +
    '  delay(1)' +
    '}' +
    `var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("${originalBundleId}");` +
    'if(a.count>0){a.objectAtIndex(0).activateWithOptions(0)}'
  const child = spawn('osascript', ['-l', 'JavaScript', '-e', jxa], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
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
      // Safari 창을 활성화하기 전에 "원래 활성 앱"을 먼저 기억해둔다 — 이 창을 닫을 때
      // 되돌려주기 위함(watchSafariWindowAndRestoreFocus 주석 참고).
      const originalBundleId = await frontmostAppBundleId()
      const setBounds = b
        ? `\n  set bounds of front window to {${b.x}, ${b.y}, ${b.x + b.w}, ${b.y + b.h}}`
        : ''
      const script =
        `tell application id "com.apple.Safari"\n` +
        `  make new document with properties {URL:"${url}"}${setBounds}\n` +
        `  return id of front window\n` +
        `end tell`
      const windowId = await runCapture('osascript', ['-e', script]).catch(() => null)
      const raiseFront =
        'ObjC.import("AppKit");' +
        'var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Safari");' +
        'if(a.count>0){a.objectAtIndex(0).activateWithOptions(0)}'
      await run('osascript', ['-l', 'JavaScript', '-e', raiseFront]).catch(() => {})
      // Safari 창끼리는 서로 "독립"될 수 없는 구조적 한계(위 함수 주석 참고) — 이 창이
      // 닫히면 다른 Safari 창이 아니라 원래 앱으로 돌아가도록 백그라운드에서 지켜본다.
      // 메인 흐름을 막지 않음(await 없음) — 실패해도(원래 앱 조회 실패 등) 새 창을 여는
      // 핵심 기능 자체엔 영향 없다.
      if (windowId) watchSafariWindowAndRestoreFocus(windowId, originalBundleId)
      return
    }
    // 알 수 없는 브라우저 — 번들로 열되 새 창/크기 보장은 안 됨
    return await run('open', ['-b', bundle, url])
  } catch {
    return shell.openExternal(url)
  }
}
