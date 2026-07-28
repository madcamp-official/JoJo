import type { ExtractedSelection, Language, Word } from '@shared/types'
import type { SubtitleSnapshot } from '@shared/extension'
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
// 클릭한 줄을 "현재"로 두고 timedtext 앞뒤 범위 자막(context)을 위아래로 이어 붙여
// 팝업 문맥(text)을 만든다. anchor 는 현재 줄 안의 클릭 단어를 가리킨다.
export function buildSubtitleSelection(point: { x: number; y: number }): ExtractedSelection | null {
  if (!latest) return null

  // 클릭한 단어와 그 단어가 속한 줄·줄 내 오프셋을 찾는다.
  const { chromeLeft, chromeTop } = latest.viewport
  let clickedWord: Word | null = null
  let currentLine = ''
  let wordOffsetInLine = 0
  for (const line of latest.lines) {
    let offset = 0
    for (let i = 0; i < line.words.length; i++) {
      const w = line.words[i]!
      const bbox = {
        x: w.rect.x + chromeLeft,
        y: w.rect.y + chromeTop,
        width: w.rect.width,
        height: w.rect.height,
      }
      if (
        point.x >= bbox.x &&
        point.x < bbox.x + bbox.width &&
        point.y >= bbox.y &&
        point.y < bbox.y + bbox.height
      ) {
        clickedWord = { text: w.text, bbox }
        currentLine = line.text
        wordOffsetInLine = offset
        break
      }
      offset += w.text.length + 1 // line.text 는 단어를 공백으로 이었으므로 +1
    }
    if (clickedWord) break
  }
  if (!clickedWord) return null

  // 앞뒤 범위 자막(timedtext)으로 팝업 문맥을 구성. 없으면 현재 줄만.
  const before = latest.context?.before ?? []
  const after = latest.context?.after ?? []
  const parts = [...before, currentLine, ...after]
  const text = parts.join('\n')
  const base = before.reduce((n, l) => n + l.length + 1, 0) // 각 줄 뒤 '\n' 만큼 +1
  const start = base + wordOffsetInLine
  const end = start + clickedWord.text.length

  const language = detectSubtitleLanguage(text)
  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }

  return {
    text,
    anchor: { start, end },
    words: latestWords,
    language,
    source, // kind: youtube/netflix 가 자막 경로임을 나타냄
    extraction: 'direct', // 자막도 DOM/timedtext 직접 추출
  }
}
