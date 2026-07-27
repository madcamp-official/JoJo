import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect, Word } from '@shared/types'
import { detectLinesWithPaddle } from './ocrPaddle'
import { createPythonServerPool, TINY_PNG } from './pythonServer'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). manga-ocr(python/ocr_manga.py)
// 로 세로쓰기 일본어(망가 등)를 인식한다. 일반 PaddleOCR 로 가로쓰기 문서를 인식하는
// 것과 별도 경로 — manga-ocr 은 망가 말풍선 같은 세로쓰기·손글씨풍 폰트에 특화된
// 반면(직접 실측: 가로쓰기 일반 문장에 쓰면 오히려 품질이 나쁨), 인식 전용 모델이라
// bbox 를 전혀 안 준다(크롭 하나 → 텍스트 문자열 하나).
//
// 그래서 2단계로 나눈다:
//  1) PaddleOCR 의 detect_lines 모드(ocrPaddle.ts)로 줄 단위 박스만 얻는다(그 텍스트
//     인식 결과는 세로쓰기에 최적화가 안 돼있어 신뢰 안 함, 위치만 씀).
//  2) 각 줄 박스로 크롭해 manga-ocr 에 넘겨 텍스트를 받고, 그 줄 bbox 를 글자 수
//     비율로 나눠 글자 단위 박스를 만든다 — 한자/가나는 라틴 문자와 달리 폭이 거의
//     균일해서(정사각형 그리드에 가까움) 개수 비율 분배가 훨씬 안전하다(라틴 단어는
//     실측상 최대 15px 어긋났었음 — ocr.ts: padRect 주석 참고). 세로쓰기라 "폭"이
//     아니라 "높이"를 글자 수로 나눈다.

// 워커를 여러 개 띄운다 — 세로쓰기 열 하나에 줄이 10~15개면 manga-ocr 을 그만큼
// 순차 호출해야 했는데(실사용 중 "세로쓰기 페이지 인식이 오래 걸림"으로 확인, 열이
// 여러 개면 더 심해짐), 여러 워커에 나눠 동시에 처리하게 한다(아래 recognizeVerticalColumn
// 의 Promise.all 참고). ocrPaddle.ts 와 같은 개수로 맞춤(POOL_SIZE 주석 참고).
const POOL_SIZE = 3
const server = createPythonServerPool('ocr_manga.py', POOL_SIZE)

async function writeCrop(image: Buffer, bbox: Rect): Promise<string> {
  const cropped = nativeImage
    .createFromBuffer(image)
    .crop({
      x: Math.max(0, Math.round(bbox.x)),
      y: Math.max(0, Math.round(bbox.y)),
      width: Math.max(1, Math.round(bbox.width)),
      height: Math.max(1, Math.round(bbox.height)),
    })
    .toPNG()
  const tmpPath = join(tmpdir(), `nuance-manga-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await writeFile(tmpPath, cropped)
  return tmpPath
}

async function recognizeLine(image: Buffer, lineBbox: Rect): Promise<Word[]> {
  const tmpPath = await writeCrop(image, lineBbox)
  try {
    const { text } = await server.request<{ image_path: string }, { text: string }>({
      image_path: tmpPath,
    })
    const chars = [...text].filter((c) => c.trim().length > 0)
    if (chars.length === 0) return []
    // 세로쓰기: 줄 bbox 의 높이를 글자 수만큼 균등 분할(위→아래가 읽는 순서).
    const charHeight = lineBbox.height / chars.length
    return chars.map((c, i) => ({
      text: c,
      bbox: {
        x: lineBbox.x,
        y: lineBbox.y + i * charHeight,
        width: lineBbox.width,
        height: charHeight,
      },
    }))
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

// 후리가나(루비 문자)는 본문 옆에 훨씬 작은 폭으로 붙어서 별도 줄로 검출된다. 이걸
// manga-ocr 인식 "전"에(줄 검출 직후) 걸러내야 텍스트 박스/팝업 본문에서 빠지는 건
// 물론이고 인식 자체를 건너뛰어 실제 처리 시간이 줄어든다 — 인식이 끝난 뒤에 결과에서
// 걸러내면 manga-ocr 호출 횟수는 그대로라 시간 절감 효과가 없다. 세로쓰기 줄 박스의
// "폭"은 그 줄 글자 크기와 거의 같은데, 후리가나는 본문 대비 폰트 크기가 확연히
// 작아서(통상 50% 안팎) 폭도 비례해서 좁다 — 중앙값 대비 일정 비율보다 좁은 줄을
// 후리가나로 간주해 제외한다. lines.length<=1 이면 비교 기준이 없어 그대로 둔다.
const FURIGANA_WIDTH_RATIO = 0.6

function excludeFurigana(lines: Rect[]): Rect[] {
  if (lines.length <= 1) return lines
  const widths = lines.map((l) => l.width).sort((a, b) => a - b)
  const median = widths[Math.floor(widths.length / 2)]!
  return lines.filter((l) => l.width >= median * FURIGANA_WIDTH_RATIO)
}

/**
 * 세로쓰기로 판단된 열(column) 하나를 인식한다 — 실패하면(Python 환경 없음 등)
 * null 을 반환해 호출부가 다른 경로(PaddleOCR 가로쓰기 취급 또는 Tesseract)로
 * 폴백하게 한다.
 */
export async function recognizeVerticalColumn(image: Buffer, columnBbox: Rect): Promise<Word[] | null> {
  try {
    const detectStart = Date.now()
    const lines = await detectLinesWithPaddle(image, columnBbox)
    console.log(`[timing]     line detect: ${Date.now() - detectStart}ms (lines=${lines?.length ?? 'null'})`)
    if (!lines || lines.length === 0) return []
    // 줄은 위→아래 순서로 읽는다(세로쓰기 한 열 안에서의 읽기 순서).
    lines.sort((a, b) => a.y - b.y)
    const bodyLines = excludeFurigana(lines)
    console.log(`[timing]     furigana filter: ${lines.length} -> ${bodyLines.length} lines`)
    // 줄마다 순차로(await 를 for 안에서) 호출하면 워커 풀을 만든 의미가 없다 — 한
    // 줄이 끝나야 다음 줄을 보내니 결국 워커 하나만 쓰는 것과 같다. Promise.all 로
    // 한꺼번에 보내야 여러 워커에 분산돼 실제로 병렬 처리된다. 결과 배열 순서는
    // Promise.all 이 입력 순서(=위→아래 줄 순서)를 그대로 보존하므로 완료 순서와
    // 무관하게 올바르게 이어붙는다.
    const recognizeStart = Date.now()
    const perLine = await Promise.all(bodyLines.map((line) => recognizeLine(image, line)))
    console.log(`[timing]     line recognize (${bodyLines.length} lines): ${Date.now() - recognizeStart}ms`)
    return perLine.flat()
  } catch (err) {
    console.error('[ocrManga] 세로쓰기 인식 실패:', err)
    return null
  }
}

/**
 * 앱 시작 시(warmup.ts) 미리 불러서 풀의 워커 전부에 manga-ocr 모델을 로드해둔다 —
 * 워커마다 모델을 독립적으로 로드하므로 하나만 예열하면 나머지는 실제 사용 시점에야
 * 콜드 스타트를 겪는다. `recognizeLine` 대신 서버에 직접 요청한다 — `recognizeLine`은
 * 매번 새 임시 파일을 쓰는데, 워커 수만큼 동시에 보낼 거라 파일 하나를 공유하는 게
 * 낫다.
 *
 * `server.warmUpAll()`은 Python 쪽 에러를 그대로 reject 로 전달한다 — 여기서 안 잡으면
 * warmup.ts 의 `Promise.all([...])`이 통째로 reject 돼서(다른 엔진은 멀쩡해도) "예열
 * 완료" 상태로 절대 안 넘어가고 창 선택 버튼이 계속 막혀있게 된다. 그래서 이 함수는
 * 절대 reject 하지 않도록 직접 잡는다.
 */
export async function warmUp(): Promise<void> {
  try {
    const tmpPath = await writeCrop(TINY_PNG, { x: 0, y: 0, width: 1, height: 1 })
    try {
      await server.warmUpAll<{ image_path: string }, { text: string }>({ image_path: tmpPath })
    } finally {
      void unlink(tmpPath).catch(() => {})
    }
  } catch (err) {
    console.error('[ocrManga] 예열 실패(무시):', err)
  }
}
