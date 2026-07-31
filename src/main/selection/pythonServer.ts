import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { ensurePythonEngine, frozenExecutablePath, type EngineBundle } from './pythonEngineInstall'

// 담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.
// layout_detect.py / ocr_paddle.py 등이 전부 같은 상주 서버 패턴(표준
// 입출력, 한 줄 = 요청 하나·응답 하나)을 쓰길래 공통 로직으로 뽑았다. 매번 새
// 프로세스를 스폰하면 Python/torch/PaddlePaddle import + 모델 로딩만 몇 초~십수 초
// 걸려서(실측: layout_detect.py 8초+) 재사용이 필수라 다들 이 패턴을 쓴다.

const PYTHON_BIN = join(
  __dirname,
  process.platform === 'win32' ? '../../python/.venv/Scripts/python.exe' : '../../python/.venv/bin/python',
)

// 담당 A — 실험용 브랜치(experiment/ndlocr-lite). ocrNdlocr.ts 전용 — python/.venv
// 와 별도로 격리한 venv(python/.venv-ndlocr-test)의 인터프리터. 이유는 위 PYTHON_BIN
// 과 createPythonServer 의 pythonBin 오버라이드 주석 참고.
export const NDLOCR_PYTHON_BIN = join(
  __dirname,
  process.platform === 'win32'
    ? '../../python/.venv-ndlocr-test/Scripts/python.exe'
    : '../../python/.venv-ndlocr-test/bin/python',
)

// 워커 풀 크기(ocrPaddle.ts 의 POOL_SIZE)를 6으로 고정해뒀었는데, 이건 개발 컴퓨터
// (Intel i7-1165G7, 물리 4코어/논리 8코어) 기준으로 실측 튜닝한 값이라 다른 사용자
// 환경엔 안 맞을 수 있다 — 코어가 더 많은 컴퓨터에서는 오히려 성능을 다 못 쓰고, 코어가
// 적은 컴퓨터에서는 지금보다 더 심하게 오버서브스크립션돼서 불안정해진다(실측 확인:
// 이 컴퓨터도 물리 코어 4개인데 워커 6개라 이미 과다 상태였음). 그래서 실행 중인 기기의
// 실제 논리 코어 수(`os.cpus().length`, Node 는 물리 코어 수를 직접 못 줌)를 보고 동적
// 으로 정한다.
//
// "코어 수 - 2"로 잡는 이유: 메인 프로세스(Electron)와 OS/다른 프로그램 몫으로 최소
// 2개는 남겨두기 위함 — 이 컴퓨터(논리 8코어)에서 8-2=6 이 나와서, 그동안 실측으로
// 튜닝해 검증했던 값(6)과 정확히 일치한다(우연이 아니라, 애초에 그 튜닝이 이 기기의
// 코어 수에 맞았던 것). 최소 2, 최대 8로 묶어서 극단적으로 적거나(코어 1~2개짜리 저사양
// 기기에서 풀 자체가 무의미해지는 것 방지) 많은(코어가 아주 많은 서버급 기기에서 워커
// 수만큼 메모리(워커당 ~700~800MB)가 무한정 늘어나는 것 방지) 기기 모두 안전하게 만든다.
const MIN_POOL_SIZE = 2
const MAX_POOL_SIZE = 8

/** 실행 중인 기기의 코어 수 기반으로 적당한 워커 풀 크기를 정한다. */
export function defaultPoolSize(): number {
  const logicalCores = cpus().length || 4 // cpus() 가 빈 배열을 줄 수도 있다는 Node 문서상 안내 — 안전한 기본값.
  return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, logicalCores - 2))
}

// 1x1 흰 픽셀 PNG(PIL 로 직접 생성해 바이트를 검증함) — 예열(warmUp) 호출용 최소
// 이미지. 실제 감지/인식 결과는 안 쓰고(빈 결과가 나와도 상관없음) 그 과정에서 모델이
// 로드되는 부수효과만 노린다. 손으로 적은 PNG 바이트가 깨져있으면(실제로 한 번 그랬음
// — cv2.imdecode/PIL 둘 다 "이미지 아님" 에러) 모델 로딩 자체는 에러 전에 끝나서 예열
// 효과는 있어도 매번 에러 로그가 남고 처리 안 된 예외가 뜰 위험이 있어 제대로 된
// 바이트로 교체했다.
export const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8ffff3f0005fe02fe0def46b80000000049454e44ae426082',
  'hex',
)

export interface PythonServer {
  /** 요청 하나를 보내고 응답 하나를 받는다 — 같은 서버로 가는 요청은 자동으로 직렬화된다. */
  request<Req, Res>(req: Req): Promise<Res>
}

// Node 의 child_process.spawn 은 부모(Electron 메인 프로세스)가 죽어도 자식을 자동으로
// 안 죽인다 — 그래서 지금까지 여러 번(진단 스크립트 반복 실행 등) 스폰된 python 프로세스가
// 고아로 남아 계속 쌓이는 걸 실측으로 확인했다(레이아웃/PaddleOCR 프로세스가 예상보다
// 2배 떠있어 메모리 ~2.8GB 낭비). 실제 앱도 여러 번 껐다 켜면 같은 식으로 프로세스가
// 누적될 수 있어서, 스폰된 프로세스를 전부 여기 추적해뒀다가 앱 종료 시(index.ts:
// before-quit) 일괄 정리한다.
const activeProcesses = new Set<ChildProcessWithoutNullStreams>()

// venv 의 python.exe 는(Windows) 실제 인터프리터가 아니라 작은 런처 실행 파일이다
// (pyvenv.cfg 의 home 경로를 찾아 그걸 자식 프로세스로 다시 띄우고 표준입출력을 그대로
// 이어준다) — 실측 확인: 워커 하나를 스폰하면 프로세스가 항상 2개(런처 + 실제 전역
// 인터프리터) 뜬다. `proc.kill()`은 직접 자식(런처)만 죽이고 그 밑의 손자 프로세스
// (실제 인터프리터)까지 자동으로 죽인다는 보장이 없다(Windows 는 부모가 죽어도 자식
// 트리를 자동 정리 안 함, 이 파일 상단 주석과 같은 문제가 한 단계 더) — 그래서 죽일 때
// PID 하나만이 아니라 트리 전체(taskkill /T)를 지운다.
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 이미 죽어있던 PID 등 — 무해하므로 무시.
    }
  } else {
    try {
      process.kill(pid)
    } catch {
      // 이미 죽어있음.
    }
  }
}

// 여기서 스폰한 워커들의 PID 를 앱 데이터 폴더에 파일로 남겨둔다 — before-quit 가
// 정상적으로 안 불리고 앱이 그냥 죽는 경우(강제 종료, 개발 중 프로세스를 밖에서 직접
// kill 하는 경우 등, 실사용 중 반복 확인됨: 대화 세션이 끊기면서 그 세션이 띄워둔
// dev 서버가 안 죽고 계속 쌓임)엔 이번 실행에서는 정리할 기회가 아예 없다. 대신 다음
// 번 앱 시작 시(index.ts) 이 파일을 읽어서 지난 실행이 남긴 프로세스를 먼저 정리한다
// — "언젠가 한 번은 정상적으로 앱이 다시 시작된다"는 전제만 있으면 스스로 치유된다.
const PID_FILE_NAME = 'python-workers.pid'

function pidFilePath(): string {
  return join(app.getPath('userData'), PID_FILE_NAME)
}

function persistActivePids(): void {
  try {
    const pids = [...activeProcesses].map((p) => p.pid).filter((pid): pid is number => pid !== undefined)
    writeFileSync(pidFilePath(), JSON.stringify(pids))
  } catch (err) {
    console.error('[pythonServer] PID 파일 저장 실패(무시):', err)
  }
}

/**
 * 앱 시작 시(index.ts) 새 워커를 스폰하기 전에 한 번 호출 — 지난 실행이 비정상
 * 종료돼서 못 지운 python 워커가 있으면 여기서 정리한다. PID 재사용 가능성(아주 드묾
 * — 재부팅 없이 짧은 시간 안에 우연히 같은 PID 가 재할당돼야 함)은 감수한다: 최악의
 * 경우도 무관한 프로세스 하나를 잘못 죽이는 것뿐이라 계속 쌓이는 것보다 훨씬 안전하다.
 */
export function cleanupOrphanedPythonServers(): void {
  try {
    const pids = JSON.parse(readFileSync(pidFilePath(), 'utf-8')) as number[]
    for (const pid of pids) killProcessTree(pid)
  } catch {
    // 파일이 없으면(첫 실행 등) 정리할 게 없다는 뜻 — 무시.
  }
}

/** 앱 종료 시(index.ts) 호출 — 지금까지 스폰된 python 서버 프로세스를 전부 죽인다. */
export function killAllPythonServers(): void {
  for (const proc of activeProcesses) {
    if (proc.pid !== undefined) killProcessTree(proc.pid)
  }
  activeProcesses.clear()
  persistActivePids()
}

/**
 * `python/<scriptName>`을 상주 프로세스로 띄우고(죽으면 다음 요청 때 자동 재기동)
 * 표준입출력으로 통신하는 클라이언트를 만든다. 응답 JSON 에 `error` 필드가 있으면
 * reject 시킨다(요청 하나 실패해도 서버 프로세스 자체는 계속 살아있음 — 각 스크립트의
 * serve() 가 예외를 잡아서 에러 응답만 보내고 루프를 계속 돎).
 */
export function createPythonServer(
  scriptName: string,
  extraArgs: string[] = [],
  // 담당 A — 실험용 브랜치(experiment/ndlocr-lite). ndlocr-lite 는 numpy/opencv/
  // onnxruntime 버전이 공용 venv(PYTHON_BIN)와 충돌해서 별도 venv(python/.venv-
  // ndlocr-test)에 격리 설치했다 — 그 venv의 인터프리터를 쓰려면 스크립트별로 다른
  // python 바이너리를 스폰해야 해서 오버라이드를 추가함. 생략하면 기존과 동일하게
  // 공용 PYTHON_BIN을 쓴다.
  pythonBin: string = PYTHON_BIN,
): PythonServer {
  const scriptPath = join(__dirname, '../../python', scriptName)
  const exeName = scriptName.replace(/\.py$/, '')
  // NDLOCR_PYTHON_BIN을 넘겼는지로 어느 PyInstaller 번들(main/ndlocr) 소속인지 판별한다
  // (호출부 시그니처를 안 늘리려고 기존 오버라이드 파라미터를 그대로 재사용) — 패키지된
  // 빌드에서만 의미가 있고, 개발 모드는 원래대로 pythonBin(venv 인터프리터)을 직접 쓴다.
  const bundle: EngineBundle = pythonBin === NDLOCR_PYTHON_BIN ? 'ndlocr' : 'main'
  let proc: ChildProcessWithoutNullStreams | null = null
  let rl: Interface | null = null
  // 요청을 한 번에 하나씩만 보내도록 직렬화한다 — 상관관계 ID 없이 순서로만 응답을
  // 매칭하므로, 동시에 여러 요청을 보내면 응답이 뒤섞인다.
  let queue: Promise<unknown> = Promise.resolve()

  /** 패키지된 빌드: PyInstaller 번들(R2에서 받아 캐싱, 없으면 다운로드)의 실행 파일을
   *  인자만 붙여 직접 스폰. 개발 모드: 지금까지처럼 venv 인터프리터로 스크립트를 스폰. */
  async function resolveSpawnTarget(): Promise<{ cmd: string; args: string[] }> {
    if (!app.isPackaged) return { cmd: pythonBin, args: [scriptPath, ...extraArgs] }
    await ensurePythonEngine(bundle)
    return { cmd: frozenExecutablePath(bundle, exeName), args: extraArgs }
  }

  async function ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (proc && !proc.killed) return proc
    const { cmd, args } = await resolveSpawnTarget()
    const p = spawn(cmd, args)
    // Node 가 자식 프로세스 stdout 을 기본 인코딩 없이 Buffer 로 주는데, 이걸 그대로
    // readline.createInterface 에 넘기면(바로 아래) 플랫폼 로캘(한국어 Windows 는
    // cp949 계열) 기준으로 잘못 디코딩되는 경우가 있다 — 실측 확인: sudachi_tokenize.py
    // 만 다른 스크립트와 달리 json.dumps(ensure_ascii=False) 로 원문 CJK 문자를 그대로
    // 내보내는데(다른 스크립트는 기본값 ensure_ascii=True 라 항상 순수 ASCII 라 이 문제를
    // 우연히 피해감), 그 결과만 엉뚱한 한자로 깨져 들어왔다(예: "細剣" 같은 정상 한자가
    // "榮" 같은 전혀 무관한 한자로 치환) — UTF-8 로 명시해서 근본 원인을 없앤다.
    p.stdout.setEncoding('utf8')
    activeProcesses.add(p)
    persistActivePids() // PID 파일을 항상 "지금 살아있다고 믿는 목록"과 동기화해둔다.
    const reset = () => {
      activeProcesses.delete(p)
      persistActivePids()
      if (proc === p) {
        proc = null
        rl = null
      }
    }
    p.on('error', reset) // python 실행 파일 자체가 없는 경우(venv 미설치) 등 — ENOENT
    p.on('exit', reset)
    p.stderr.on('data', (d) => console.error(`[${scriptName}] stderr:`, d.toString()))
    proc = p
    rl = createInterface({ input: p.stdout })
    return p
  }

  /**
   * 요청 한 줄을 보내고 응답 한 줄을 기다린다. 프로세스가 아예 못 뜨거나(spawn ENOENT)
   * 응답을 기다리는 도중 죽으면(모델 로딩 실패 등) 그 자리에서 reject 해야 한다 —
   * 안 그러면 'line' 이벤트가 영원히 안 와서 요청이 무한 대기하게 된다.
   */
  async function send<Req, Res>(req: Req): Promise<Res> {
    const p = await ensureProcess()
    const lines = rl!
    return new Promise<Res>((resolve, reject) => {
      const cleanup = () => {
        lines.off('line', onLine)
        p.off('error', onError)
        p.off('exit', onExit)
      }
      const onLine = (line: string) => {
        cleanup()
        try {
          const parsed = JSON.parse(line) as Res | { error: string }
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            reject(new Error((parsed as { error: string }).error))
          } else {
            resolve(parsed as Res)
          }
        } catch (err) {
          reject(err)
        }
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`${scriptName} exited (${code}) while waiting for response`))
      }
      lines.once('line', onLine)
      p.once('error', onError)
      p.once('exit', onExit)
      p.stdin.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          cleanup()
          reject(err)
        }
      })
    })
  }

  return {
    request<Req, Res>(req: Req): Promise<Res> {
      const task = queue.then(() => send<Req, Res>(req))
      queue = task.catch(() => undefined) // 이번 요청이 실패해도 큐 자체는 안 끊기게
      return task
    },
  }
}

export interface PythonServerPool {
  /** 가장 한가한 워커에게 요청을 보낸다. */
  request<Req, Res>(req: Req): Promise<Res>
  /** 예열 전용 — 워커마다 모델을 독립적으로 로드하므로, 하나만 예열해선 안 되고 풀의
   * 전체 워커에 같은 요청을 동시에 보내 전부 예열한다. */
  warmUpAll<Req, Res>(req: Req): Promise<Res[]>
}

/**
 * `createPythonServer` 를 여러 개 띄워 풀로 묶는다 — PaddleOCR 인식은
 * 페이지 하나에 열/줄 단위로 수십 번씩 순차 호출해야 하는데(ocr.ts), 워커가
 * 하나면 전부 한 줄로 서서 기다려야 해서(실사용 중 "세로쓰기 페이지 인식이 오래 걸림"
 * 으로 확인) 여러 워커에 나눠 동시에 처리하게 한다. 요청마다 "지금 가장 한가한(진행
 * 중인 요청이 가장 적은) 워커"를 골라 보낸다(least-connections 방식) — 단순 라운드로빈
 * 보다 요청 처리 시간이 제각각인 상황(줄마다 글자 수가 달라 인식 시간이 다름)에 더
 * 고르게 분산된다.
 *
 * 트레이드오프: 워커마다 모델을 독립적으로 메모리에 들고 있어서(같은 프로세스끼리
 * 모델을 공유 못 함) 워커 수만큼 메모리 사용량이 늘어난다 — poolSize 는 그 트레이드오프
 * 를 감안해 정한다.
 */
export function createPythonServerPool(
  scriptName: string,
  poolSize: number,
  extraArgs: string[] = [],
): PythonServerPool {
  const workers = Array.from({ length: poolSize }, () => createPythonServer(scriptName, extraArgs))
  const inFlight = new Array(poolSize).fill(0) as number[]

  function pickWorker(): number {
    let best = 0
    for (let i = 1; i < poolSize; i++) {
      if (inFlight[i]! < inFlight[best]!) best = i
    }
    return best
  }

  return {
    request<Req, Res>(req: Req): Promise<Res> {
      const i = pickWorker()
      inFlight[i]!++
      return workers[i]!.request<Req, Res>(req).finally(() => {
        inFlight[i]!--
      })
    },
    warmUpAll<Req, Res>(req: Req): Promise<Res[]> {
      return Promise.all(workers.map((w) => w.request<Req, Res>(req)))
    },
  }
}
