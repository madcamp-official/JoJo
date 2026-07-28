// postinstall 훅 — macOS에서 npm install 이 받아온 Electron 바이너리를 ad-hoc 재서명한다.
//
// 배경(2026-07-28 실측): Apple이 Electron 31.7.7 공식 배포 바이너리의 서명을 폐기
// (notarization revoke)해서, npm install 직후 실행하면 macOS가 "Electron.app will
// damage your computer" 악성 다이얼로그와 함께 SIGKILL 로 차단한다(spctl 진단:
// "notarization indicates this code has been revoked"). 로컬에서 ad-hoc 서명을 다시
// 하면 CDHash 가 새로 계산돼 폐기 목록과 더 이상 일치하지 않아 차단이 풀린다.
// npm install/ci 가 electron 을 다시 풀 때마다 폐기된 원본 서명으로 되돌아가므로
// postinstall 에서 매번 재서명한다(새로 풀린 파일은 vnode 도 새것이라 재서명만으로
// 충분 — 같은 파일을 제자리 재서명했다가 경로 캐시에 걸렸던 문제는 install 직후엔 없음).
//
// macOS 외 플랫폼(윈도우 팀원 등)에선 codesign 자체가 없으므로 조용히 건너뛴다.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (process.platform === 'darwin') {
  const app = 'node_modules/electron/dist/Electron.app'
  if (existsSync(app)) {
    try {
      execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'ignore' })
      console.log('[resign-electron] Electron.app ad-hoc 재서명 완료 (Apple 폐기 서명 우회)')
    } catch {
      // 재서명 실패해도 install 자체는 막지 않는다 — 실행 시점에 차단되면 그때 진단.
      console.warn('[resign-electron] codesign 실패 — Electron 실행이 차단되면 수동 재서명 필요')
    }
  }
}
