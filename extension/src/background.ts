// 담당 A — 확장 백그라운드 (service worker)
// content script 와 데스크톱 앱(native messaging) 사이의 브릿지.
// TODO(담당 A): native messaging 포트 연결, 탭 URL 변화 → 앱에 재판정 통지.

const NATIVE_HOST = 'com.madcamp.nuance'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const port = chrome.runtime.connectNative(NATIVE_HOST)
  port.postMessage(msg)
  port.onMessage.addListener((res) => sendResponse(res))
  return true
})

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.url) {
    // TODO: 앱에 URL 변화 통지 → decideOcr 재판정 유도
    void tab
  }
})
