import { execFile } from 'child_process'
import { shell } from 'electron'
import type { Language } from '@shared/types'
import { LANGUAGES } from '@shared/languages'

// 담당 B — 구글 검색 탭 URL 생성 (PLAN.md §4.2 구글 검색)
// 발음: "선택어 + Pronunciation/読み方/拼音" 웹 탭 / 시각 자료: 이미지 탭.
// 언어별 접미어는 @shared/languages 에서 관리(언어 확장 시 그쪽만 수정).

export function googlePronunciationUrl(text: string, lang: Language): string {
  const q = encodeURIComponent(`${text} ${LANGUAGES[lang].googleSearchSuffix}`)
  return `https://www.google.com/search?q=${q}`
}

export function googleImageUrl(text: string): string {
  const q = encodeURIComponent(text)
  return `https://www.google.com/search?tbm=isch&q=${q}`
}

/**
 * 구글 검색 결과를 기본 브라우저의 새 창으로 연다(이미 떠 있는 브라우저의 새 탭이 아니라).
 * macOS: `open -n`(이미 실행 중이어도 새 인스턴스로 열기)이 대부분의 브라우저에서 새 창으로
 * 열리는 결과를 낸다. 다른 OS는 동등한 방법이 마땅치 않아 shell.openExternal 로 폴백한다
 * (그 경우 기존 창에 새 탭으로 열릴 수 있음).
 */
export function openGoogleSearchInNewWindow(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('open', ['-n', url], (err) => (err ? reject(err) : resolve()))
    })
  }
  return shell.openExternal(url)
}
