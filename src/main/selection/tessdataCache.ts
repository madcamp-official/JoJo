import { app } from 'electron'
import { join } from 'node:path'

// 담당 A — tesseract.js 가 cachePath 를 안 주면 기본값 '.'(process.cwd())에
// <lang>.traineddata 를 그대로 떨어뜨려 레포 루트가 지저분해진다(사용자 지적,
// 2026-07-30). userData 아래 전용 폴더로 고정해 실행 위치와 무관하게 한 곳에
// 모이게 한다 — createWorker() 호출부(ocr.ts/langDetect.ts) 전부 이 값을 쓴다.
export const TESSDATA_CACHE_PATH = join(app.getPath('userData'), 'tessdata')
