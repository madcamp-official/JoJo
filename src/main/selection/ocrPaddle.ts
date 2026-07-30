import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Language, Rect, Word } from '@shared/types'
import { segmentChineseWords } from '../nlp/chinese'
import { segmentJapaneseWords } from '../nlp/japanese'
import { createPythonServerPool, defaultPoolSize, TINY_PNG } from './pythonServer'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo). PaddleOCR(python/ocr_paddle.py)
// 로 en/zh/ja(가로쓰기) 텍스트를 검출+인식한다 — 일본어 스캔 파일에서 Tesseract
// 인식률이 낮아서(실사용 확인) 도입. Tesseract 의 `rectangle` 옵션 같은 크롭 restrict
// 가 PaddleOCR 엔 없어서, 여기서 직접 크롭한 이미지를 Python 에 넘긴다 — 그래서
// 응답 bbox 는 크롭 기준 상대좌표이고, cropBbox 원점을 더해 절대좌표로 되돌린다.
//
// 워커를 여러 개 띄운다 — 다단 레이아웃은 열마다(세로쓰기는 줄마다) 따로 인식을
// 돌려야 해서(ocr.ts) 워커가 적으면 여러 줄/열이 몇 라운드씩 나눠서 순서대로 기다린다
// (실사용 중 "세로쓰기 페이지 인식이 오래 걸림"으로 확인). 예전엔 3 → 6으로 고정값을
// 올려서 튜닝했는데(세로쓰기 한 페이지 줄이 14~15개인 경우가 흔해서, 3개면 5라운드,
// 6개면 3라운드로 줄어듦), 그 6이라는 숫자는 이 개발 컴퓨터(물리 4코어)에 맞춘 값이라
// 다른 사용자 환경(코어 수가 다름)엔 안 맞을 수 있다 — `defaultPoolSize()`(pythonServer.ts)
// 로 실행 중인 기기의 실제 코어 수에 맞게 동적으로 정한다. 워커마다 모델을 독립적으로
// 메모리에 올려서(공유 안 됨) 메모리 사용량이 그만큼 늘어나는 트레이드오프가 있다
// (실측: 워커 하나당 ~700~800MB).
const POOL_SIZE = defaultPoolSize()
const server = createPythonServerPool('ocr_paddle.py', POOL_SIZE)

interface RawWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

interface RawLine {
  x0: number
  y0: number
  x1: number
  y1: number
}

async function writeCrop(image: Buffer, cropBbox: Rect): Promise<string> {
  const cropped = nativeImage
    .createFromBuffer(image)
    .crop({
      x: Math.max(0, Math.round(cropBbox.x)),
      y: Math.max(0, Math.round(cropBbox.y)),
      width: Math.max(1, Math.round(cropBbox.width)),
      height: Math.max(1, Math.round(cropBbox.height)),
    })
    .toPNG()
  const tmpPath = join(tmpdir(), `nuance-paddle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await writeFile(tmpPath, cropped)
  return tmpPath
}

/**
 * cropBbox 로 잘라낸 이미지를 PaddleOCR 로 인식해 글자/단어 단위 실제 bbox 를 그대로
 * 받는다(`return_word_box=True`) — Tesseract 때처럼 "글자 개수 비율로 폭 추정" 할
 * 필요가 없다(실측 확인: 그 추정 방식은 라틴 단어에서 최대 15px 어긋났었음). 실패하면
 * (Python 환경 없음 등) null 을 반환해 호출부가 Tesseract 로 폴백하게 한다.
 */
export async function recognizeWithPaddle(
  image: Buffer,
  language: Language,
  cropBbox: Rect,
  // 담당 A — 가로쓰기 후리가나 노이즈 대응 실험(2026-07-29): 인식 모델을 호출부가
  // 골라 넘길 수 있게 함(예: 더 가벼운 모델로 속도 비교). 생략하면 Python 쪽 기본값
  // (RECOGNITION_MODEL_NAME, medium)을 그대로 쓴다 — 기존 호출부는 전부 무변화.
  recModel?: string,
): Promise<Word[] | null> {
  const tmpPath = await writeCrop(image, cropBbox)
  try {
    const { words } = await server.request<
      { image_path: string; language: string; rec_model?: string },
      { words: RawWord[] }
    >({ image_path: tmpPath, language, rec_model: recModel })
    return words.map((w) => ({
      text: w.text,
      bbox: {
        x: cropBbox.x + w.x0,
        y: cropBbox.y + w.y0,
        width: w.x1 - w.x0,
        height: w.y1 - w.y0,
      },
    }))
  } catch (err) {
    console.error('[ocrPaddle] 인식 실패 — Tesseract 로 폴백:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

// 줄 위치만 찾는 용도(detectLinesWithPaddle)는 텍스트를 안 믿고 버리므로 언어를
// 호출부마다 다르게 받을 이유가 없다 — 오히려 호출부마다 다른 언어를 넘기면 PaddleOCR
// 엔진이 언어별로 따로 생성되는데, 실측해보니 엔진 하나 새로 만들 때마다(가중치 파일이
// 이미 캐시돼 있어도) 예측기 구성에만 15~20초가 걸린다(실사용 중 "본문 영역 자동 감지
// 폴백에서 en 엔진 + 실제 인식에서 ja 엔진, 총 30초+"로 확인). 게다가 로그를 보면 검출/
// 인식 모델 이름 자체가 언어에 무관하게 동일(`PP-OCRv6_medium_det`/`_rec`)해서 — 최신
// PaddleOCR 는 모델을 언어별로 따로 두지 않고 `lang` 은 주로 후처리(문자 사전)에만
// 쓰는 것으로 보인다. 그래서 "위치만" 필요한 호출은 전부 이 고정 태그로 통일해 같은
// 캐시된 엔진을 재사용하고, 실제 인식(recognizeWithPaddle)에만 진짜 언어를 쓴다 —
// 한 번의 선택에서 최대 2개(위치 전용 1개 + 실제 인식 언어 1개)까지만 새로 생성되게.
const DETECTION_ONLY_LANGUAGE: Language = 'en'

/**
 * 줄 단위 박스만 얻는다(텍스트는 안 믿고 버림) — DocLayout 이 아예 실패했을 때 본문
 * 영역을 텍스트 위치로 직접 추정하는 데(regionSelection.ts) 쓴다.
 *
 * 넓은 크롭을 조각내 워커 풀에 병렬로 돌리는 방식을 두 번 시도했다 — 처음엔(검출이
 * `PaddleOCR.predict()` 풀 파이프라인이라 줄 개수에 비례해 느려지던 시절) 아예 효과가
 * 없었고, 검출 전용 API(`TextDetection`)로 바꿔 정말로 폭에 비례해서 느려지는 걸
 * 확인한 뒤 다시 시도했을 땐 소요 시간은 줄었지만(13.1초→11.6초) 조각 경계 근처에서
 * 검출된 줄의 박스 경계가 조각마다 미세하게 달라져서, x좌표 기반 열 재정렬
 * (clusterVerticalLinesIntoColumns)의 순서가 실제로 뒤바뀌는 문제가 실측 확인됐다
 * (예: 두 문장의 순서가 통째로 바뀜) — 1~2초 아끼자고 읽기 순서가 틀리는 건 손해가 커서
 * 다시 뺐다. 크롭 하나를 통째로(워커 하나로) 검출해야 조각 경계로 인한 오차가 없다.
 */
// 담당 A — unclip_ratio 실험(2026-07-30, 사용자 요청). PaddleX TextDetection 의 검출
// 후처리 기본값은 unclip_ratio=2.0 — 모델이 내부적으로 살짝 줄여 잡은 텍스트 영역을
// 이 배율만큼 부풀려 최종 박스로 만든다. 문장부호 몇 개짜리처럼 잉크가 희소한 짧은
// 줄은 이 부풀림이 상대적으로 더 크게 작용해 경계가 옆 열 쪽으로 번질 여지가 커진다는
// 가설로 낮춰서 실측 비교한다(env `OCR_DET_UNCLIP_RATIO` 로 값 지정, 기본은 실험값
// 1.5 — 지정 없이 undefined 로 두면 파이썬 쪽이 기본값 그대로 씀). 정상 줄까지 너무
// 타이트해져 잉크가 잘리는 부작용이 없는지 실사용 재확인 후 상수로 굳히거나 되돌릴 것.
const DET_UNCLIP_RATIO = process.env.OCR_DET_UNCLIP_RATIO
  ? Number(process.env.OCR_DET_UNCLIP_RATIO)
  : 1.5

export async function detectLinesWithPaddle(image: Buffer, cropBbox: Rect): Promise<Rect[] | null> {
  const tmpPath = await writeCrop(image, cropBbox)
  try {
    const { lines } = await server.request<
      {
        image_path: string
        language: string
        mode: 'detect_lines'
        det_unclip_ratio?: number
      },
      { lines: RawLine[] }
    >({
      image_path: tmpPath,
      language: DETECTION_ONLY_LANGUAGE,
      mode: 'detect_lines',
      det_unclip_ratio: DET_UNCLIP_RATIO,
    })
    if (process.env.DEBUG_OCR_DUMP) {
      console.log(`[ocrPaddle] detect_lines unclip_ratio=${DET_UNCLIP_RATIO} lines=${lines.length}`)
    }
    return lines.map((l) => ({
      x: cropBbox.x + l.x0,
      y: cropBbox.y + l.y0,
      width: l.x1 - l.x0,
      height: l.y1 - l.y0,
    }))
  } catch (err) {
    console.error('[ocrPaddle] 줄 검출 실패:', err)
    return null
  } finally {
    void unlink(tmpPath).catch(() => {})
  }
}

// python/layout_detect.py 의 is_vertical_layout() 과 같은 기준(비율 임계값 1.4, 과반수
// 조건) — 다만 DocLayout 의 "문단(여러 줄 뭉치)" 단위 대신 PaddleOCR 의 "줄 하나" 단위
// 박스에 적용한다. 문단 단위는 가로쓰기라도 줄바꿈이 많으면 세로로 길어져 오판할 수
// 있는데(좁은 다단 레이아웃 등), 줄 하나하나는 그 문제가 없다 — 실측 확인: 진짜
// 세로쓰기 줄은 h/w 비율이 14~15 로 임계값(1.4)을 압도적으로 넘고, 가로쓰기 줄은 원래
// 폭이 넓고 높이가 얕아 1 미만이라 명확히 갈린다.
const VERTICAL_LINE_RATIO_THRESHOLD = 1.4
const VERTICAL_LINE_MIN_FRACTION = 0.5

/**
 * DocLayout 이 블록을 하나도 못 찾았을 때(blocks=0, `vertical` 판정 근거 자체가 없는
 * 상황) — PaddleOCR 로 직접 찾은 줄 박스 모양을 재서 가로/세로를 실측 판별한다. 이전엔
 * "언어가 ja/zh 면 무조건 세로쓰기로 가정"하는 블라인드 폴백을 썼는데, 실제로 보고
 * 판단하는 쪽이 더 정확하다.
 */
export function isVerticalByLineShape(lines: Rect[]): boolean {
  if (lines.length === 0) return false
  const verticalCount = lines.filter(
    (l) => l.width > 0 && l.height / l.width >= VERTICAL_LINE_RATIO_THRESHOLD,
  ).length
  return verticalCount / lines.length >= VERTICAL_LINE_MIN_FRACTION
}

// 후리가나(루비 문자)는 본문 옆에 훨씬 좁은 폭으로, 그 본문 글자와 y 범위가 겹치게
// 붙어서 검출된다 — 이전엔 "중앙값 대비 폭 비율"만으로 후리가나를 걸렀는데, 실측 확인
// 결과 그 방식은 그냥 짧은 본문 줄까지 오탐으로 같이 잘라냈다(이웃이 없어도 좁으면
// 다 걸림). 그래서 여기서는 "이 줄보다 훨씬 넓고(FURIGANA_WIDTH_RATIO 배 이상) y 범위가
// 많이 겹치는(FURIGANA_Y_OVERLAP_MIN 이상) '부모' 줄이 바로 옆에 있는가"를 직접 확인한다
// — 후리가나의 기하학적 특징(좁고, 본문 옆에 딱 붙어서, 같은 세로 범위를 차지) 자체를
// 보는 것이라 오탐이 훨씬 적다. 부모가 없는 좁은 줄(예: 짧은 독립된 본문 줄)은 그대로
// 살아남는다. 실제 여러 열짜리 페이지에서 이 필터 없이 열 병합을 했더니 후리가나가
// 만든 잡음 줄들 때문에 열 간격 판정 자체가 흔들려 순서가 뒤섞이고 내용이 빠지는 문제가
// 있었다(실측 확인) — 그래서 열 병합보다 먼저 적용한다.
const FURIGANA_WIDTH_RATIO = 1.8
const FURIGANA_Y_OVERLAP_MIN = 0.5
// 후리가나는 본문 글자에 거의 맞닿아 있다 — 간격이 이 배율(자기 폭 기준)보다 멀면
// "옆에 붙은 주석"이 아니라 그냥 다른 열로 본다.
const FURIGANA_MAX_GAP_RATIO = 2

function yOverlapFraction(a: Rect, b: Rect): number {
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const overlap = Math.max(0, bottom - top)
  const minHeight = Math.min(a.height, b.height)
  return minHeight > 0 ? overlap / minHeight : 0
}

function xGap(a: Rect, b: Rect): number {
  return Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
}

// ja/zh 인식 백엔드를 여러 개(PaddleOCR, Yomitoku) 두면서 이 필터를 Rect 뿐 아니라
// "Rect + 그 줄의 텍스트" 같은 확장 타입에도 그대로 쓸 일이 생겨서(ocrYomitoku.ts)
// 제네릭으로 바꿨다 — 내부 로직은 Rect 필드(x/y/width/height)만 보고 그 외 필드는
// 아예 안 건드리므로 동작 변화 없음, 기존 호출부(Rect[] 그대로 넘김)도 그대로 동작한다.
//
// widthRatio 를 인자로 뺀 이유: Yomitoku 의 후리가나 검출 박스는 PaddleOCR 만큼 타이트하게
// 안 잘려서(실측 확인: 본문 대비 1.4~1.75배 정도, PaddleOCR 는 보통 2배 이상) 기본값
// (FURIGANA_WIDTH_RATIO=1.8, PaddleOCR 기준으로 튜닝됨)으로는 실제 후리가나가 안 걸러지고
// 그대로 열로 남아 열 순서/기준선 계산을 오염시켰다(실사용 중 확인) — ocrYomitoku.ts 는
// 더 낮은 값을 넘겨써서 이 문제를 피한다. PaddleOCR 호출부는 인자를 안 넘기므로 기존
// 동작(1.8) 그대로 유지된다.
export function excludeFurigana<T extends Rect>(lines: T[], widthRatio: number = FURIGANA_WIDTH_RATIO): T[] {
  return lines.filter((line) => {
    const hasWiderNeighbor = lines.some((other) => {
      if (other === line) return false
      if (other.width < line.width * widthRatio) return false
      if (yOverlapFraction(line, other) < FURIGANA_Y_OVERLAP_MIN) return false
      return xGap(line, other) <= line.width * FURIGANA_MAX_GAP_RATIO
    })
    return !hasWiderNeighbor
  })
}

function xOverlapFraction(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const overlap = Math.max(0, right - left)
  const minWidth = Math.min(a.width, b.width)
  return minWidth > 0 ? overlap / minWidth : 0
}

function yGap(a: Rect, b: Rect): number {
  return Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
}

// 실측 확인(사용자 보고): 가로쓰기 후리가나는 본문 글자 "옆"이 아니라 "위"에 붙는다 —
// excludeFurigana(세로쓰기용)는 폭이 좁고 y 범위가 겹치는 이웃을 찾는데, 가로쓰기는
// 반대로 **높이가 낮고 x 범위가 겹치는** 이웃(본문 줄)이 있으면 후리가나다. 그래서
// excludeFurigana 를 그대로 재사용할 수 없고(기하학 자체가 90도 다름), 별도 함수로
// 둔다. 이 필터가 가로쓰기 경로(recognizeLinesWithPaddle)에 아예 연결이 안 돼 있어서
// 후리가나가 그대로 본문 줄과 섞여 인식됐고, 후리가나 줄마다 별도의 PaddleOCR 호출이
// 추가로 발생해(글자 수만큼 줄 수가 거의 두 배로 늘어남) 속도도 느려지는 문제가
// 같이 실측 확인됨.
//
// **(2026-07-29) 임계값 재조정** — 처음엔 세로쓰기 폭 비율(1.8)을 그대로 가져다 썼는데,
// 실사용 중 "후리가나가 전혀 안 걸러짐"으로 재확인돼 실제 NHK 페이지의 검출 로그를
// 찍어보니 본문:후리가나 실측 높이 비율이 1.17~2.3 사이에 넓게 분포했다 — 1.8 이상인
// 소수만 걸러지고 대다수(실측: 55개 중 48개)가 그대로 남았음. 실측 최솟값(1.167)보다
// 낮은 1.15 로 낮춰 대부분을 잡아내도록 함(요구 조건인 x 겹침 50%+ / 세로 간격 근접 조건과
// 함께 걸어서, 이 정도로 낮춰도 우연히 옆에 큰 이웃이 있는 정상 짧은 본문 줄까지 잘못
// 걸릴 위험은 낮다고 판단).
const FURIGANA_HEIGHT_RATIO = 1.15
const FURIGANA_X_OVERLAP_MIN = 0.5
const FURIGANA_MAX_GAP_RATIO_VERTICAL = 2

export function excludeFuriganaHorizontal<T extends Rect>(
  lines: T[],
  heightRatio: number = FURIGANA_HEIGHT_RATIO,
): T[] {
  return lines.filter((line) => {
    const hasTallerNeighbor = lines.some((other) => {
      if (other === line) return false
      if (other.height < line.height * heightRatio) return false
      if (xOverlapFraction(line, other) < FURIGANA_X_OVERLAP_MIN) return false
      return yGap(line, other) <= line.height * FURIGANA_MAX_GAP_RATIO_VERTICAL
    })
    return !hasTallerNeighbor
  })
}

// 세로쓰기 열이 여러 개인 페이지에서 DocLayout 이 열을 못 나눠주면(blocks=0) 줄 검출
// 결과가 열 구분 없이 전부 섞여서 온다 — 이걸 그냥 y좌표로만 정렬하면 서로 다른 열의
// 줄이 뒤섞여 읽힌다(예: A열 3번째 줄 다음에 B열 1번째 줄이 오는 식). x좌표로 다시 열을
// 묶어서 세로쓰기 순서(오른쪽 열부터, 각 열 안에서는 위→아래)로 바로잡는다. 열 간격
// 판정 기준은 줄 폭의 중앙값 — 세로쓰기 줄 하나의 폭은 대략 글자 크기라 같은 열 안의
// 줄들은 폭이 비슷하고, 다른 열로 넘어가면 그보다 확연히 떨어진 x에 나타난다.
// 정상적인 단일 열(DocLayout 이 이미 열을 나눠준 경우 등)에서는 이 클러스터링이 그냥
// 열 1개로 수렴하므로 무해하다 — recognizeVerticalColumnWithPaddle 에서 항상 적용한다.
// (후리가나를 미리 걸러내지 않으면 그 좁은 잡음 줄들이 중앙값 폭 자체를 왜곡시켜서
// 열 간격 판정이 흔들린다 — 실측 확인.)
//
// 담당 A — 1.5 → 1.2 로 하향(2026-07-30, 실측 확인 — 사용자 제보 "열 순서가 A B C
// 대신 A C B 로 나옴" + "한 열의 일부가 다른 열 중간에 낀다"). DEBUG_OCR_DUMP 로 실제
// 페이지의 열 중심 x 를 찍어보니, 서로 다른 두 열의 중심 간격이 66.5px 였는데 그 페이지
// 글자 폭 중앙값(45px)×1.5 = 67.5px 라 **1px 차이**로 "같은 열"로 오판돼 있었다 —
// 중심거리 = 폭 + 간격 이므로 이 비율(1.5)은 산수상 "열 사이 빈 간격이 글자 폭의
// 0.5배보다 작으면 같은 열"과 동치인데, 이 페이지의 실제 열 간격도 하필 글자 폭의
// 0.48~0.55배 정도로(다른 정상 열 쌍들도 동일 범위) 그 경계선에 바짝 붙어 있어서 노이즈
// 몇 px 차이로 도박처럼 병합 여부가 갈렸다. 병합되면 그 안에서 y좌표로 재정렬하는데,
// 그 두 열이 진짜 다른 열이다 보니 순서가 뒤섞이거나(A C B) 각 열이 여러 조각으로 검출된
// 경우 조각들끼리 y로 잘못 인터리브돼("한 열의 일부가 다른 열 중간에 낀다") 두 증상이
// 사실 같은 원인이었다. 진짜 같은 열의 서로 다른 조각은 x가 사실상 거의 동일하게 검출돼
// (중심 거리 몇 px 이내) 이 정도로 낮춰도 안전하게 병합되고, 실측된 진짜 다른 열 간격
// (비율 약 1.48~1.55)은 확실히 걸러진다.
// 담당 A — 1.2 → 0.85 로 재하향(2026-07-30, 사용자 제보 "열 순서가 다소 바뀜" +
// DEBUG_OCR_DUMP(texts-*.json 의 gapRatioToMedian) 실측 확인). 세로쓰기 다단 소설
// 캡처에서 최종 순서가 오른쪽→왼쪽 단조 감소를 어기는 지점(예: center 1385.5→1418,
// 703.5→727)이 9곳 있었는데, 전부 그 지점의 gapRatioToMedian 이 0.90~1.02(=바로 앞
// 열 간격의 딱 1배)로 몰려 있었다 — 즉 실제로는 서로 다른 두 좁은 열의 중심 거리가
// medianWidth 의 1.0배 정도인데 gapThreshold(medianWidth*1.2)에 못 미쳐 같은 열로
// 오합쳐지고, 그 안에서 y로 재정렬되며 두 열의 줄이 번갈아 섞였다(전형적인 "핑퐁"
// 패턴). 진짜 같은 열의 조각은 중심 거리가 "몇 px 이내"(위 COLUMN_GAP_RATIO 첫 하향
// 시점 주석 참고)라 0.85 로 낮춰도 안전하게 병합되고, 이번에 문제였던 1.0배 간격은
// 확실히 걸러진다.
const COLUMN_GAP_RATIO = 0.85

// excludeFurigana 와 같은 이유로 제네릭화(ocrYomitoku.ts 에서 "Rect + 텍스트" 쌍을
// 그대로 재정렬하는 데 재사용) — 내부는 Rect 필드만 본다.
export function clusterVerticalLinesIntoColumns<T extends Rect>(lines: T[]): T[] {
  if (lines.length <= 1) return lines
  const widths = [...lines].map((l) => l.width).sort((a, b) => a - b)
  const medianWidth = widths[Math.floor(widths.length / 2)]!
  const gapThreshold = medianWidth * COLUMN_GAP_RATIO

  // 오른쪽 열부터 읽는다(세로쓰기 관례) — x 중심 기준 내림차순으로 훑으며 묶는다.
  const byX = [...lines].sort((a, b) => b.x + b.width / 2 - (a.x + a.width / 2))

  const columns: T[][] = []
  const columnCenterSum: number[] = []
  const columnCount: number[] = []
  for (const line of byX) {
    const center = line.x + line.width / 2
    // 담당 A — 재수정(2026-07-30, 사용자 제보 — 아래 최종 재정렬 보완만으로는 "일부
    // 순서가 여전히 안 맞는다"는 사례가 남음). 예전엔 "바로 직전 열"하고만 비교했는데,
    // 문장부호만 있는 짧은 줄처럼 검출 폭이 유독 좁은 줄은 중심 x 가 원래 열 범위를 살짝
    // 벗어나 그 순간 엉뚱하게 새 열을 만들었다 — 그 뒤로 진짜 다음 열(C)의 줄들이 오면
    // "직전 열"이 이미 그 잘못 만들어진 조각으로 바뀌어 있어서, 나중에 나오는 원래 열(B)의
    // 나머지 줄들도 C와 비교당해 또 새 열이 됐다(B가 두 조각으로 쪼개짐). 최종 펼치기 전
    // 평균 중심 x 로 재정렬해도, 조각난 두 그룹의 평균 자체가 서로 다르면(예: 한쪽 조각에
    // 유난히 좁은 줄이 몰려 평균이 왜곡됨) 재정렬 후에도 두 조각이 다시 붙지 못하고 순서가
    // 깨질 수 있었다 — 애초에 조각나지 않게, 직전 열이 아니라 **지금까지 만들어진 모든
    // 열** 중 중심이 가장 가까운(그리고 gapThreshold 이내인) 열을 찾아 합친다. 어느 열과도
    // 안 가까우면(=진짜 새 열) 그때만 새로 만든다 — 이러면 순서상 멀리 떨어져 다시
    // 나타나도 원래 열로 정확히 되돌아간다.
    let bestIdx = -1
    let bestDist = Infinity
    for (let i = 0; i < columns.length; i++) {
      const dist = Math.abs(columnCenterSum[i]! / columnCount[i]! - center)
      // 경계값(간격이 정확히 gapThreshold 와 같은 경우)은 "다른 열"로 본다(<= 가 아니라 <)
      // — 실측 확인: 어떤 페이지에서 서로 다른 두 열의 중심 간격이 medianWidth*COLUMN_GAP_RATIO
      // 와 정확히 일치해서(글자 폭이 균일한 조판이라 우연이 아니라 실제로 자주 맞아떨어짐)
      // <= 였을 때 두 열이 하나로 합쳐져 버렸고, 합쳐진 뭉치 안에서 y좌표로 재정렬되며 읽기
      // 순서가 뒤섞였다(오른쪽 열이 왼쪽 열보다 늦게 읽힘). 경계에서는 "합치지 않음" 쪽이
      // 더 안전한 기본값이다 — 잘못 합쳐지면 순서가 깨지지만, 잘못 안 합쳐지면(같은 열이
      // 조각나 있던 경우) 최악의 경우도 아래 최종 재정렬이 조각들을 다시 나란히 붙여준다.
      if (dist < gapThreshold && dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    if (bestIdx >= 0) {
      columns[bestIdx]!.push(line)
      columnCenterSum[bestIdx]! += center
      columnCount[bestIdx]!++
    } else {
      columns.push([line])
      columnCenterSum.push(center)
      columnCount.push(1)
    }
  }

  // 담당 A — 열 순서 뒤바뀜 버그 수정(2026-07-30, 사용자 제보 — "A B C 순서여야 하는데
  // A C B 로 나옴"). 위 루프는 "바로 직전 열"하고만 비교하는 단일 패스라, 어떤 줄(특히
  // 문장부호만 있는 짧은 줄 등)의 검출 폭이 살짝 어긋나 그 중심 x 가 정상 범위를 벗어나면
  // 그 자리에서 엉뚱하게 새 열이 끼어들 수 있다 — 예: B열 줄 하나가 노이즈로 C열 x범위에
  // 걸리면 훑는 순서상 A, B(일부), C, B(나머지)로 조각나고, 그대로 펼치면 최종 순서가
  // A C B 가 돼버린다. 펼치기 전에 각 열의 평균 중심 x 로 다시 한번 내림차순 정렬해두면,
  // 이런 단일 패스 도중의 조각남과 무관하게 최종 열 순서는 항상 오른쪽→왼쪽으로 정확하다
  // (같은 열이 여러 조각으로 쪼개진 경우, 조각들의 평균이 서로 가까워 결과적으로 다시
  // 나란히 붙게 되는 효과도 있음).
  const columnOrder = columns
    .map((_, i) => i)
    .sort((a, b) => columnCenterSum[b]! / columnCount[b]! - columnCenterSum[a]! / columnCount[a]!)
  const orderedColumns = columnOrder.map((i) => columns[i]!)
  for (const column of orderedColumns) column.sort((a, b) => a.y - b.y) // 열 안에서는 위→아래
  return orderedColumns.flat()
}

// 담당 A — 중앙값 배수 기준 폐기(2026-07-30, 재재수정 — 2차 시도(중앙값×4)를 실측
// 확인해보니 175줄이 12열로 쪼개져 있었다). 실제 간격 목록을 직접 찍어보니(예:
// left=441/480/562/643/760/799/1050/1175/...) 진짜 열 경계는 딱 하나(799→1050,
// 251px)뿐인데, 같은 열 안에서도 문단 들여쓰기 스타일이 여러 단계라(신규 문단/
// 이어지는 줄/인용구 등) 37~125px대 간격이 여러 번 나왔다 — "간격이 작은 것과 큰 것
// 딱 두 부류"라는 중앙값 배수의 전제 자체가 안 맞았다(들여쓰기 간격들이 그 사이 어딘가
// 넓게 퍼져 있음). 대신 **전체 간격 중 최댓값 대비 비율**로 판단한다 — 진짜 열 사이
// 거터는 어떤 들여쓰기 차이보다도 압도적으로 커야 다단 레이아웃이 성립하므로, 최댓값의
// 상당 부분(70%) 이상인 간격만 열 경계로 인정하면 자잘한 들여쓰기 차이는 다 걸러지고
// 압도적으로 큰 진짜 거터만 남는다(위 실측 데이터로 검증: 251px 하나만 197.75px(=251×0.7)
// 문턱을 넘고 나머지(최대 125px)는 다 걸러짐).
const COLUMN_GAP_MAX_RATIO_HORIZONTAL = 0.7
const COLUMN_GAP_MIN_PX = 30

/**
 * 담당 A — 가로쓰기 다단 줄 재군집화(2026-07-30, 사용자 제보 — "가로쓰기 2단인데 y좌표가
 * 높은 순서대로 열 무관하게 나온다"). `mergeIntoColumns`(layoutDetect.ts)를 블록의 왼쪽
 * 경계 x 기준으로 고쳤는데도 이 증상이 재현된 원인은 더 앞단이었다 — DocLayout이 이
 * 캡처에서 본문 커버리지가 낮다고 판단해(0.2% < 50%, `MIN_BODY_COVERAGE_RATIO`) 블록
 * 자체를 버리고 선택 영역 전체를 하나의 크롭으로 스캔하는 폴백 경로(`ocr.ts: runOcr`)로
 * 빠졌는데, 그 폴백에서 실제 줄 순서를 정하는 `recognizeLinesWithPaddle`(아래)이 단순
 * `sort((a,b)=>a.y-b.y)`로 열 구분 없이 y좌표로만 정렬하고 있었다 — 두 열이 한 크롭
 * 안에 섞여 있으면 이 정렬이 정확히 "y가 낮은 순서대로, 열 무관"이라는 증상을 만든다.
 * 세로쓰기가 이미 겪은 것과 똑같은 근본 문제(clusterVerticalLinesIntoColumns 도입 계기)
 * 라 같은 해법을 줄(line) 단위에 적용한다 — 블록용 재군집화(layoutDetect.ts)와 같은
 * 이유로 왼쪽 경계 x 기준, 왼쪽→오른쪽 순서. 다만 임계값 계산 방식은 위 주석대로
 * 다르다(요소 폭 비율이 아니라 간격들의 상대 크기).
 */
export function clusterHorizontalLinesIntoColumns<T extends Rect>(lines: T[]): T[] {
  if (lines.length <= 1) return lines
  const byLeft = [...lines].sort((a, b) => a.x - b.x)

  const gaps = byLeft.slice(1).map((l, i) => l.x - byLeft[i]!.x)
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0
  // 열 경계로 인정하는 간격 — "최댓값의 상당 부분(비율)" 과 "절대 최소 px" 중 큰 쪽.
  // maxGap 이 작으면(진짜 단일 열, 우연히 조금 큰 간격 하나뿐인 경우) 비율만으론 그
  // 사소한 간격도 항상 "최댓값의 100%"라 걸릴 수 있어 절대 하한이 필요하다.
  const gapThreshold = Math.max(maxGap * COLUMN_GAP_MAX_RATIO_HORIZONTAL, COLUMN_GAP_MIN_PX)

  const columns: T[][] = [[byLeft[0]!]]
  for (let i = 1; i < byLeft.length; i++) {
    if (gaps[i - 1]! > gapThreshold) columns.push([])
    columns[columns.length - 1]!.push(byLeft[i]!)
  }
  for (const column of columns) column.sort((a, b) => a.y - b.y) // 열 안에서는 위→아래

  if (process.env.DEBUG_OCR_DUMP) {
    console.log(
      `[ocrPaddle] clusterHorizontalLinesIntoColumns: ${lines.length}줄 → ${columns.length}열` +
        ` (maxGap=${maxGap.toFixed(1)}, threshold=${gapThreshold.toFixed(1)}), ` +
        columns.map((c) => `left=${Math.round(c[0]!.x)}(줄${c.length})`).join(', '),
    )
  }
  return columns.flat()
}

// 검출된 줄 bbox 를 여백 없이 그대로 크롭하면 글자 획이 경계에 살짝 걸려 잘리는 경우가
// 있다(실측 확인: 실제 페이지에서 폭 22~27px 짜리 좁은 줄 중 하나가 완전히 다른 글자로
// 오인식됐고, 특히 아주 짧은 줄 "だが。"(높이 56px, 글자 2개)는 "なっ"로 잘못 읽혔다).
// **줄 쌓임 방향(세로쓰기는 가로, 가로쓰기는 세로)** 여백은 0으로 둔다 — 실측해보니
// 3px만 줘도 세로쓰기 열끼리 간격이 좁은 곳(몇 px 밖에 안 되는 경우도 있음)에서 옆 열
// 글자 일부가 크롭에 섞여 들어와 오히려 다른 오류를 만들었다(레이피아→레레이피아처럼
// 옆 글자 중복/탈락, 문장 앞부분 잘림). **읽기 진행 방향**(세로쓰기는 세로, 가로쓰기는
// 가로)은 그 위험이 적어서(줄의 시작/끝 쪽은 보통 여백이 있음) 여백을 유지한다.
//
// 담당 A — 방향 인식 추가(2026-07-30, 사용자 제보 — "가로쓰기 줄 끝에 다른 줄의
// 일부분이 붙어서 나옴"). 원래 이 여백은 세로쓰기 전용으로 설계돼(위 주석 원문이
// "세로 여백"/"가로쓰기" 라는 표현을 그대로 썼었음) Y축(위/아래)에만 여백을 줬는데,
// 가로쓰기 줄은 방향이 90도 돌아가 있어 Y축이 오히려 "줄 쌓임 방향"(위/아래 인접 줄과
// 붙어 있는 방향, 줄간격이 좁으면 6px 여백이 옆 줄을 침범)이다 — 정확히 세로쓰기에서
// X축 여백을 0으로 둔 것과 같은 이유로 가로쓰기도 Y축 여백을 0으로 둬야 한다. 축만
// vertical 여부에 따라 바꾸고 로직/수치는 그대로.
const LINE_PADDING_ACROSS = 0 // 줄 쌓임 방향(인접 줄/열 오염 위험) — 항상 0
const LINE_PADDING_ALONG = 6 // 읽기 진행 방향(줄의 시작/끝) — 위험 적어 여백 유지

export function padLine(line: Rect, vertical: boolean): Rect {
  const paddingX = vertical ? LINE_PADDING_ACROSS : LINE_PADDING_ALONG
  const paddingY = vertical ? LINE_PADDING_ALONG : LINE_PADDING_ACROSS
  return {
    x: line.x - paddingX,
    y: line.y - paddingY,
    width: line.width + paddingX * 2,
    height: line.height + paddingY * 2,
  }
}

// 중국어 텍스트에서 아포스트로피(직선/곡선 둘 다)가 보이면 십중팔구 쉼표를 잘못 읽은
// 것이다 — recognizeOrderedLines 에서 zh-Hans/zh-Hant 텍스트에만 적용(주석은 그 호출부 참고).
const CHINESE_COMMA_MISREAD_RE = /['’]/g
export function fixChineseCommaMisread(text: string): string {
  return text.replace(CHINESE_COMMA_MISREAD_RE, '，')
}

// PaddleOCR 의 `text_word`가 주는 개별 bbox 크기는 못 믿는다 — 실측 확인 결과 글자
// 하나짜리 원시 단위도 が/を/で 같은 조사가 3~4px 높이로 잡히는 등 들쭉날쭉하고(모델
// CTC 디코딩 특성상 나온 결과일 뿐, 실제 글자 칸 크기가 아님), 여러 글자가 원시 단위
// 하나(bbox 하나)로 뭉쳐 오는 경우(예: "まさか、こんな" 7글자가 박스 하나)까지 겹치면
// 그 안에서 이 개별 bbox 들을 기준으로 아무리 추정해도 실제 글자 위치와 어긋났다
// (실사용 중 "박스 테두리가 글자 가운데 있음" 등으로 계속 확인됨).
//
// 대신 세로쓰기/가로쓰기 CJK 조판은 관례적으로 글자 한 칸이 전부 같은 크기인 균등
// 격자다(활자 조판 "몇 자 詰め" 관례) — 그래서 PaddleOCR 의 개별 bbox 크기는 전부
// 버리고, 이미 신뢰하는 줄 전체의 검출 범위(lineRect, detectLinesWithPaddle 결과)를
// 그 줄의 실제 글자 수로 균등 격자 분할해 각 글자 칸의 위치를 새로 만든다. 그 격자
// 위에 Sudachi/kuromoji 가 정한 단어 경계를 그대로 얹어 단어 박스(칸 여러 개를 이어붙인
// 사각형)를 만든다 — PaddleOCR 가 내부적으로 글자를 어떻게 뭉쳐서 줬는지는 완전히
// 무시되므로(텍스트만 가져다 씀) 뭉침 여부와 무관하게 항상 같은 방식으로 정확하다.
//
// vertical=true(세로쓰기, 위→아래로 읽음)면 높이를 글자 수로 나누고, false(가로쓰기,
// 왼→오로 읽음)면 폭을 나눈다 — 이 함수는 recognizeVerticalColumnWithPaddle(세로)와
// recognizeLinesWithPaddle(가로 폴백) 양쪽에서 공유해서 쓰이므로 방향을 인자로 받는다.
// 문장부호(、。 등)를 다른 글자보다 좁게(반각) 칠 가능성을 고려해봤는데, 실제 대상
// 문서에서는 문장부호도 전각(다른 글자와 같은 폭)으로 조판돼 있어 그냥 모든 글자를
// 동일 가중치(1칸)로 균등 분할한다.
//
// typicalCellSize 를 주면(estimateCellSizeFromIndent 로 구한, 이 컬럼 세트 전체의
// 들여쓰기 기반 기준값) 그걸 그대로 칸 크기로 쓰고, 없으면(그 기준값을 못 구한 경우)
// 이 줄 자신의 "검출 범위 ÷ 글자 수"로 되돌아간다 — 후자는 검출 모델이 글자 사이
// 여백까지 포함 안 하고 잉크에만 딱 맞게 범위를 잡는 경향이 있어(실측 확인) 실제 칸
// 크기보다 살짝 작게 나오고, 글자 위치가 누적합이라 줄 아래로 갈수록 그 작은 오차가
// 쌓여 어긋남이 커진다 — 페이지 전체에서 공통으로 구한 기준값을 쓰면 이 누적 오차가
// 없다.
// 세로쓰기 조판 관례(縦中横, tate-chū-yoko) — 아라비아 숫자가 정확히 2자리 연속으로
// 나오면(예: "16") 세로 두 칸이 아니라 가로로 나란히 눕혀서 한 칸에 압축해 넣는다(실측
// 확인: 레ベル 뒤의 "16"이 딱 한 글자 높이 안에 들어가 있음). 1자리나 3자리 이상인
// 숫자 연속, 숫자+기호 조합(예: "+5")은 압축 안 되고 그대로 한 칸씩 차지한다(실측
// 확인: "+5"는 "+"와 "5"가 각각 따로 한 칸씩). 이 압축을 안 셈에 넣으면 "16"을 2칸으로
// 쳐서 그 뒤 모든 글자 위치가 한 칸씩 밀린다(실사용 중 "그 다음 글자에 박스가 안 뜨고
// 밑에 밀림"으로 확인).
const DIGIT_RE = /[0-9]/

// 縦中横 숫자 압축과 정반대 케이스 — 원문의 다시(ダーシ, 대개 "――" 두 칸짜리 가로선)를
// 인식 엔진이 반각 한 글자로 뭉뚱그려 인식하는 경우가 실측 확인됐다(NDLOCR-Lite: U+2015
// HORIZONTAL BAR "―" 하나로 나옴 — 사용자 보고로 확인, 어떨 때는 "--"(하이픈 두 개,
// 이미 2글자라 별도 처리 불필요)로 나오기도 해서 인식 결과가 매번 일정하지 않다). 이런
// 글자 하나는 실제로는 2칸 높이를 차지하므로 가중치를 2로 잡아야 그 뒤 글자들의 위치가
// 안 밀린다 — 안 그러면 "16"을 2칸으로 잘못 세는 것의 반대 방향 오차(이번엔 실제보다
// 한 칸 적게 세어 뒤 글자들이 위로 밀림)가 난다. em dash(—, U+2014)도 같은 용도로
// 쓰이는 글자라 같이 묶는다 — 반대로 "ー"(가타카나 장음부호, U+30FC)는 진짜 장음부호로
// 쓰이는 정상적인 1칸짜리 용법이 훨씬 흔해서(포함시키면 그런 단어들이 다 밀림) 넣지
// 않는다.
const WIDE_DASH_CHARS = new Set(['―', '—'])

export function computeSlotWeights(codepoints: string[]): number[] {
  const weights = new Array(codepoints.length).fill(1)
  let i = 0
  while (i < codepoints.length) {
    // 개행(\n)은 ocrNdlocr.ts 가 문단 시작을 표시하려고 끼워 넣는 순수 텍스트 마커라
    // 실제 잉크(칸)를 하나도 안 차지한다 — 문단 들여쓰기는 이미 그 줄의 Y좌표 자체를
    // 1칸 내려서(alignColumnStarts) 반영해두는데, 여기서 \n 도 칸을 하나 차지하게 두면
    // 들여쓰기가 두 번(좌표 이동 + 이 슬롯) 적용돼 실제 글자가 2칸 밀려서 시작한다
    // (실측 확인). 폭 0으로 둬서 텍스트에는 남아있되(렌더러가 문단 구분에 씀) 위치
    // 계산에는 전혀 영향을 안 주게 한다.
    if (codepoints[i] === '\n') {
      weights[i] = 0
      i++
      continue
    }
    if (WIDE_DASH_CHARS.has(codepoints[i]!)) {
      weights[i] = 2
      i++
      continue
    }
    if (!DIGIT_RE.test(codepoints[i]!)) {
      i++
      continue
    }
    let j = i
    while (j < codepoints.length && DIGIT_RE.test(codepoints[j]!)) j++
    if (j - i === 2) {
      weights[i] = 0.5
      weights[i + 1] = 0.5
    }
    i = j
  }
  return weights
}

// 담당 A — 가로쓰기 단어 박스 위치 정확도 개선(2026-07-29, 사용자 지적). computeSlotWeights
// 는 세로쓰기 縦中横 관례(2자리 숫자만 압축)를 위해 만든 함수라 가로쓰기에 그대로 쓰면
// 안 맞는다 — 가로쓰기 일본어 조판에서 반각 숫자는 자릿수와 무관하게 항상 전각 글자의
// 절반 폭으로 렌더링되는 게 일반적 관례라(세로쓰기처럼 "2자리일 때만" 특별 취급하지
// 않음), 숫자는 항상 0.5 로 고정한다.
const HALF_WIDTH_DIGIT_WEIGHT = 0.5

// 문장부호(、。 등)는 줄 중간에 있을 때와 줄 맨 앞/끝에 있을 때 실제 렌더링 폭이 다르다
// — 관례상(行頭禁則: 줄 맨 앞에 못 오는 문장부호가 어쩔 수 없이 오면 앞 글자 쪽으로
// 붙여 좁게 그려짐, 줄 끝도 비슷하게 좁아지는 경우가 많음) 줄 양 끝(첫/마지막 글자)의
// 문장부호만 좁게 잡는다. 정확한 비율은 폰트·페이지마다 다를 수 있어(사용자 지적) 이
// 값은 "대체로 맞는" 기본값이다 — 그리드 모델 특성상 이 추정이 살짝 어긋나도 오차가
// 그 글자 하나에만 쏠리지 않고 줄 전체에 고르게 분산되므로 완전히 틀리진 않는다.
const LINE_EDGE_PUNCTUATION_RE = /[、。・！？…]/
const LINE_EDGE_PUNCTUATION_WEIGHT = 0.4

// 담당 A — 반각 ASCII 문장부호/공백 폭 보정 추가(2026-07-30, 사용자 제보 — "1. 科学边界"
// 처럼 반각 숫자+마침표+공백 접두어가 있는 줄에서 뒤이은 한자("科")의 시작 위치가 실제
// 잉크보다 한참 오른쪽으로 추정됨). 마침표(.)/공백은 전각 한자 한 칸보다 훨씬 좁게
// 찍히는데, 기존엔 줄 양 끝(첫/마지막 글자)의 CJK 문장부호(LINE_EDGE_PUNCTUATION_RE)만
// 좁게 잡고 반각 ASCII 문장부호/공백은 어디에 있든(줄 중간 포함) 그냥 전각 한 칸(1)으로
// 계산했다 — "1. " 같은 접두어의 실제 폭을 과대추정해서, 그 뒤에 오는 진짜 글자의 그리드
// 추정 시작 위치가 통째로 오른쪽으로 밀렸다(그 오차가 이후 잉크 스냅 검색 반경 밖까지
// 벗어나면 엉뚱한 잉크 경계에 스냅되는 2차 피해로 이어짐). 위치 무관하게(줄 어디에
// 있든) 항상 좁게 잡도록 별도 반각 전용 정규식/가중치를 추가.
const NARROW_ASCII_RE = /[\s.,;:!?'"()[\]{}\-]/
const NARROW_ASCII_WEIGHT = 0.4

/** computeSlotWeights 의 가로쓰기 버전 — 세로쓰기 전용 함수는 그대로 두고 별도로 둔다. */
export function computeSlotWeightsHorizontal(codepoints: string[]): number[] {
  const weights = new Array(codepoints.length).fill(1)
  const lastIndex = codepoints.length - 1
  for (let i = 0; i < codepoints.length; i++) {
    const ch = codepoints[i]!
    if (DIGIT_RE.test(ch)) {
      weights[i] = HALF_WIDTH_DIGIT_WEIGHT
      continue
    }
    if (NARROW_ASCII_RE.test(ch)) {
      weights[i] = NARROW_ASCII_WEIGHT
      continue
    }
    if ((i === 0 || i === lastIndex) && LINE_EDGE_PUNCTUATION_RE.test(ch)) {
      weights[i] = LINE_EDGE_PUNCTUATION_WEIGHT
    }
  }
  return weights
}

// 담당 A — 잉크 위치 기반 글자 경계 보정 실험(2026-07-29, 사용자 요청). 그리드 모델(균등
// 칸 폭 가정)이 추정한 글자 경계를, 실제 캡처 이미지에서 "잉크가 없는 열(글자 사이
// 빈 칸)"에 스냅해서 페이지별 폰트/자간 차이를 흡수해본다. hasInkInRegion(ocrNdlocr.ts)
// 과 같은 원리(그 영역 안 최댓값을 배경으로 보고, 그보다 DARK_DELTA 이상 어두우면 잉크로
// 판정)를 열 단위로 확장한 것 — 가로쓰기 전용(세로쓰기는 손 안 댐), 못 찾으면(빈 칸이
// 뚜렷하지 않으면) 그리드 추정 위치를 그대로 쓰는 안전한 폴백이다.
const INK_GAP_DARK_DELTA = 40

/** lineRect 크롭 안에서 각 x열(1px 폭)의 "잉크 진하기"(그 열 안 최대 어둠, 0=배경)를 구한다. */
function computeColumnDarkness(image: Buffer, lineRect: Rect): Float64Array | null {
  const x = Math.max(0, Math.round(lineRect.x))
  const y = Math.max(0, Math.round(lineRect.y))
  const width = Math.max(1, Math.round(lineRect.width))
  const height = Math.max(1, Math.round(lineRect.height))
  const bitmap = nativeImage.createFromBuffer(image).crop({ x, y, width, height }).toBitmap()
  if (bitmap.length < width * height * 4) return null
  // BGRA 4바이트당 1픽셀(Electron NativeImage.toBitmap 포맷, computeInkFraction 과 동일).
  const lum = new Float64Array(width * height)
  let maxBrightness = 0
  for (let i = 0, p = 0; i < bitmap.length; i += 4, p++) {
    const b = bitmap[i]!
    const g = bitmap[i + 1]!
    const r = bitmap[i + 2]!
    const l = (r * 299 + g * 587 + b * 114) / 1000
    lum[p] = l
    if (l > maxBrightness) maxBrightness = l
  }
  const darkness = new Float64Array(width)
  for (let col = 0; col < width; col++) {
    let colMax = 0
    for (let row = 0; row < height; row++) {
      const d = maxBrightness - lum[row * width + col]!
      if (d > colMax) colMax = d
    }
    darkness[col] = colMax
  }
  return darkness
}

/** x 주변 ±radius 안에서 가장 밝은(잉크 없는) 열을 찾아 그 위치로 스냅한다. 그 범위 안에
 * 뚜렷한 빈 칸이 없으면(가장 어둡지 않은 열조차 INK_GAP_DARK_DELTA 이상 어두우면) 원래
 * 위치를 그대로 반환한다 — 글자끼리 붙어 있거나 후리가나 잔여물 등으로 오탐지될 여지를
 * 줄이기 위한 보수적 기준. */
function snapToInkGap(darkness: Float64Array, x: number, radius: number): number {
  const lo = Math.max(0, Math.round(x - radius))
  const hi = Math.min(darkness.length - 1, Math.round(x + radius))
  let bestCol = -1
  let bestVal = Infinity
  for (let col = lo; col <= hi; col++) {
    const v = darkness[col]!
    if (v < bestVal) {
      bestVal = v
      bestCol = col
    }
  }
  if (bestCol === -1 || bestVal >= INK_GAP_DARK_DELTA) return x
  return bestCol
}

// 담당 A — 잉크 경계 스냅 정밀화(2026-07-29, 사용자 지적: "문장부호와 다음 문자 사이
// 공백이 박스 안에 포함됨"). snapToInkGap(가장 밝은 열로 스냅)은 문장부호처럼 글자
// 자신의 칸보다 잉크가 훨씬 좁게 그려지는 경우, 그 문장부호 칸과 다음 글자 사이의 넓은
// 빈 공간 "한가운데"로 스냅해버려서 다음 단어 박스 왼쪽에 그 공백이 그대로 딸려 들어간다.
// 대신 "그 단어가 실제로 시작/끝나는 잉크 경계"를 방향을 정해 찾는다 — 단어 시작
// 경계는 오른쪽으로 훑어 공백→잉크로 바뀌는 첫 지점을, 단어 끝 경계는 왼쪽으로 훑어
// 잉크→공백으로 바뀌는 지점을 찾는다. 앞뒤 단어가 붙어 있어(gap 문자가 사이에 없어)
// 경계 하나가 동시에 "끝"이자 "시작"인 경우는 방향을 정할 수 없으므로 기존 snapToInkGap
// (가운데로) 을 그대로 쓴다.
function findInkEdge(darkness: Float64Array, x: number, radius: number, direction: 'start' | 'end'): number {
  const lo = Math.max(0, Math.round(x - radius))
  const hi = Math.min(darkness.length - 1, Math.round(x + radius))
  const isInk = (col: number) => darkness[col]! >= INK_GAP_DARK_DELTA
  if (direction === 'start') {
    for (let col = lo; col <= hi; col++) {
      if (isInk(col) && (col === 0 || !isInk(col - 1))) return col
    }
    return x
  }
  for (let col = hi; col >= lo; col--) {
    if (isInk(col) && (col === darkness.length - 1 || !isInk(col + 1))) return col + 1
  }
  return x
}

// 문장부호(、。 등)와 숫자는 형태소 분석기가 앞뒤 단어와 한 토큰으로 묶어버리는 경우가
// 있다(사용자 지적: "숫자, 문장부호가 박스에 포함됨") — segmentJapaneseWords/
// segmentChineseWords 는 "일본어(한자/가나) 글자가 하나라도 있으면" 토큰을 통과시키므로,
// 그 토큰의 앞/뒤에 숫자·문장부호가 붙어 있어도 그대로 살아남는다. 실제 클릭 대상은
// 그 글자들이 아니므로, 토큰 경계의 양 끝에서 숫자·문장부호만 잘라내고 나머지는(전부
// 잘려나가면 토큰 자체를 버려서) 기존 gap-문자 처리로 넘긴다.
const WORD_EDGE_TRIM_RE = /[0-9、。・！？…「」『』（）()]/

export async function groupCjkCharsGrid(
  lineRect: Rect,
  text: string,
  language: 'ja' | 'zh-Hans' | 'zh-Hant',
  vertical: boolean,
  typicalCellSize: number | null,
  // 담당 A — 잉크 위치 기반 경계 보정용(2026-07-29). 가로쓰기 호출부만 원본 캡처
  // 이미지를 넘긴다 — 세로쓰기 호출부는 생략(null)해서 기존 그리드 계산 그대로 둔다.
  image: Buffer | null = null,
): Promise<Word[]> {
  const codepoints = [...text]
  if (codepoints.length === 0) return []
  const rawBoundaries = [
    ...(language === 'ja' ? await segmentJapaneseWords(text) : await segmentChineseWords(text, language)),
  ].sort((a, b) => a.start - b.start)
  // 가로쓰기에서만 트리밍한다(세로쓰기는 손 안 댐) — 위 WORD_EDGE_TRIM_RE 주석 참고.
  const boundaries = vertical
    ? rawBoundaries
    : rawBoundaries
        .map((b) => {
          let start = b.start
          let end = b.end
          while (start < end && WORD_EDGE_TRIM_RE.test(codepoints[start]!)) start++
          while (end > start && WORD_EDGE_TRIM_RE.test(codepoints[end - 1]!)) end--
          return { text: codepoints.slice(start, end).join(''), start, end }
        })
        .filter((b) => b.start < b.end)
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `grid-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
      JSON.stringify({ text, language, boundariesCount: boundaries.length, boundaries }, null, 2),
    )
  }
  const weights = vertical ? computeSlotWeights(codepoints) : computeSlotWeightsHorizontal(codepoints)
  const cumulative: number[] = [0]
  for (const w of weights) cumulative.push(cumulative[cumulative.length - 1]! + w)
  const totalWeight = cumulative[cumulative.length - 1]!
  // typicalCellSize 가 없어서(null) 이 줄 자신의 검출 범위 ÷ 칸 수로 칸 크기를 역산할
  // 때만 해당 — 줄 끝이 문장부호(、。 등)면 잉크 자체가 작아서 검출 높이(lineRect.height/
  // width)가 그 칸만큼 다 안 나온다(실측 확인, cellSizesFromLongLines 의 같은 필터
  // 참고). 다른 줄과 비교하는 계산이 아니라 이 줄 안에서만 닫힌 계산이라 보정 안 해도
  // 겹치거나 어긋나진 않지만(전체가 고르게 살짝 눌릴 뿐), 정밀도를 위해 마지막 글자의
  // 칸 가중치를 줄여서(검출 높이는 그대로 두고) 칸 크기를 살짝 더 크게 추정한다.
  // 완전히 0(칸 가중치 통째로 제외)이 아니라 작은 값(TRAILING_PUNCTUATION_WEIGHT)으로
  // 낮춘다 — 문장부호도 잉크가 아예 없는 건 아니라 어느 정도는 실제로 칸을 차지하므로
  // (사용자 지적), 완전 제외보다 실측에 더 가깝다. 이 블록은 세로쓰기(computeSlotWeights)
  // 에만 실질적으로 작동한다 — 가로쓰기(computeSlotWeightsHorizontal)는 이미 줄 끝
  // 문장부호의 weights[last] 자체를 LINE_EDGE_PUNCTUATION_WEIGHT(동일한 0.4)로 낮춰서
  // 계산하므로 아래 `lastWeight > TRAILING_PUNCTUATION_WEIGHT` 조건이 자연히 false 가
  // 돼 중복 보정되지 않는다.
  const TRAILING_PUNCTUATION_RE = /[、。・！？…]$/
  const TRAILING_PUNCTUATION_WEIGHT = 0.4
  const lastWeight = weights.length > 0 ? weights[weights.length - 1]! : 0
  const totalWeightForCellSize =
    typicalCellSize === null &&
    lastWeight > TRAILING_PUNCTUATION_WEIGHT &&
    TRAILING_PUNCTUATION_RE.test(text)
      ? totalWeight - lastWeight + TRAILING_PUNCTUATION_WEIGHT
      : totalWeight
  const cellSize =
    typicalCellSize ?? (vertical ? lineRect.height : lineRect.width) / totalWeightForCellSize

  // 그리드 추정 위치(균등 칸 폭 가정)가 기본값이다 — 가로쓰기 + 원본 이미지가 있으면
  // 각 글자 경계를 실제 잉크 없는 열로 스냅해서 폰트/자간에 따른 오차를 줄인다(양 끝
  // 경계는 이미 검출기가 준 줄 범위 자체라 손 안 댐).
  let positions = cumulative.map((c) => c * cellSize)
  if (!vertical && image) {
    const darkness = computeColumnDarkness(image, lineRect)
    if (darkness) {
      // 경계가 어떤 단어의 "시작"인지 "끝"인지에 따라 스냅 방향을 다르게 잡는다(위
      // findInkEdge 주석 참고) — 둘 다 해당하면(사이에 gap 문자 없이 단어끼리 붙어 있음)
      // 방향을 정할 수 없으니 기존 가운데-스냅으로 처리한다.
      const startIdx = new Set(boundaries.map((b) => b.start))
      const endIdx = new Set(boundaries.map((b) => b.end))
      const midRadius = cellSize * 0.4
      const edgeRadius = cellSize * 0.9
      positions = positions.map((p, i) => {
        if (i === 0 || i === positions.length - 1) return p
        const isStart = startIdx.has(i)
        const isEnd = endIdx.has(i)
        if (isStart && !isEnd) return findInkEdge(darkness, p, edgeRadius, 'start')
        if (isEnd && !isStart) return findInkEdge(darkness, p, edgeRadius, 'end')
        if (isStart && isEnd) return snapToInkGap(darkness, p, midRadius)
        return p
      })
      // 스냅이 이웃 경계를 앞지르지 않게(글자 순서가 뒤집히지 않게) 단조 증가를 보장한다.
      for (let i = 1; i < positions.length; i++) {
        if (positions[i]! < positions[i - 1]!) positions[i] = positions[i - 1]!
      }
    }
  }

  const words: Word[] = []
  let pos = 0
  // boundaries 가 비운 구간(문장부호 등 형태소 분석기가 걸러낸 글자)은 원문 보존을 위해
  // 텍스트만 그대로 끼워 넣는다 — bbox 는 안 준다(클릭 가능한 "단어"가 아니므로 오버레이에
  // 박스가 뜨거나 클릭되면 안 된다, 실사용 중 "쉼표에 박스 생김"으로 확인).
  const pushGapChars = (end: number) => {
    for (; pos < end; pos++) words.push({ text: codepoints[pos]! })
  }
  for (const b of boundaries) {
    pushGapChars(b.start)
    const start = positions[b.start]!
    const span = positions[b.end]! - start
    words.push({
      text: b.text,
      bbox: vertical
        ? { x: lineRect.x, y: lineRect.y + start, width: lineRect.width, height: span }
        : { x: lineRect.x + start, y: lineRect.y, width: span, height: lineRect.height },
    })
    pos = b.end
  }
  pushGapChars(codepoints.length)
  return words
}

/** 줄 목록을 정해진 순서 그대로 병렬 인식해 이어붙인다 — 실패한 줄이 하나라도 있으면
 * 전체를 null 로 반환해 호출부가 Tesseract 로 통째 폴백하게 한다. zh/ja 는 PaddleOCR 의
 * 인식 텍스트만 가져다 쓰고(bbox 는 안 믿음) `groupCjkCharsGrid`로 줄 자체의 검출 범위를
 * 격자 분할해 단어 박스를 다시 만든다(위 주석 참고) — 이 함수의 호출부
 * (recognizeVerticalColumnWithPaddle/recognizeLinesWithPaddle)는 전부 zh/ja 전용이라
 * language 는 항상 이 셋 중 하나다. */
async function recognizeOrderedLines(
  image: Buffer,
  language: Language,
  orderedLines: Rect[],
  vertical: boolean,
  recModel?: string,
): Promise<Word[] | null> {
  const recStart = Date.now()
  // 담당 A — 줄별 개별 소요시간 기록(2026-07-30, 사용자 제보 — 세로쓰기 다단 캡처가
  // 전체적으로 너무 오래 걸리는 것 아니냐는 의심). 워커 풀(POOL_SIZE, 대기줄이 큐잉되는
  // 구조)을 통과하는 호출이라 이 개별 시간엔 실제 인식 시간뿐 아니라 풀 대기 시간도
  // 섞여 있다 — 총 소요시간을 풀 크기로 단순히 나눈 값과 실측 개별 시간 분포를 비교해
  // "풀이 부족해서 느린 것"인지 "호출 자체가 원래 느린 것"인지 구분하는 데 쓴다.
  const perLineTimings: number[] = []
  const perLine = await Promise.all(
    orderedLines.map(async (line) => {
      const lineStart = Date.now()
      try {
        return await recognizeWithPaddle(image, language, padLine(line, vertical), recModel)
      } finally {
        perLineTimings.push(Date.now() - lineStart)
      }
    }),
  )
  const sortedTimings = [...perLineTimings].sort((a, b) => a - b)
  console.log(
    `[timing]     줄별 인식(recognizeWithPaddle, ${orderedLines.length}줄 병렬): ${Date.now() - recStart}ms` +
      ` (개별 min=${sortedTimings[0]}ms max=${sortedTimings[sortedTimings.length - 1]}ms` +
      ` median=${sortedTimings[Math.floor(sortedTimings.length / 2)]}ms, POOL_SIZE=${defaultPoolSize()})`,
  )
  if (perLine.some((words) => !words)) return null
  // 단어 단위가 아니라 줄 단위로 hover/선택하기로 한 결정(2026-07-28)은 세로쓰기 일본어
  // (NDLOCR-Lite, ocrNdlocr.ts)에만 남기고 되돌렸다(2026-07-29 재요청) — PaddleOCR 경로는
  // lineId 를 안 붙여 wordMapping.ts findLineWordsAtPoint 가 단어 단위로 폴백하게 둔다.
  if (language !== 'ja' && language !== 'zh-Hans' && language !== 'zh-Hant') {
    return perLine.flatMap((words) => words!)
  }
  const rawTexts = perLine.map((words) => words!.map((w) => w.text).join(''))
  // 담당 A — 중국어 쉼표↔아포스트로피 오인식 교정(2026-07-30, 사용자 제보 — "쉼표가 '로
  // 인식됨"). PaddleOCR 인식 모델(PP-OCRv6)이 콤마와 아포스트로피를 종종 헷갈린다(둘 다
  // 작은 곡선 하나짜리 글자라 저해상도에서 구분이 어려움) — `KANJI_LATIN_CONFUSION`(위,
  // ocrNdlocr.ts)과 같은 패턴으로, 중국어 텍스트에서는 아포스트로피가 원래 나올 일이
  // 거의 없으므로(따옴표는 「」/『』/‘’ 등 다른 문자를 씀) `'`/`'`를 보면 그냥 쉼표로
  // 교정한다. 일본어/영어는 대상이 아님(영어는 it's/don't 같은 진짜 아포스트로피가 흔해
  // 문맥 없이 이 방식을 쓰면 위험함) — zh-Hans/zh-Hant 에서만 적용.
  const texts =
    language === 'zh-Hans' || language === 'zh-Hant' ? rawTexts.map(fixChineseCommaMisread) : rawTexts
  // 세로쓰기에서만 대시(―) 보정을 시도한다 — 가로쓰기 폴백 경로는 이 문제 대상이 아니다.
  const markStart = Date.now()
  const { texts: finalTexts, typicalCellSize } = vertical
    ? await insertUndetectedMarks(
        orderedLines,
        perLine.map((w) => w!),
        texts,
        language === 'zh-Hans' || language === 'zh-Hant' ? UNKNOWN_GAP_PLACEHOLDER_ZH : UNKNOWN_GAP_PLACEHOLDER,
      )
    : { texts, typicalCellSize: null }
  if (vertical) {
    console.log(`[timing]     미검출 구간 보정(insertUndetectedMarks): ${Date.now() - markStart}ms`)
  }
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    // 담당 A — 두 페이지(견본) 세로쓰기 읽기 순서 검증용(2026-07-30, 사용자 요청 —
    // "선택 영역이 두 페이지/두 단일 때도 제대로 읽는지" 검증 전 실제 데이터 확인).
    // 세로쓰기는 지금 DocLayout 블록 경계를 안 믿고 영역 전체를 x좌표로만 클러스터링해서
    // (clusterVerticalLinesIntoColumns) 오른쪽→왼쪽 순서를 정하는데, 이 방식이 "페이지
    // 사이 간격"도 "그냥 다른 열"로 정확히 갈라주기만 하면 별도 페이지 인식 로직 없이도
    // 이미 올바른 순서(오른쪽 페이지 전체 → 왼쪽 페이지 전체)가 나올 것으로 예상된다 —
    // 다만 실제로 그런지, 페이지 사이 간격이 일반 열 간격보다 충분히 넓게 검출되는지는
    // 실측 확인이 필요하다. 인접한 두 열의 중심 간격과, 그 간격이 전체 간격들의 중앙값
    // 대비 몇 배인지를 같이 남겨서 — 이 배율이 유난히 큰 지점(페이지 경계 후보)이 실제
    // 페이지가 바뀌는 자리와 일치하는지 눈으로 바로 확인할 수 있게 한다.
    const centers = orderedLines.map((l) => l.x + l.width / 2)
    const gaps = centers.slice(1).map((c, i) => Math.abs(centers[i]! - c))
    const medianGap = gaps.length > 0 ? median(gaps) : 0
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `texts-${Date.now()}.json`),
      JSON.stringify(
        orderedLines.map((line, i) => {
          const center = line.x + line.width / 2
          const gapToPrev = i > 0 ? Math.abs(centers[i - 1]! - center) : null
          return {
            x: line.x,
            width: line.width,
            // 담당 A — 열 순서 디버깅용(2026-07-30, 사용자 제보). 이 배열의 순서 자체가
            // clusterVerticalLinesIntoColumns 가 최종 확정한 읽기 순서라, center 값을
            // 순서대로 눈으로 훑어보면 어느 지점에서 순서가 튀는지(예: A C B 처럼 갑자기
            // 커졌다 작아지는 지점) 바로 보인다.
            center,
            gapToPrev,
            gapRatioToMedian: gapToPrev !== null && medianGap > 0 ? gapToPrev / medianGap : null,
            before: texts[i],
            after: finalTexts[i],
            changed: texts[i] !== finalTexts[i],
          }
        }),
        null,
        2,
      ),
    )
  }
  const gridStart = Date.now()
  const grouped = await Promise.all(
    orderedLines.map(async (line, i) => {
      // 담당 A — 잉크 스냅 재활성화(2026-07-30, 재수정). 한 번 껐다가(반각 ASCII
      // 문장부호/공백 가중치 버그 — "科"의 그리드 추정 시작 위치 자체가 크게 틀려서
      // 잉크 스냅 검색 반경 밖 엉뚱한 경계에 스냅됐던 것) 다시 켜보니 그 줄은 살짝
      // 나아졌지만 오히려 다른 여러 줄의 박스가 짧아지는 회귀가 생겼다(사용자 확인) —
      // 잉크 스냅이 대부분의 정상 줄에서는 그리드 추정치를 실제 잉크에 맞춰 보정해주는
      // 순기능이 있었던 것으로 보임. 근본 원인(위 NARROW_ASCII_RE/NARROW_ASCII_WEIGHT)을
      // 고쳤으니 "科"의 그리드 추정 자체가 훨씬 정확해져 잉크 스냅이 엉뚱한 경계에
      // 걸릴 가능성도 같이 줄었을 것으로 보고 다시 켠다.
      const words = await groupCjkCharsGrid(line, finalTexts[i]!, language, vertical, typicalCellSize, vertical ? null : image)
      // 담당 A — 가로쓰기 단어 단위 hover 를 시도했었는데(2026-07-29), 잉크 위치 기반
      // 박스 계산이 아직 튜닝 중이라 우선 세로쓰기와 동일하게 줄 단위로 되돌린다(사용자
      // 요청, 2026-07-29) — 단어별 위치 계산(groupCjkCharsGrid, 잉크 스냅 포함) 자체는
      // 그대로 두고, 그 결과를 한 줄로 묶어 hover/선택만 줄 단위로 쓴다. 나중에 잉크
      // 튜닝이 끝나면 이 lineId 부여만 다시 빼면 단어 단위로 복귀 가능.
      const lineId = Math.random().toString(36).slice(2)
      return words.map((w) => ({ ...w, lineId }))
    }),
  )
  console.log(`[timing]     격자 분할(groupCjkCharsGrid, ${orderedLines.length}줄): ${Date.now() - gridStart}ms`)
  // 담당 A — 줄(가로쓰기)/열(세로쓰기) 경계마다 '\n' 마커를 끼워 넣는다. 세로쓰기는
  // 2026-07-29 사용자 요청으로 먼저 추가됐었고, 가로쓰기도 2026-07-30 같은 문제가 확인돼
  // 뒤늦게 통일했다 — 가로쓰기 OCR 결과도 원래 줄 사이에 '\n'이 전혀 없어서(zh/ja 는
  // 띄어쓰기 없는 문자 체계라 그냥 이어붙임), 페이지 전체가 '\n' 하나 없는 거대 단일
  // 문자열이 됐다. 그 상태에서 팝업의 1차 문맥 표시 범위(popup/selection.ts:
  // computeLineContextRange, '\n' 기준 앞뒤 2줄)가 "줄이 하나뿐"으로 보여 무조건 텍스트
  // 전체를 문맥 범위로 반환해버렸다(실사용 제보 — 다른 텍스트 박스를 선택했는데 팝업에
  // 엉뚱한 다른 줄이 선택된 것처럼 보임. 세로쓰기가 먼저 겪었던 "본문이 비어있는 팝업"과
  // 근본 원인이 같음). NDLOCR 경로의 문단 마커와 같은 방식(bbox 없는 순수 텍스트 Word —
  // hover/클릭 대상 아님, lineId 도 없어 findLineSpan 그룹 확장도 여기서 자연히 끊김)
  // 이라 `text = words.join('')` 불변조건이 그대로 유지된다. 빈 줄(인식 결과 없음) 앞뒤로는
  // 마커를 겹쳐 넣지 않는다('\n\n' 방지).
  const flat: Word[] = []
  for (const words of grouped) {
    if (words.length === 0) continue
    if (flat.length > 0) flat.push({ text: '\n' })
    flat.push(...words)
  }
  return flat
}

export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * "글자 하나당 실제 크기"(typicalCellSize)를 세로쓰기 관례(문단/대사 시작 컬럼만 한 칸
 * 들여쓰기)를 이용해 구한다 — 컬럼별 (검출 범위 ÷ 인식된 글자 수)의 중앙값을 쓰던
 * 이전 방식은 인식이 실패한 컬럼(글자 수 자체가 틀림, 예: "有" 한 글자로 뭉개진 경우)
 * 이 섞이면 기준값 자체가 오염됐다(실사용 중 확인). 컬럼의 "위쪽 시작 y좌표"는 인식
 * 품질과 무관한 순수 검출 정보라 훨씬 깨끗하다 — 대부분 컬럼이 공유하는 기준선(baseline,
 * 가장 많이 겹치는 y좌표)을 찾고, 그보다 뚜렷이 아래에서 시작하는(들여쓰기된) 컬럼들의
 * 차이값이 곧 글자 하나의 높이다. 들여쓰기된 컬럼이 하나도 없으면(전부 기준선에서
 * 시작) 이전 방식(글자 수 기반)으로 되돌아간다.
 */
// 후리가나 잔재 등 짧은 조각 줄은 본문 컬럼과 무관한 y좌표에 떠 있어(실측 확인: 이런
// 조각들 때문에 기준선 계산이 엉뚱한 값으로 튐 — 77px 같은 비정상적인 "글자 하나 높이"가
// 나온 사례). 본문 컬럼만 골라 쓰기 위한 최소 높이 기준.
// ocrYomitoku.ts 도 같은 필터(짧은 잡음 줄 제외 후 기준선 계산)를 재사용한다.
export const MIN_BODY_LINE_HEIGHT = 100

/**
 * 여러 컬럼(줄)이 공유하는 "기준선"(들여쓰기 없는 문단/컬럼들의 공통 시작 y좌표) —
 * ocrYomitoku.ts 도 같은 개념(대시 미검출로 줄이 기준선보다 아래서 시작하는지 판정)이
 * 필요해서 분리해 export 한다. 최빈값 기준이라 후리가나 등 잡음이 섞여도(MIN_BODY_LINE_HEIGHT
 * 로 이미 걸렀다는 전제 하에) 안정적이다.
 */
export function computeBaseline(bodyLines: Rect[]): number | null {
  if (bodyLines.length < 2) return null
  const rounded = bodyLines.map((l) => Math.round(l.y / 5) * 5)
  const counts = new Map<number, number>()
  for (const y of rounded) counts.set(y, (counts.get(y) ?? 0) + 1)
  let baseline = rounded[0]!
  let bestCount = 0
  for (const [y, c] of counts) {
    // 동점이면 더 작은 y(=들여쓰기 없는 "기준" 쪽일 가능성이 더 큼)를 우선한다.
    if (c > bestCount || (c === bestCount && y < baseline)) {
      bestCount = c
      baseline = y
    }
  }
  return baseline
}

export function estimateCellSizeFromIndent(lines: Rect[]): number | null {
  const bodyLines = lines.filter((l) => l.height >= MIN_BODY_LINE_HEIGHT)
  const baseline = computeBaseline(bodyLines)
  if (baseline === null) return null
  const diffs = bodyLines.map((l) => l.y - baseline).filter((d) => d > 5)
  if (diffs.length === 0) return null
  // 평균을 실제로 테스트해보니(직접 확인) diff 값들이 뚜렷이 다른 두 무리로 갈렸다 —
  // 진짜 "문단 들여쓰기 1칸"(17~22 근방)과, 대시 등 미검출 구간 때문에 훨씬 더 밀린
  // 열(50~53 근방, 3칸 가까이)이 섞여 있어서 평균을 내면 어느 쪽도 아닌 애매한 값
  // (예: 1칸도 3칸도 아닌 1.7칸어치)이 나왔다. 최빈값(2px 단위로 반올림해 가장 많이
  // 겹치는 값)을 쓰면 이런 소수의 이상치 무리에 안 끌려가고 실제로 더 많이 나타나는
  // "진짜" 들여쓰기 값을 그대로 찾아낸다.
  const roundedDiffs = diffs.map((d) => Math.round(d / 2) * 2)
  const diffCounts = new Map<number, number>()
  for (const d of roundedDiffs) diffCounts.set(d, (diffCounts.get(d) ?? 0) + 1)
  let best = roundedDiffs[0]!
  let bestDiffCount = 0
  for (const [d, c] of diffCounts) {
    if (c > bestDiffCount) {
      bestDiffCount = c
      best = d
    }
  }
  return best
}

// 미검출/미식별 구간(대시 외에도 종류가 다양함 — 물결표, 각종 강조 기호 등)을 표시할
// 때 쓰는 공통 자리표자. 처음엔 "―"(대시)로 단정하고 채웠는데, 실사용 중 세로쓰기에서
// 몇 칸을 차지하는 기호 종류가 대시 말고도 여러 가지 있고 그때마다 어떤 기호인지
// 정확히 맞히는 게 오히려 오류를 늘린다는 게 확인돼서(사용자 판단) — 정확한 기호를
// 추정하려 들지 않고 "여기 뭔가 있었는데 못 읽었다"는 사실만 통일된 표시(게타 마크,
// 일본어 문헌에서 미판독 글자를 표시하는 관례)로 팝업 본문에 남긴다.
export const UNKNOWN_GAP_PLACEHOLDER = '〓'
// 담당 A — 중국어 전용 자리표자(2026-07-30, 사용자 요청) — 게타 마크(〓)는 일본
// 문헌에서 미판독 글자를 표시하는 관례라 중국어에는 안 맞는다는 지적. 중국어 쪽 관례인
// 흰 사각형(□, "허결호"/虚缺号)으로 대신 표시 — ocrNdlocr.ts(일본어 전용, NDLOCR-Lite)는
// 이 상수를 안 쓰고 위 UNKNOWN_GAP_PLACEHOLDER 를 그대로 쓰므로 영향 없음.
export const UNKNOWN_GAP_PLACEHOLDER_ZH = '□'

/**
 * 세로쓰기 일본어 소설에서 문장 시작/전환에 쓰이는 대시(―)나 그 밖의 몇 칸짜리 기호는
 * 획이 단순해서 텍스트 검출 모델이 아예 텍스트로 못 잡는 경우가 많다(실측 확인) —
 * detectLinesWithPaddle 이 잡은 줄 범위(line)가 이런 미검출 여백을 포함하고 있으면,
 * 그 범위를 인식된 글자 수만큼 나눠 칸을 만들 때(groupCjkCharsGrid) 분모에 안 들어간
 * 여백만큼 칸이 커져서 뒤 글자들 위치가 전부 계통적으로 밀린다(실사용 중 확인) — 이런
 * 미검출 구간이 줄 맨 앞뿐 아니라 중간·끝에 오는 경우도 실제로 확인됨.
 *
 * 이미지 픽셀 모양(얇고 긴 직선인지)으로 판별하는 방식을 먼저 시도했는데, 실측 확인
 * 결과 진짜 글자의 잉크가 우연히 얇게 잡히는 경우와 구분이 잘 안 돼 오탐이 잦았다.
 * 대신 **PaddleOCR 가 실제로 인식해낸 글자(원시 단위)들 사이의 y 간격**을 직접 비교한다
 * — 원시 단위 하나하나의 정확한 크기는 못 믿어도(실측 확인), 두 원시 단위 사이에 기준
 * 칸 크기(typicalCellSize)의 약 2배에 달하는 빈틈이 있다는 건 훨씬 큰 신호라 믿을 만하다.
 * 이런 간격이 줄 맨 앞(줄 시작~첫 원시 단위), 중간(원시 단위끼리), 맨 끝(마지막 원시
 * 단위~줄 끝) 어디에 있든 같은 방식으로 잡아낸다. 간격 크기(기준 칸 크기의 몇 배인지
 * 반올림)만큼 UNKNOWN_GAP_PLACEHOLDER 를 텍스트에 끼워 넣고, 그 뒤로는 원래 인식된
 * 글자를 순서대로 이어 붙인다 — 이러면 이후 groupCjkCharsGrid 가 "줄 범위 ÷ 글자 수
 * (자리표자 포함)"로 나눠도 미검출 구간이 어디에 있었든 정확한 자리에 놓인다(줄 범위
 * 자체는 안 건드리므로 별도 좌표 보정이 필요 없음). 정확히 어떤 기호였는지는 추정하지
 * 않는다 — 위 UNKNOWN_GAP_PLACEHOLDER 주석 참고.
 *
 * 간격이 기준 칸 크기의 1.5배 미만이면(원시 단위 사이의 정상적인 여백 수준) 무시한다 —
 * PaddleOCR 인식 실패로 여러 글자가 통째로 빠진 경우(실측 확인된 별개 문제, 예: 10글자
 * 넘는 내용이 "有" 한 글자로 뭉개짐)는 보통 원시 단위 자체가 그 넓은 범위를 통째로
 * 차지해버려서(그 하나의 원시 단위 bbox 가 비정상적으로 큼) 단위 "사이"의 간격으로는
 * 안 나타나므로 이 방식에서 자연히 걸러진다.
 */
// ocrYomitoku.ts 도 같은 배율(줄 시작이 기준선보다 1.5~3칸 아래면 미검출 구간으로 판단,
// 딱 1칸이면 문단 들여쓰기 관례로 판단)을 재사용한다 — 판정 자체의 근거(몇 칸짜리
// 기호는 육안상 다른 글자보다 넓은 공백을 차지)는 인식 엔진이 바뀌어도 동일하다.
// 담당 A — 1.5 → 0.6 로 하향(2026-07-30, 실측 확인 — 사용자 제보 "문장 중간 마침표/
// 쉼표가 인식이 안 돼서 텍스트 박스 길이에 영향을 줌"). 문제였던 실제 페이지에서
// `insertGapPlaceholdersForLine`의 모든 인접 간격 비율(gap/typicalCellSize)을 그대로
// 찍어보니(DEBUG_OCR_DUMP), 정상적인 글자-글자 사이 간격은 전부 -0.3~+0.33 범위에
// 몰려 있었고, 마침표/쉼표 하나가 통째로 빠졌다고 의심되는 자리들만 0.72~0.96 로
// 뚜렷하게 떨어져 있었다(예: "…人總…" 사이가 0.9569 — 거의 정확히 글자 한 칸). 1.5는
// 이 둘 사이 어디에도 안 걸리는(둘 다 통과 못 함) 너무 높은 값이었던 것 — 그 빈틈
// 한가운데인 0.6으로 낮추면 정상 간격은 안 건드리면서 이런 누락은 잡아낸다.
export const GAP_RATIO_THRESHOLD = 0.6
// 이 배율을 넘는 간격은 기호가 아니라 PaddleOCR 인식 실패(여러 글자가 통째로 안 잡힘,
// 실측 확인된 별개 문제 — 예: 10글자 넘는 내용이 "有" 한 글자로 뭉개짐)로 본다 — 이런
// 경우까지 전부 자리표자로 채우면 이미 망가진 인식 결과를 더 이상하게 만든다.
export const MAX_GAP_RATIO = 3

/**
 * 줄 하나에 대해, PaddleOCR 가 실제로 인식해낸 글자(원시 단위, bbox 있는 것만)들 사이의
 * y 간격을 기준 칸 크기(typicalCellSize)와 비교해 미검출 구간(기호 등)을 찾고, 그 자리에
 * UNKNOWN_GAP_PLACEHOLDER 를 끼워 넣은 텍스트를 반환한다 — insertUndetectedMarks(여러 줄을
 * 한 번에 처리)의 단일 줄 버전. ocrYomitoku.ts/ocrNdlocr.ts 처럼 인식 백엔드가 줄 전체
 * bbox 만 주고 글자 단위 좌표가 없는 경우, 의심되는 줄만 PaddleOCR 로 다시 인식해(글자
 * 단위 좌표를 얻어) 이 함수로 정확한 위치를 찾는 데 쓴다.
 *
 * paddingBias: ocrNdlocr.ts 실측 확인 — 、《》같은 좁은 문장부호 하나만 빠진 자리도
 * 그 좌우 여백까지 포함해서 재는 바람에 gap 이 칸 크기의 1.5~2.5배로 측정돼 자리표자가
 * 2개(실제는 1개) 들어가는 과다 계산이 반복됐다. leading-gap 보정(alignColumnStarts 의
 * DETECTION_PADDING_BIAS)과 같은 종류의 측정 편향이라 같은 방식(칸 수에서 고정값을 뺌)
 * 으로 보정한다 — 기존 호출부(insertUndetectedMarks, PaddleOCR 단독 경로)는 이 문제가
 * 실측된 적 없어서 기본값 0(보정 없음)을 유지하고, ocrNdlocr.ts 만 1을 넘겨 쓴다.
 */
export function insertGapPlaceholdersForLine(
  line: Rect,
  units: Word[],
  text: string,
  typicalCellSize: number,
  paddingBias = 0,
  placeholder: string = UNKNOWN_GAP_PLACEHOLDER,
): string {
  const bboxUnits = units.filter((w) => w.bbox)
  if (bboxUnits.length === 0) return text

  // gaps: [원시 단위 배열상 삽입 위치(문자 오프셋), 끼워 넣을 자리표자 개수][]
  const gaps: [number, number][] = []
  const countAt = (upTo: number) => [...bboxUnits.slice(0, upTo).map((u) => u.text).join('')].length
  const gapCount = (gap: number) => Math.max(1, Math.round(gap / typicalCellSize) - paddingBias)

  const inRange = (gap: number) =>
    gap >= typicalCellSize * GAP_RATIO_THRESHOLD && gap <= typicalCellSize * MAX_GAP_RATIO

  // 담당 A — 쉼표/마침표 뒤에 자리표자가 중복으로 끼어드는 문제 수정(2026-07-30, 사용자
  // 제보 — "쉼표 다음에 빠짐표 문자가 추가돼서 텍스트 박스가 정상값보다 길어짐").
  // GAP_RATIO_THRESHOLD 를 0.6으로 낮춘 뒤 실측(DEBUG_OCR_DUMP)해보니, 문장부호(、。，
  // 등)는 잉크 자체가 좁아서 그 글자가 "차지해야 할 칸"을 다 못 채우고, 그 남는 여백이
  // 바로 다음 글자와의 간격에 그대로 얹혀 측정된다 — 실측: 정상 글자 간격은 -0.3~+0.33인데
  // 문장부호 **바로 뒤** 간격만 0.72~0.79로 따로 몰려 있었다(예: "，→歷" 0.7235,
  // "，→缺" 0.7468, "。"로 끝나는 줄들의 trailing 간격 0.79/0.61). 이 범위가 하필 진짜
  // 누락 신호(0.9569)와 낮춘 임계값(0.6) 사이에 걸쳐 있어서, 이미 정확히 인식된 문장부호
  // 뒤에 "한 글자 더 빠졌다"고 오판해 자리표자를 중복으로 끼워 넣었다. 문장부호 자신은
  // 이미 텍스트에 있으니(비어있는 자리가 아니라 잉크가 좁은 것뿐) 그 직후 간격은 애초에
  // "미검출 구간" 판정 대상이 될 이유가 없다 — 바로 앞 원시 단위가 이 문장부호 집합에
  // 속하면 간격 크기와 무관하게 무조건 건너뛴다.
  // `'`/`'`(아포스트로피)도 포함한다 — 이 함수는 `fixChineseCommaMisread`가 적용되기
  // 전의 원시 인식 단위(units)를 보는데, PaddleOCR이 쉼표를 아포스트로피로 잘못 읽은
  // 경우 원시 단위의 text 는 아직 `'`/`'` 그대로다. 잉크가 좁아 다음 글자와의 간격이
  // 벌어지는 현상은 정확한 쉼표로 읽혔든 아포스트로피로 오독됐든 똑같이 일어나므로
  // 함께 걸러야 한다.
  // 담당 A — 세미콜론(；)/콜론(：) 추가(2026-07-30, 사용자 제보 + DEBUG_OCR_DUMP 실측
  // 확인 — "허결호가 문장부호 앞뒤로 불필요하게 추가됨"). gaps-*.json 실제 덤프에서
  // "；→但" 0.618, "；→可" 0.647, "；→也" 0.618 처럼 세미콜론 뒤 간격만 따로 몰려
  // 있었다 — 위 쉼표/마침표와 완전히 같은 원인(잉크가 좁은 문장부호가 자기 칸을 다
  // 못 채워 다음 글자와의 간격에 여백이 얹힘)인데 이 두 문자만 목록에서 빠져 있었다.
  const NARROW_PUNCTUATION_RE = /[、。，！？…'’；：]/
  const skipGapAfter = (prevText: string) => NARROW_PUNCTUATION_RE.test(prevText)

  // 담당 A — 마침표/쉼표 미검출 진단용(2026-07-30, 사용자 제보 — "문장 중간 마침표/
  // 쉼표가 인식이 안 돼서 텍스트 박스 길이에 영향을 줌"). GAP_RATIO_THRESHOLD(1.5)를
  // 통과 못 해 자리표자가 안 채워지는 "문턱 바로 아래" 간격이 실제로 얼마인지 눈으로
  // 확인하려고, 통과 여부와 무관하게 모든 인접 간격의 비율(gap/typicalCellSize)을
  // 남긴다 — 동작 자체는 바뀌지 않음(아래 inRange 판정은 그대로 유지).
  const debugGaps: { at: string; ratio: number; passed: boolean }[] = []

  const leadingGap = bboxUnits[0]!.bbox!.y - line.y
  debugGaps.push({ at: 'leading', ratio: leadingGap / typicalCellSize, passed: inRange(leadingGap) })
  if (inRange(leadingGap)) {
    gaps.push([0, gapCount(leadingGap)])
  }
  for (let k = 1; k < bboxUnits.length; k++) {
    const prev = bboxUnits[k - 1]!
    const gap = bboxUnits[k]!.bbox!.y - (prev.bbox!.y + prev.bbox!.height)
    const passed = !skipGapAfter(prev.text) && inRange(gap)
    debugGaps.push({ at: `${prev.text}→${bboxUnits[k]!.text}`, ratio: gap / typicalCellSize, passed })
    if (passed) {
      gaps.push([countAt(k), gapCount(gap)])
    }
  }
  const last = bboxUnits[bboxUnits.length - 1]!
  const trailingGap = line.y + line.height - (last.bbox!.y + last.bbox!.height)
  const trailingPassed = !skipGapAfter(last.text) && inRange(trailingGap)
  debugGaps.push({ at: 'trailing', ratio: trailingGap / typicalCellSize, passed: trailingPassed })
  if (trailingPassed) {
    gaps.push([countAt(bboxUnits.length), gapCount(trailingGap)])
  }
  if (process.env.DEBUG_OCR_DUMP) {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(process.env.DEBUG_OCR_DUMP, `gaps-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
      JSON.stringify({ text, typicalCellSize, debugGaps }, null, 2),
    )
  }
  if (gaps.length === 0) return text

  // 뒤에서부터 끼워 넣어야 앞쪽 삽입이 뒤쪽 삽입 위치(문자 오프셋)를 안 밀리게 한다.
  const codepoints = [...text]
  for (const [idx, count] of [...gaps].sort((a, b) => b[0] - a[0])) {
    codepoints.splice(idx, 0, ...Array(count).fill(placeholder))
  }
  return codepoints.join('')
}

/**
 * 담당 A — 실제 인식된 원시 단위들의 세로 간격(잉크 위치)에서 칸 크기를 직접 잰다
 * (2026-07-30, 사용자 제보 두 건의 공통 원인 수정 — "텍스트 박스가 밑으로 한 칸
 * 길어짐"(이전 실행)과 "텍스트 박스가 거의 모든 열에서 짧아짐"(다음 실행)이 같은
 * 화면·같은 텍스트인데 정반대로 나타났다). DEBUG_OCR_DUMP 실측: 실제 칸 크기는
 * ~32.5px(열 간 피치로 역산)인데 estimateCellSizeFromIndent(들여쓰기 최빈값 기반)가
 * 한 번은 34, 다음 번엔 28을 내놨다 — 감지된 줄 bbox 상단이 캡처마다 몇 px 씩 다르게
 * 잡히면 최빈값이 다른 무리로 튀는 불안정한 방식이라, 이 값으로 격자를 나누면 19글자
 * 열에서 오차가 글자 수만큼 누적돼(+1.5px×19 ≈ 한 칸 초과 / -4.5px×19 ≈ 네 칸 미달)
 * 박스 길이가 실행마다 달라졌다. 인접한 원시 단위 사이 y 간격(다음 단위 시작 − 이전
 * 단위 시작을 이전 단위 글자 수로 나눈 값)은 실제 잉크가 놓인 자리에서 직접 재는
 * 값이라 캡처 노이즈에 훨씬 안정적이다 — 미검출 구간이 사이에 낀 쌍은 값이 튀지만
 * 소수라 중앙값이 걸러낸다.
 */
function measureCellPitchFromUnits(perLine: Word[][]): number | null {
  const pitches: number[] = []
  for (const units of perLine) {
    const bboxUnits = units.filter((w) => w.bbox)
    for (let k = 1; k < bboxUnits.length; k++) {
      const prev = bboxUnits[k - 1]!
      const prevChars = [...prev.text].length
      if (prevChars === 0) continue
      const pitch = (bboxUnits[k]!.bbox!.y - prev.bbox!.y) / prevChars
      if (pitch > 0) pitches.push(pitch)
    }
  }
  // 표본이 너무 적으면(짧은 열 한두 개뿐) 중앙값도 우연에 좌우된다 — 이 경우 null 을
  // 반환해 기존 추정(들여쓰기/줄 높이 기반)에 맡긴다.
  if (pitches.length < 5) return null
  return median(pitches)
}

async function insertUndetectedMarks(
  lines: Rect[],
  perLine: Word[][],
  texts: string[],
  placeholder: string = UNKNOWN_GAP_PLACEHOLDER,
): Promise<{ texts: string[]; typicalCellSize: number | null }> {
  const rawCellSizes = lines
    .map((line, i) => {
      const n = [...texts[i]!].length
      return n > 0 ? line.height / n : null
    })
    .filter((v): v is number => v !== null)
  const fallbackCellSize = rawCellSizes.length > 0 ? median(rawCellSizes) : null
  // 실측 잉크 피치를 최우선으로 쓴다(위 measureCellPitchFromUnits 주석 참고) — 표본
  // 부족으로 실패할 때만 기존 추정(들여쓰기 최빈값 → 줄 높이/글자 수)으로 폴백.
  const typicalCellSize =
    measureCellPitchFromUnits(perLine) ?? estimateCellSizeFromIndent(lines) ?? fallbackCellSize
  if (process.env.DEBUG_OCR_DUMP) {
    console.log(
      `[insertUndetectedMarks] cellSize: 실측피치=${measureCellPitchFromUnits(perLine)?.toFixed(2) ?? 'null'}` +
        ` 들여쓰기=${estimateCellSizeFromIndent(lines) ?? 'null'} 줄높이폴백=${fallbackCellSize?.toFixed(2) ?? 'null'}`,
    )
  }
  if (!typicalCellSize) return { texts, typicalCellSize: null }

  // 담당 A — 열 끝 문장부호(마침표 등) 완전 미검출 대응(2026-07-30, 사용자 제보 — "열 끝
  // 마침표가 누락되는 경우가 아직 있음, 아예 허결호로도 안 나옴"). trailing-gap 판정은
  // "검출된 줄 bbox 하단 − 마지막 인식 단위 하단"을 재는데, 검출 모델이 끝 문장부호를
  // 줄 bbox 에 아예 안 포함시키면(잉크가 작아 검출 경계가 그 앞 글자에서 끝남) 이 간격
  // 자체가 0이라 원리적으로 잡을 수 없다. 대신 페이지 공통 하단(본문 열들이 가장 많이
  // 끝나는 y, 조판된 세로쓰기는 문단 마지막 열이 아닌 한 하단이 정렬됨)을 구해서, 거기에
  // 약 한 칸(0.6~1.6칸)만 못 미치는 열은 끝 글자 하나가 검출에서 빠진 것으로 보고 하단을
  // 공통 하단까지 연장한다 — 그러면 기존 trailing-gap 로직이 그 자리에 자리표자를 넣는다.
  // 문단 마지막 열처럼 정당하게 일찍 끝나는 열은 보통 두 칸 이상 짧아서 이 범위에 안
  // 걸린다(걸리는 최악의 경우도 자리표자 하나가 더 붙는 정도).
  const roundedBottoms = lines.map((l) => Math.round((l.y + l.height) / 5) * 5)
  const bottomCounts = new Map<number, number>()
  for (const b of roundedBottoms) bottomCounts.set(b, (bottomCounts.get(b) ?? 0) + 1)
  let commonBottom: number | null = null
  let commonCount = 0
  for (const [b, c] of bottomCounts) {
    // 동점이면 더 큰 y(더 아래) 쪽 — 짧은 열 무리가 아니라 "가득 찬" 열 무리를 잡아야 한다.
    if (c > commonCount || (c === commonCount && commonBottom !== null && b > commonBottom)) {
      commonCount = c
      commonBottom = b
    }
  }
  // 공통 하단이라 부를 만큼 표본이 모였을 때만(3개 이상) 적용 — 열이 몇 개 없는 캡처에서
  // 우연히 겹친 하단을 기준 삼지 않게 한다.
  let extendedCount = 0
  const adjustedLines =
    commonBottom !== null && commonCount >= 3
      ? lines.map((l) => {
          const shortfall = commonBottom! - (l.y + l.height)
          if (
            shortfall >= typicalCellSize * GAP_RATIO_THRESHOLD &&
            shortfall <= typicalCellSize * 1.6
          ) {
            extendedCount++
            return { ...l, height: commonBottom! - l.y }
          }
          return l
        })
      : lines

  if (process.env.DEBUG_OCR_DUMP) {
    console.log(
      `[insertUndetectedMarks] commonBottom=${commonBottom ?? 'null'} commonCount=${commonCount}/${lines.length}` +
        ` extended=${extendedCount}`,
    )
  }

  const newTexts = adjustedLines.map((line, i) =>
    insertGapPlaceholdersForLine(line, perLine[i]!, texts[i]!, typicalCellSize, 0, placeholder),
  )
  return { texts: newTexts, typicalCellSize }
}

/**
 * 세로쓰기 열 하나(또는 열 구분이 안 된 영역 전체)를 PaddleOCR 로 인식한다 — 실측
 * 비교(합성 세로쓰기 8줄): 같은 조건(워커 풀 3개, 병렬)에서 PaddleOCR 1.6초 vs
 * manga-ocr 7.6초로 약 4.6배 빨랐고, 회전 트릭 없이도(세로쓰기는 글자 자체는 똑바로
 * 서 있고 읽는 방향만 위→아래라 PaddleOCR 인식 모델이 그대로 정확히 읽음) 정확도도
 * 100% 일치했다 — 그래서 일반 활자 세로쓰기(소설/책 PDF 등)는 이 함수를 기본으로 쓴다
 * (manga-ocr 로 시도했던 망가 특화 경로는 채택 안 하기로 결정해 제거됨).
 *
 * detectLinesWithPaddle 로 줄 위치를 먼저 찾고, 열이 여러 개 섞여있을 수 있으니
 * clusterVerticalLinesIntoColumns 로 순서를 바로잡은 뒤 줄마다 recognizeWithPaddle 을
 * 병렬로 호출한다 — recognizeWithPaddle 을 영역 전체에 한 번만 호출해도 PaddleOCR 자체
 * 검출기가 내부적으로 텍스트를 찾긴 하지만, 그 결과 순서가 세로쓰기 읽기 순서를
 * 보장한다는 근거가 없어서(가로쓰기 기준으로 설계된 정렬) 줄 단위로 직접 나눠 순서를
 * 우리가 확정짓는 쪽을 택했다.
 */
export async function recognizeVerticalColumnWithPaddle(
  image: Buffer,
  language: Language,
  columnBbox: Rect,
  precomputedLines?: Rect[],
): Promise<Word[] | null> {
  // precomputedLines 가 오면 재검출 안 한다 — DocLayout 이 블록을 못 찾았을 때(ocr.ts)
  // 가로/세로 판별용으로 이미 이 크롭에 detectLinesWithPaddle 을 한 번 돌려놨는데, 여기서
  // 또 같은 크롭에 같은 호출을 하면 완전히 중복된 작업이라(실측: 이 호출 자체가 페이지
  // 전체 크롭일 땐 38초까지도 걸림) 호출부가 넘겨주면 그대로 재사용한다.
  // 담당 A — 세로쓰기 인식 파이프라인 단계별 시간 확인용(2026-07-29, 사용자 요청 — 콤마/
  // 아포스트로피 혼동, 마침표 누락, 마지막 글자 박스 누락 등 남은 문제를 조사하려면 어느
  // 단계가 얼마나 걸리는지부터 봐야 함). 기존 `[timing]   세로쓰기(전체 영역): ...`(ocr.ts)
  // 는 이 함수 전체 합산 시간만 찍어서 내부 단계를 구분할 수 없었다 — 한 단계 더 들여써서
  // (`     `, 공백 5칸) 상위 로그 아래 하위 항목처럼 보이게 함.
  const detectStart = Date.now()
  const lines = precomputedLines ?? (await detectLinesWithPaddle(image, columnBbox))
  console.log(
    `[timing]     줄 검출(detectLinesWithPaddle): ${Date.now() - detectStart}ms (precomputed=${!!precomputedLines}, lines=${lines?.length ?? 'null'})`,
  )
  if (!lines || lines.length === 0) return []
  // 열 병합보다 먼저 후리가나를 걸러낸다 — excludeFurigana 주석 참고(후리가나 잡음 줄이
  // 남아있으면 열 폭 중앙값이 왜곡돼 clusterVerticalLinesIntoColumns 의 간격 판정이
  // 흔들린다, 실측 확인: 순서 뒤섞임/내용 누락).
  const clusterStart = Date.now()
  const bodyLines = excludeFurigana(lines)
  const ordered = clusterVerticalLinesIntoColumns(bodyLines)
  console.log(
    `[timing]     후리가나 필터+열 재군집화: ${Date.now() - clusterStart}ms (${lines.length}줄 → 본문 ${bodyLines.length}줄)`,
  )
  return recognizeOrderedLines(image, language, ordered, true)
}

/**
 * ocr.ts 가 DocLayout 실패(blocks=0) + 가로쓰기로 판별된 영역 전체를 인식할 때 쓴다.
 * 열 구분이 없는 단일 영역이라 가로쓰기 읽기 순서는 그냥 위→아래(줄바꿈 순서)면 충분해서
 * (세로쓰기처럼 여러 열이 나란히 있는 경우와 달리, 이 경로에서 여러 단(다단)까지
 * 섞이는 경우는 아직 확인된 바 없어 다루지 않는다 — 필요해지면 나중에 확장) 클러스터링은
 * 안 하고 y좌표로만 정렬한다. `recognizeWithPaddle` 을 영역 전체에 한 번 호출하는 대신
 * 줄 단위로 나눠 병렬 호출하는 이유는 recognizeVerticalColumnWithPaddle 과 같다(실측:
 * 페이지 전체를 한 번에 넘기면 38초, 열/줄 병렬화가 전혀 안 먹는 경로였음).
 *
 * recognizeVerticalColumnWithPaddle 과 마찬가지로 후리가나를 먼저 걸러낸다
 * (excludeFuriganaHorizontal 주석 참고) — 걸러내기 전엔 후리가나 줄마다 별도의
 * recognizeWithPaddle 호출이 추가로 발생해 줄 수가 거의 두 배로 늘어나면서 속도가
 * 크게 느려지고, 후리가나 자체도 본문 텍스트에 섞여 나오는 문제가 실측 확인됨
 * (2026-07-29, NHK "やさしいことば" 뉴스 페이지).
 */
// 담당 A — 가로쓰기 인식 속도 실험(2026-07-29, 사용자 요청). "small" 은 예전에 이미 한 번
// 검증됐던 이력이 있다(RECOGNITION_MODEL_NAME 주석 참고) — medium 대비 약 30% 빠르면서
// 정확도는 거의 동등했고, 그때 발견된 유일한 약점(縦中横 압축 숫자 오독)은 세로쓰기
// 전용 문제라 이 가로쓰기 경로엔 해당 안 된다. 세로쓰기(recognizeVerticalColumnWithPaddle)
// 는 이 상수를 안 쓰므로 그쪽 엔진 선택엔 영향이 없다.
const LIGHT_RECOGNITION_MODEL = 'PP-OCRv6_small_rec'

export async function recognizeLinesWithPaddle(
  image: Buffer,
  language: Language,
  bbox: Rect,
  precomputedLines?: Rect[],
): Promise<Word[] | null> {
  const lines = precomputedLines ?? (await detectLinesWithPaddle(image, bbox))
  if (!lines || lines.length === 0) return []
  // 후리가나는 일본어 전용 표기라 중국어(zh-Hans/zh-Hant)엔 애초에 존재하지 않는다 —
  // 필터 자체는 중국어 줄엔 걸릴 일이 없어 사실상 no-op이었지만, 불필요한 검사 비용을
  // 없애고 "중국어에 후리가나 필터가 적용된다"는 오해를 코드로도 막기 위해 언어로 분기한다.
  const bodyLines = language === 'ja' ? excludeFuriganaHorizontal(lines) : lines
  // 담당 A — 단순 y정렬 대신 열 재군집화(2026-07-30, clusterHorizontalLinesIntoColumns
  // 주석 참고) — 이 함수가 다단 영역 전체를 한 크롭으로 받는 경우(DocLayout 폴백 등)
  // 열 구분 없이 y로만 정렬하면 서로 다른 열의 줄이 섞여 읽힌다.
  const ordered = clusterHorizontalLinesIntoColumns(bodyLines)
  return recognizeOrderedLines(image, language, ordered, false, LIGHT_RECOGNITION_MODEL)
}

/**
 * 앱 시작 시(warmup.ts) 미리 불러서 풀의 워커 전부에 PaddleOCR 엔진을 만들어둔다 —
 * 워커마다 모델을 독립적으로 로드하므로(프로세스 간 공유 안 됨) 한 워커만 예열하면
 * 나머지는 실제 사용 시점에야 콜드 스타트를 겪는다. 위치 전용 엔진(en, detectLinesWithPaddle
 * 이 항상 쓰는 것)과 인식 엔진(ja/zh-Hans/zh-Hant)을 전부 예열한다.
 *
 * zh-Hans/zh-Hant 는 원래 여기 빠져 있었다(2026-07-30 발견) — `ocr_paddle.py: get_engine`
 * 이 엔진을 언어별(`LANG_MAP` 값 기준: ja→japan, zh-Hans→ch, zh-Hant→chinese_cht)로 따로
 * 캐싱해서, 밑에 깔린 모델 가중치 파일 자체는(코드 주석 확인: PP-OCRv6_medium_det/_rec로
 * 넷 다 동일) 같아도 언어 태그가 다르면 `PaddleOCR(...)` 인스턴스를 처음부터 다시 만든다
 * — ja 만 예열해뒀으니 중국어 세로쓰기를 앱 켜고 처음 인식할 때 워커마다 이 생성 비용을
 * 그 자리에서 치렀다(실측 확인: 단계별 타이밍 로그로 "줄별 인식" 9.6초 중 대부분이
 * `Creating model: (...)` 콘솔 출력과 겹침 — 진짜 추론 시간이 아니라 콜드 스타트였음).
 * 세로쓰기 경로(recognizeVerticalColumnWithPaddle)는 recModel 을 안 넘겨 항상 기본 모델
 * (RECOGNITION_MODEL_NAME, medium)을 쓰므로 여기 예열도 모델명을 안 넘겨 그대로 맞춘다.
 *
 * `server.warmUpAll()`은 `recognizeWithPaddle`/`detectLinesWithPaddle`(에러를 내부에서
 * 잡아 null 반환)을 거치지 않고 서버에 직접 요청하므로 Python 쪽 에러가 나면 그대로
 * reject 된다 — 개별 호출을 따로 잡아야 언어 하나가 실패해도(예: 특정 언어 모델 다운로드
 * 실패) 나머지 언어는 그대로 예열되고, warmup.ts 의 `Promise.all([...])`도 절대 reject
 * 되지 않는다(안 잡으면 "예열 완료" 상태로 못 넘어가 창 선택 버튼이 계속 막힘). 언어별로
 * 독립된 워커 풀 왕복이라 순차보다 병렬(Promise.all)이 전체 예열 시간도 줄인다.
 */
export async function warmUp(): Promise<void> {
  try {
    const tmpPath = await writeCrop(TINY_PNG, { x: 0, y: 0, width: 1, height: 1 })
    try {
      const warmUpLanguage = (language: string) =>
        server
          .warmUpAll({ image_path: tmpPath, language })
          .catch((err) => console.error(`[ocrPaddle] ${language} 예열 실패(무시):`, err))
      await Promise.all([
        server
          .warmUpAll({ image_path: tmpPath, language: DETECTION_ONLY_LANGUAGE, mode: 'detect_lines' })
          .catch((err) => console.error('[ocrPaddle] 줄 검출 엔진 예열 실패(무시):', err)),
        warmUpLanguage('ja'),
        warmUpLanguage('zh-Hans'),
        warmUpLanguage('zh-Hant'),
      ])
    } finally {
      void unlink(tmpPath).catch(() => {})
    }
  } catch (err) {
    console.error('[ocrPaddle] 예열 실패(무시):', err)
  }
}
