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
  const first = latestWords[0]
  console.log(
    `[subtitle] words=${latestWords.length}`,
    snapshot ? `chrome=(${snapshot.viewport.chromeLeft},${snapshot.viewport.chromeTop})` : '',
    first ? `first="${first.text}" bbox=(${Math.round(first.bbox!.x)},${Math.round(first.bbox!.y)},${Math.round(first.bbox!.width)}x${Math.round(first.bbox!.height)})` : '',
  )
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

  const source = getBrowserSource()?.source ?? { kind: 'youtube' as const }
  const transcript = extensionBridge.getTranscript()

  // 전체 자막(timedtext)이 있으면 그걸 통째로 text 로 주고 anchor 만 클릭 단어에 맞춘다 —
  // 팝업이 설정 바이트(contextBytesBefore/After)만큼 앞뒤를 알아서 보여준다(OCR/텍스트와 동일).
  if (transcript && transcript.cues.length > 0) {
    const anchored = anchorInTranscript(transcript.cues, latest.currentTime, currentLine, clickedWord.text, wordOffsetInLine)
    if (anchored) {
      return {
        text: anchored.text,
        anchor: { start: anchored.start, end: anchored.end },
        words: latestWords,
        language: detectSubtitleLanguage(currentLine || anchored.text),
        source,
        extraction: 'direct',
      }
    }
  }

  // 전체 자막이 아직 없으면(로드 전/트랙 없음) 현재 줄만이라도 보여준다.
  return {
    text: currentLine,
    anchor: { start: wordOffsetInLine, end: wordOffsetInLine + clickedWord.text.length },
    words: latestWords,
    language: detectSubtitleLanguage(currentLine),
    source,
    extraction: 'direct',
  }
}

// 전체 자막 cue 들을 이어 붙여 팝업용 text 를 만들고, 클릭 단어의 offset(anchor)을 찾는다.
function anchorInTranscript(
  cues: { start: number; text: string }[],
  currentTime: number,
  currentLine: string,
  wordText: string,
  wordOffsetInLine: number,
): { text: string; start: number; end: number } | null {
  // 각 cue 를 줄바꿈으로 이어 붙이며 시작 offset 을 기록.
  const offsets: number[] = []
  let full = ''
  for (let i = 0; i < cues.length; i++) {
    offsets[i] = full.length
    full += cues[i].text
    if (i < cues.length - 1) full += '\n'
  }

  // 현재 재생 시각이 속한(또는 직전) cue.
  let idx = -1
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= currentTime + 0.25) idx = i
    else break
  }
  if (idx < 0) idx = 0

  // cue 안에서 클릭 단어 위치: 화면 줄이 cue 안 어디에 있는지 먼저 찾고 그 안의 단어 offset 을 더한다.
  const cueText = cues[idx].text
  let inCue: number
  const lineBase = currentLine ? cueText.indexOf(currentLine) : -1
  if (lineBase >= 0) {
    inCue = lineBase + wordOffsetInLine
  } else {
    const wi = cueText.indexOf(wordText)
    inCue = wi >= 0 ? wi : 0
  }
  const start = offsets[idx] + Math.min(inCue, cueText.length)
  const end = Math.min(start + wordText.length, offsets[idx] + cueText.length)
  return { text: full, start, end }
}
