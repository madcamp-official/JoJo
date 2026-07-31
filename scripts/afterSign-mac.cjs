// electron-builder afterSign 훅 — 패키징된 최종 Nuance.app을 ad-hoc 재서명한다.
//
// 배경: resign-electron.mjs(postinstall)가 이미 node_modules/electron/dist/Electron.app을
// ad-hoc 재서명해두지만, electron-builder가 이 템플릿을 리브랜딩(실행파일 이름 변경,
// Info.plist 교체, app.asar/리소스 추가 등)하는 과정에서 그 서명은 무효화된다. 여기에
// mac.identity: null(정식 인증서 없음, 사설 배포)이라 electron-builder 자체는 최종 .app을
// 아예 서명하지 않고 넘어간다 — 그 결과로 나온 배포판을 실제로 설치해보면 "Electron.app
// will damage your computer"와 똑같은 문구로 "Nuance.app will damage your computer"가
// 뜨며 휴지통행 버튼만 있고 우회 경로(우클릭 열기)가 없는 상태였다(2026-07-31 실사용
// 확인). 원인은 Apple이 이 Electron 버전의 원본 서명을 폐기(notarization revoke)했고,
// 서명이 아예 없는 게 아니라 "무효한 서명이 남아있는" 상태로 배포되면 Gatekeeper가 더
// 심한 경고(우회 옵션 없음)를 띄우기 때문 — resign-electron.mjs 상단 주석과 동일한
// 근본 원인이다. --deep으로 새로 ad-hoc 서명하면 CDHash가 새로 계산돼 폐기 목록과 더 이상
// 일치하지 않고, 번들 내부(Python 런타임의 torch/paddle/cv2 등 네이티브 라이브러리 포함)
// 서명도 전부 일관되게 맞춰져 "확인되지 않은 개발자"(우클릭 열기로 우회 가능한) 수준으로
// 완화된다.
const { execFileSync } = require('node:child_process')

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  console.log(`[afterSign-mac] ad-hoc 재서명: ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
