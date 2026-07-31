// electron-builder afterAllArtifactBuild 훅 — mac 자동 업데이트 관련 산출물 중 지금 앱이
// 실제로 안 쓰는 것들을 게시(publish) 대상에서 제외한다.
//
// 배경(2026-07-31): src/main/autoUpdate.ts 는 macOS에서 electron-updater 자동 다운로드
// 자체를 안 쓴다 — 서명 없는 사설 배포라 Squirrel.Mac 갱신 경로를 아예 안 타고, GitHub API로
// 태그만 확인해 "새 버전 있어요" 알림만 띄운다(Windows만 latest.yml 로 실제 자동 업데이트를
// 씀). 그런데 electron-builder는 mac.target에 zip이 없어도(dmg만 있어도) 갱신 피드
// (latest-mac.yml)와 델타 업데이트용 블록맵(*.dmg.blockmap)을 자동으로 만들어 같이
// 올려버린다 — 지금 앱이 안 읽는 파일이라 릴리스 에셋만 지저분해진다.
//
// **나중에 정식 코드서명 배포로 전환해 macOS에서도 electron-updater 자동 다운로드를 쓰게
// 되면 이 훅(과 electron-builder.yml의 afterAllArtifactBuild 줄)을 지울 것** — 그러면
// electron-builder가 다시 정상적으로 latest-mac.yml/blockmap을 만들어 올린다.
const EXCLUDE_PATTERNS = [/^latest-mac\.yml$/, /\.dmg\.blockmap$/]

module.exports = async function afterAllArtifactBuild(buildResult) {
  return buildResult.artifactPaths.filter((p) => {
    const name = p.split(/[\\/]/).pop()
    const excluded = EXCLUDE_PATTERNS.some((re) => re.test(name))
    if (excluded) console.log(`[afterAllArtifactBuild] 게시 제외: ${name}`)
    return !excluded
  })
}
