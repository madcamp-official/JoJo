import type { ExtractedSelection, Language, Word } from '@shared/types'
import type { SubtitleSnapshot } from '@shared/extension'
import { findWordAtPoint } from '@shared/wordMapping'
import { extensionBridge } from '../extension/bridge'
import { getBrowserSource } from '../extension/activeTab'
import { sendOverlayWords } from '../windows'

// 담당 B — 유튜브/넷플릭스 자막 추출 경로 (OCR 대체).
// 확장이 보내는 화면 자막 스냅샷(뷰포트 좌표)을 오버레이 로컬 좌표의 Word[] 로 바꿔
// hover/클릭 판정에 쓰고, 클릭 시 앞뒤 범위 자막을 문맥으로 하는 ExtractedSelection 을 만든다.
//
// 좌표 보정: 오버레이는 이미 브라우저 창에 정렬돼 있으므로(windows.ts 추적), 뷰포트 좌표에
// 크롬 오프셋(창 좌상단→뷰포트 좌상단)만 더하면 오버레이 로컬 좌표가 된다. CSS px 는
// Electron DIP 와 같은 단위라 배율 보정은 필요 없다. 전체화면/극장모드에선 오프셋이 0 이다.

let active = false
let latest: SubtitleSnapshot | null = null
let latestWords: Word[] = []
let unsubscribe: (() => void) | null = null

export function isSubtitleModeActive(): boolean {
  return active
}

export function startSubtitleMode(): void {
  if (active) return
  active = true
  extensionBridge.setSubtitleCapture(true)
  const handler = (snapshot: SubtitleSnapshot | null): void => onSnapshot(snapshot)
  extensionBridge.on('subtitles', handler)
  unsubscribe = () => extensionBridge.off('subtitles', handler)
  // 이미 받아둔 프레임이 있으면 즉시 반영.
  onSnapshot(extensionBridge.getSubtitles())
}

export function stopSubtitleMode(): void {
  if (!active) return
  active = false
  unsubscribe?.()
  unsubscribe = null
  extensionBridge.setSubtitleCapture(false)
  latest = null
  latestWords = []
  sendOverlayWords([])
}

function onSnapshot(snapshot: SubtitleSnapshot | null): void {
  latest = snapshot
  latestWords = snapshot ? snapshotToWords(snapshot) : []
  sendOverlayWords(latestWords)
}

function snapshotToWords(snapshot: SubtitleSnapshot): Word[] {
  const { chromeLeft, chromeTop } = snapshot.viewport
  const words: Word[] = []
  for (const line of snapshot.lines) {
    for (const w of line.words) {
      words.push({
        text: w.text,
        bbox: {
          x: w.rect.x + chromeLeft,
          y: w.rect.y + chromeTop,
          width: w.rect.width,
          height: w.rect.height,
        },
      })
    }
  }
  return words
}

// 화면 자막 텍스트로 언어를 추정한다(자막엔 OCR OSD 를 못 쓰므로 유니코드 블록 휴리스틱).
function detectSubtitleLanguage(text: string): Language {
  if (/[぀-ヿ]/.test(text)) return 'ja' // 가나
  if (/[一-鿿]/.test(text)) {
    // 간체 전용 글자가 보이면 zh-Hans, 아니면 기본 zh-Hant(번체) — 정밀 판별은 추후.
    return /[们么这来国对时会说无个开关问题东买卖车马语门]/.test(text) ? 'zh-Hans' : 'zh-Hant'
  }
  return 'en'
}

// 클릭 지점의 자막 단어를 기준으로 ExtractedSelection 을 만든다(팝업 트리거용).
// 실제 앞뒤 문맥 텍스트 구성은 task 7 에서 timedtext context 로 채운다 — 여기선 좌표
// 기반 클릭 대상 판정과 현재 프레임 텍스트까지 담는다.
export function buildSubtitleSelection(point: { x: number; y: number }): ExtractedSelection | null {
  if (!latest) return null
  const word = findWordAtPoint(latestWords, point)
  if (!word) return null

  // 현재 화면 자막 텍스트(여러 줄이면 공백으로 이음).
  const lineText = latest.lines.map((l) => l.text).join(' ')
  const language = detectSubtitleLanguage(lineText)
  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }

  // 클릭한 단어의 lineText 내 위치(단순 첫 매칭 — task 7 에서 문맥과 함께 정교화).
  const start = Math.max(0, lineText.indexOf(word.text))
  const end = word.text ? start + word.text.length : 0

  return {
    text: lineText,
    anchor: { start, end },
    words: latestWords,
    language,
    source, // kind: youtube/netflix 가 자막 경로임을 나타냄
    extraction: 'direct', // 자막도 DOM/timedtext 직접 추출
  }
}

export function getLatestSubtitleSnapshot(): SubtitleSnapshot | null {
  return latest
}
