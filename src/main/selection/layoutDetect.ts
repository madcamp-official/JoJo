import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rect } from '@shared/types'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.
// DocLayout-YOLO(python/layout_detect.py, opendatalab 모델)를 서브프로세스로 불러
// 레이아웃 블록(+읽기 순서)을 얻는다. 다단(2단 등) 배치에서 Tesseract 단일 패스가
// 열을 뒤섞어 읽는 문제를, "블록별로 나눠서 순서대로 OCR" 하는 방식으로 우회하기
// 위한 전처리 단계다 — ocr.ts 가 이 결과를 보고 멀티 블록 경로로 갈지 결정한다.
//
// Python 환경(python/.venv, 모델 가중치)이 없거나 실패하면 null 을 반환해서 항상
// 기존 단일 패스 OCR 로 자연스럽게 폴백하게 한다 — 이 실험 기능이 안 갖춰진 개발
// 환경에서도 앱이 정상 동작해야 하기 때문(README 에 별도 설치 안내 필요).

export interface LayoutBlock {
  bbox: Rect
  label: string
  confidence: number
  column: number
}

const PYTHON_BIN = join(
  __dirname,
  process.platform === 'win32' ? '../../python/.venv/Scripts/python.exe' : '../../python/.venv/bin/python',
)
const SCRIPT_PATH = join(__dirname, '../../python/layout_detect.py')

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

export async function detectLayoutBlocks(image: Buffer, region?: Rect): Promise<LayoutBlock[] | null> {
  const tmpPath = join(tmpdir(), `nuance-layout-${process.pid}-${Date.now()}.png`)
  await writeFile(tmpPath, image)
  try {
    const args = [SCRIPT_PATH, tmpPath]
    if (region) args.push('--region', `${region.x},${region.y},${region.width},${region.height}`)
    const stdout = await runPython(args)
    // 모델 로딩 중 huggingface_hub 등이 stdout/stderr 에 경고를 섞어 찍을 수 있어서,
    // 스크립트가 마지막 줄에만 JSON 을 찍기로 한 약속(layout_detect.py: print(json...))
    // 에 맞춰 마지막 줄만 파싱한다.
    const lastLine = stdout.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(lastLine) as { blocks: RawBlock[] }
    return parsed.blocks
      .sort((a, b) => a.order - b.order)
      .map((b) => ({
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        label: b.label,
        confidence: b.confidence,
        column: b.column,
      }))
  } catch (err) {
    console.error('[layoutDetect] 레이아웃 검출 실패 — 단일 패스 OCR 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
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

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject) // python 실행 파일 자체가 없는 경우(venv 미설치) 등
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`layout_detect.py exited with ${code}: ${stderr}`))
    })
  })
}
