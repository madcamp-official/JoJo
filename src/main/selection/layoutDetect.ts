import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect } from '@shared/types'
import { createPythonServer, TINY_PNG } from './pythonServer'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.
// DocLayout-YOLO(python/layout_detect.py, opendatalab 모델)를 서브프로세스로 불러
// 레이아웃 블록(+읽기 순서)을 얻는다. 다단(2단 등) 배치에서 Tesseract 단일 패스가
// 열을 뒤섞어 읽는 문제를, "블록별로 나눠서 순서대로 OCR" 하는 방식으로 우회하기
// 위한 전처리 단계다 — ocr.ts 가 이 결과를 보고 멀티 블록 경로로 갈지 결정한다.
//
// Python 환경(python/.venv, 모델 가중치)이 없거나 실패하면 null 을 반환해서 항상
// 기존 단일 패스 OCR 로 자연스럽게 폴백하게 한다 — 이 실험 기능이 안 갖춰진 개발
// 환경에서도 앱이 정상 동작해야 하기 때문(README 에 별도 설치 안내 필요).
//
// **상주 서버 프로세스로 통신한다(1회성 spawn 아님)** — 실측 결과 `python
// layout_detect.py <img>`를 매번 새로 띄우면 실제 추론(~1초)보다 torch import +
// 모델 로딩이 훨씬 커서(총 8초+) 리사이즈 한 번마다 이 호출이 최대 두 번(영역 자동
// 감지 1회 + ocr.ts 의 열 병합 판단 1회) 일어나 재추출이 심하게 느렸다(실사용 중
// "재추출까지 너무 오래 걸림"으로 확인). Python 을 `--serve` 모드로 한 번만 띄워
// 계속 살려두고(모델도 첫 요청 때 한 번만 로드) 표준입출력으로 줄 단위 JSON 요청/
// 응답을 주고받는다 — 이후 호출은 순수 추론 시간(~1초)만 든다.

export interface LayoutBlock {
  bbox: Rect
  label: string
  confidence: number
  column: number
}

interface RawBlock {
  x: number
  y: number
  width: number
  height: number
  label: string
  confidence: number
  order: number
  column: number
}

interface RawResponse {
  blocks: RawBlock[]
  vertical: boolean
}

export interface DetectedLayout {
  blocks: LayoutBlock[]
  /**
   * 세로쓰기(일본어 세로쓰기·망가 등) 페이지로 판단됐는지 — `layout_detect.py:
   * is_vertical_layout`(본문/제목 블록 대부분이 폭보다 높이가 뚜렷이 큰 좁고 긴
   * 모양인지로 판정). 열 순서 자체는 이미 서버에서 방향에 맞게(세로쓰기면 오른쪽→
   * 왼쪽) 정렬돼서 오므로 별도 처리가 필요 없고, 이 플래그는 나중에 인식 엔진을
   * 방향별로 고를 때 쓰기 위해 노출해둔다.
   */
  vertical: boolean
}

const server = createPythonServer('layout_detect.py', ['--serve'])

export async function detectLayoutBlocks(image: Buffer, region?: Rect): Promise<DetectedLayout | null> {
  const tmpPath = join(tmpdir(), `nuance-layout-${process.pid}-${Date.now()}.png`)
  await writeFile(tmpPath, image)
  const req = {
    image_path: tmpPath,
    region: region ? [region.x, region.y, region.width, region.height] : null,
  }
  const task = server.request<typeof req, RawResponse>(req)
  try {
    const { blocks: rawBlocks, vertical } = await task
    // 검증용 로그 — 세로쓰기 판정이 실제 콘텐츠(망가 등)에서 잘 잡히는지 눈으로 확인.
    console.log(`[layoutDetect] vertical=${vertical}, blocks=${rawBlocks.length}`)
    const blocks = rawBlocks
      .sort((a, b) => a.order - b.order)
      .map((b) => ({
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        label: b.label,
        confidence: b.confidence,
        column: b.column,
      }))
    return { blocks, vertical }
  } catch (err) {
    console.error('[layoutDetect] 레이아웃 검출 실패 — 단일 패스 OCR 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

/**
 * 앱 시작 시(warmup.ts) 미리 한 번 불러서 Python 서버를 띄우고 모델을 로드해둔다
 * — 실제 선택 모드에 들어갔을 때 첫 호출이 8초+ 걸리던 걸(torch import + 모델 로딩)
 * 사용자가 창을 고르는 동안 백그라운드에서 미리 끝내두기 위함이다. 반환된 promise 는
 * warmup.ts 가 "다 예열됐는지" 판단하는 데만 쓰고 결과값 자체는 버린다 — 실패해도
 * (Python 환경 없음 등) detectLayoutBlocks 가 이미 내부에서 잡아 null 을 반환하므로
 * 여기서도 절대 reject 하지 않는다(그래야 Promise.all 이 다른 엔진 예열까지 막지 않음).
 */
export async function warmUp(): Promise<void> {
  await detectLayoutBlocks(TINY_PNG)
}

/**
 * 같은 열(column, layout_detect.py 가 매긴 인덱스)의 블록들을 하나로 합친다. 모델이
 * 한 열 안의 문단을 여러 블록으로 쪼개 검출하는 경우가 있는데, 블록마다 따로
 * Tesseract 를 돌리면 그 블록 경계가 실제 문장 중간을 가로질러 글자가 잘리는 문제가
 * 있었다(실사용 중 "선택 영역 중간에도 클릭 안 되는 단어 + 팝업에서 첫 글자 잘림"으로
 * 재현) — 열 전체를 한 번에 인식해서 열과 열 "사이"의 진짜 여백에서만 경계가 생기게
 * 한다. 라벨은 그 열에서 가장 많이 나온 라벨을 대표로 쓴다.
 */
export function mergeIntoColumns(blocks: LayoutBlock[]): LayoutBlock[] {
  const byColumn = new Map<number, LayoutBlock[]>()
  for (const block of blocks) {
    const group = byColumn.get(block.column)
    if (group) group.push(block)
    else byColumn.set(block.column, [block])
  }

  return [...byColumn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([column, group]) => {
      const x0 = Math.min(...group.map((b) => b.bbox.x))
      const y0 = Math.min(...group.map((b) => b.bbox.y))
      const x1 = Math.max(...group.map((b) => b.bbox.x + b.bbox.width))
      const y1 = Math.max(...group.map((b) => b.bbox.y + b.bbox.height))
      const labelCounts = new Map<string, number>()
      for (const b of group) labelCounts.set(b.label, (labelCounts.get(b.label) ?? 0) + 1)
      const label = [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      return {
        bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        label,
        confidence: Math.min(...group.map((b) => b.confidence)),
        column,
      }
    })
}

/**
 * 모드 진입 시(영역 자동 감지, region 없이 이미지 전체로 검출) 캐시해둔 블록 목록을
 * 추출 시점(region 이 확정된 뒤)에 재사용할 때 쓴다 — Python 쪽 detect() 가 `region`을
 * 받으면 서버에서 이 필터를 직접 적용하는데, 캐시를 재사용할 땐 그 호출 자체를 생략
 * 하므로 같은 필터를 JS 쪽에서 동일하게 적용해줘야 한다(안 그러면 선택 영역 밖의
 * 블록까지 열 병합/세로쓰기 판정에 섞여 들어갈 수 있음).
 */
export function filterBlocksByRegion(blocks: LayoutBlock[], region: Rect): LayoutBlock[] {
  const regionRight = region.x + region.width
  const regionBottom = region.y + region.height
  return blocks.filter((b) => {
    const blockRight = b.bbox.x + b.bbox.width
    const blockBottom = b.bbox.y + b.bbox.height
    return !(blockRight < region.x || blockBottom < region.y || b.bbox.x > regionRight || b.bbox.y > regionBottom)
  })
}

/**
 * YOLO 가 잡는 블록 bbox 는 "글자 잉크가 있는 딱 그 범위"에 맞춰져서, 문장 끝
 * 마침표처럼 작고 획이 옅은 문장부호나 줄 맨 끝 글자의 삐침이 bbox 밖으로 살짝
 * 빠지는 경우가 있다 — 이 블록 bbox 를 그대로 Tesseract 의 crop 사각형(rectangle)
 * 으로 쓰면 그 부분이 아예 캡처가 안 돼서 인식 자체가 안 되고(온점이 통째로
 * 사라짐), 게다가 그 경계에 걸린 단어는 ocr.ts 의 잘림 판정(isWordClippedByRegion)
 * 에도 걸려 클릭도 안 되는 이중 문제가 생겼다. 실제로 담당자가 실사용 중 "문장
 * 마지막 단어가 클릭 안 됨 + 팝업에서 그 단어 온점이 사라짐"으로 재현했다.
 *
 * 가로/세로 패딩을 따로 받는다 — 실사용(메모장) 확인 결과, 줄 끝 단어가 통째로
 * 깨지는(예: "jump." → "jul") 정도의 가로 잘림을 막으려면 가로 패딩이 최소 50px은
 * 필요했다(10~30px 로는 여전히 깨짐, 50px 부터 정상). 반대로 세로 패딩을 그만큼
 * 키우면 위쪽 메뉴바/툴바 문구가 함께 크롭 영역에 딸려 들어오는 부작용이 있어서
 * (실측: 세로 40px 에서 발생, 10~15px 는 안전) 세로는 작게 유지한다 — 즉 가로/세로
 * 비대칭 여유가 필요하다는 게 실측으로 확인된 부분.
 */
export function padRect(rect: Rect, paddingX: number, paddingY: number, bounds: Rect): Rect {
  const boundsRight = bounds.x + bounds.width
  const boundsBottom = bounds.y + bounds.height
  const x0 = Math.max(bounds.x, rect.x - paddingX)
  const y0 = Math.max(bounds.y, rect.y - paddingY)
  const x1 = Math.min(boundsRight, rect.x + rect.width + paddingX)
  const y1 = Math.min(boundsBottom, rect.y + rect.height + paddingY)
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}
