import contextMenu from 'electron-context-menu'

// Electron 은 BrowserWindow 에 기본 우클릭 메뉴(잘라내기/복사/붙여넣기 등)를 자동으로
// 붙여주지 않는다 — 앱마다 직접 구현해야 한다. macOS 의 "찾아보기(Look Up)"·맞춤법 교정
// 제안·서비스 메뉴까지 포함한 OS 수준 기본 메뉴에 가깝게 electron-context-menu 로 구성하고,
// window 를 지정하지 않아 앱의 모든 창(메인/설정/팝업/오버레이)에 공통 적용한다.

export function registerContextMenu(): void {
  contextMenu({
    showLookUpSelection: true,
    showSearchWithGoogle: true,
    showServices: true,
    labels: {
      cut: '잘라내기',
      copy: '복사',
      paste: '붙여넣기',
      selectAll: '전체 선택',
      copyLink: '링크 복사',
      lookUpSelection: '“{selection}” 찾아보기',
      searchWithGoogle: 'Google에서 “{selection}” 검색',
      learnSpelling: '맞춤법에 추가',
    },
  })
}
