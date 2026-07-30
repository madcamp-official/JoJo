import { useEffect, useRef, useState } from 'react'
import type { AppMode, Rect, Word } from '@shared/types'
import { findLineWordsAtPoint, unionBbox } from '@shared/wordMapping'
import { WORD_BOX_STYLE } from '@shared/highlightStyle'

// 오버레이 (PLAN.md §5.1) — 담당 A
// 선택된 창과 정확히 같은 자리에 정렬되는 투명·클릭스루 창. 테두리 색으로 현재 모드를
// 보여준다(일반=파랑 / 선택=보라). windows.ts: trackSelectionOverlay 가 위치를 잡아준다.
//
// 단어 위치(words)는 선택 모드 진입 시 메인 프로세스가 미리 캡처+추출해 캐시해둔 결과를
// (extractionCache.ts → onExtractionWords) 그대로 받는다 — 클릭 시점에 새로 OCR 을 돌리지
// 않으므로 여기 있는 bbox 는 모드 진입 시점 기준이다.
//
// OCR 은 창 전체가 아니라 사용자가 지정한 영역(regionSelection.ts)에만 적용된다 — 영역이
// 없으면(처음 선택한 창, 또는 리사이즈로 무효화된 뒤) 메인이 REGION_SELECTION_NEEDED 를
// 보내고, 여기서 드래그로 사각형을 그려 SUBMIT_REGION 으로 돌려준다.

const NOTICE_DURATION_MS = 4000
const MIN_REGION_SIZE = 8 // 이보다 작은 드래그는 실수 클릭으로 보고 무시
// macOS 는 창 모서리가 둥글고 Windows 는 각져 있다 — 오버레이 테두리도 대상 창의
// 실제 모서리 모양과 맞춰야 자연스럽다(styles.css: .overlay-root.is-mac 이 라운드 값 적용).
const IS_MAC = navigator.platform.toUpperCase().includes('MAC')

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

export function Overlay() {
  const [mode, setMode] = useState<AppMode>('normal')
  const [words, setWords] = useState<Word[]>([])
  // 단어 단위가 아니라 줄(세로쓰기 한 열/가로쓰기 한 줄) 단위로 hover/선택하기로
  // 결정(2026-07-28) — hover 는 커서 아래 단어가 속한 줄 전체(findLineWordsAtPoint)를
  // 담고, 화면에 그리는 박스는 그 줄 전체를 감싸는 bbox(unionBbox)를 쓴다. 클릭 시
  // 팝업의 초기 선택 범위도 메인 프로세스(selection/index.ts: findLineSpan)가 같은
  // 방식으로 줄 전체를 anchor 로 잡는다.
  const [hoveredLine, setHoveredLine] = useState<Word[]>([])
  // 개발 전용 디버그(사용자 요청) — OCR이 실제로 인식에 넘긴 블록/열 경계를 반투명
  // 사각형으로 보여준다. 프로덕션에서는 메인이 아예 이 이벤트를 안 보내므로 항상 빈
  // 배열로 남는다(onDebugBlocks 자체는 등록해도 무해 — 그냥 아무 이벤트도 안 옴).
  const [debugBlocks, setDebugBlocks] = useState<Rect[]>([])
  const [resolving, setResolving] = useState(false)
  // 선택 모드 진입 시 메인이 백그라운드로 캡처+OCR 을 시작한다(extractionCache.ts:
  // refreshExtractionCache, shortcut.ts 가 모드 전환 즉시 호출) — 그 사이(1~3초) 동안
  // 아무 표시도 없으면 멈춘 것처럼 보여서, 모드 진입 즉시 켜고 onExtractionWords 로
  // 결과(성공/실패 모두 빈 배열이라도)가 오면 끈다.
  const [extracting, setExtracting] = useState(false)
  // 추출 중 배너를 2단계로 나눠 보여준다(사용자 요청, 2026-07-29) — extracting 이 켜지는
  // 시점(모드 진입/화면 변화 감지)엔 아직 "언어 감지 & 텍스트 영역 탐지" 단계이고,
  // extractionCache.ts 가 언어 감지를 끝내고 실제 OCR 을 시작하면(onExtractionOcrStarted)
  // "텍스트 추출" 단계로 넘어간다.
  const [extractionPhase, setExtractionPhase] = useState<'detect' | 'ocr'>('detect')
  const [needsRegion, setNeedsRegion] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null)
  // 드래그로 영역을 막 확정한 직후, 같은 mouseup 뒤에 브라우저가 자동으로 발생시키는
  // click 이벤트를 "단어 클릭"으로 오인해 팝업이 뜨는 걸 막는다(state 는 비동기라 타이밍이
  // 애매해서 ref 로 동기적으로 체크). onOverlayClick 맨 앞에서 한 번만 소비한다.
  const justSubmittedRegionRef = useRef(false)
  // changeWatcher.ts(메인 프로세스)의 배경 재추출 콜백은 화면 변화 감지 후 800ms 대기 +
  // 비동기 영역 재감지를 거치는데, 그 사이에 사용자가 선택 모드를 나가도(Alt+Q)
  // stopChangeWatcher 는 "아직 안 fire 한" 타이머만 취소할 뿐 이미 실행 중인 콜백은
  // 못 막는다 — 그 콜백이 뒤늦게 sendExtractionStarted 를 보내면 일반 모드에서도
  // "텍스트 추출 중…" 배너가 뜨는 레이스가 실측 확인됐다. 이벤트 자체를 막을 수 없으니
  // 받는 쪽(여기)에서 그 시점의 최신 모드를 보고 걸러낸다 — mode state 는 비동기라
  // effect 의뢰존시(mode 를 deps 에 넣어 재구독)보다 ref 로 항상 최신값을 동기 참조하는
  // 쪽이 더 간단하고 안전하다.
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    window.nuance.getMode().then(setMode)
    return window.nuance.onModeChanged(setMode)
  }, [])

  useEffect(
    () =>
      window.nuance.onExtractionWords((w) => {
        setWords(w)
        setHoveredLine([]) // 새 단어 목록엔 이전 hover 대상과 같은 객체가 없어서, 안 지우면 낡은 위치의 박스가 남는다
        setExtracting(false)
        // 어떤 경로(OCR 성공/빈 결과, 자막 모드의 빈 배열)든 도착했다는 건 더 이상 영역
        // 선택을 기다릴 필요가 없다는 뜻 — 자막 모드로 전환되기 직전에 REGION_SELECTION_NEEDED
        // 가 먼저 와 있었던 경우(판정 경합) 그 드래그 안내가 남아있지 않도록 같이 끈다.
        setNeedsRegion(false)
      }),
    [],
  )

  // 화면 변화 감지로 백그라운드 재추출이 시작될 때(changeWatcher.ts)도 초기 진입 때와
  // 같은 "텍스트 추출 중…" 표시를 띄운다 — onExtractionWords 가 오면 자동으로 꺼진다.
  // 단, 위 modeRef 주석의 레이스를 막기 위해 지금 선택 모드일 때만 반영한다.
  useEffect(
    () =>
      window.nuance.onExtractionStarted(() => {
        if (modeRef.current === 'select') {
          setExtracting(true)
          setExtractionPhase('detect')
        }
      }),
    [],
  )

  // 언어 감지가 끝나고 실제 OCR 이 시작되는 시점(extractionCache.ts) — 배너 문구를
  // "텍스트 추출" 단계로 넘긴다. onExtractionStarted 와 같은 이유로 선택 모드일 때만 반영.
  useEffect(
    () =>
      window.nuance.onExtractionOcrStarted(() => {
        if (modeRef.current === 'select') setExtractionPhase('ocr')
      }),
    [],
  )

  useEffect(
    () =>
      window.nuance.onRegionSelectionNeeded(() => {
        // 모드 진입과 동시에(캐시된 영역이 없어서) 오거나, 리사이즈 감지로 모드 중간에
        // 올 수도 있다 — 두 경우 다 이전 단어/hover 를 비우고 드래그 대기 상태로 전환한다.
        setNeedsRegion(true)
        setExtracting(false)
        setWords([])
        setHoveredLine([])
        setDragStart(null)
        setDragCurrent(null)
      }),
    [],
  )

  useEffect(() => window.nuance.onOverlayNotice(setNotice), [])

  // onExtractionStarted 와 같은 레이스(위 modeRef 주석 참고) — changeWatcher.ts 의
  // 배경 재추출이 모드를 나간 뒤에도 뒤늦게 끝나면서 onDebugBlocks 가 일반 모드에서도
  // 도착해, 방금 나가면서 비운 블록이 다시 나타나는 문제가 실측 확인됨. 그 시점의
  // 최신 모드를 보고 선택 모드일 때만 반영한다.
  useEffect(
    () =>
      window.nuance.onDebugBlocks((blocks) => {
        if (modeRef.current === 'select') setDebugBlocks(blocks)
      }),
    [],
  )

  // 안내 배너는 잠깐 떴다가 자동으로 사라진다.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // 모드를 나가면 이전 단어 목록/hover/영역 선택 상태를 비운다.
  useEffect(() => {
    if (mode === 'select') {
      setExtracting(true) // onRegionSelectionNeeded 가 뒤이어 오면 바로 false 로 정정됨
      setExtractionPhase('detect')
    } else {
      setWords([])
      setHoveredLine([])
      setDebugBlocks([])
      setExtracting(false)
      setNeedsRegion(false)
      setDragStart(null)
      setDragCurrent(null)
    }
  }, [mode])

  // 선택 모드일 때만 단어 위치를 추적한다 — 일반 모드는 PLAN.md 상 "클릭에 개입하지
  // 않음"이 원칙이라 hover 감지도 꺼둔다. win32는 setIgnoreMouseEvents(true,
  // {forward:true})(windows.ts) 덕분에 클릭스루 상태에서도 mousemove 가 렌더러까지
  // 전달되지만, **mac은 이 forwarding 이 동작하지 않아**(2026-07-30 실사용 확인 —
  // 클릭스루 동안 mousemove 가 아예 안 와서 hover 판정이 안 돌고, 그래서 interactive
  // 전환도 커서 변경도 안 됐음) 메인이 커서 위치를 폴링해 보내주는 OVERLAY_CURSOR
  // 수신(onOverlayCursor)을 같은 판정에 연결한다 — 두 경로가 같은 setHoveredLine 을
  // 부르므로 어느 쪽이 먼저 오든 동작은 동일하다.
  useEffect(() => {
    if (mode !== 'select' || needsRegion) return
    function judge(point: { x: number; y: number }) {
      setHoveredLine(findLineWordsAtPoint(words, point))
    }
    function onMouseMove(e: MouseEvent) {
      judge({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener('mousemove', onMouseMove)
    const offCursor = window.nuance.onOverlayCursor(judge)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      offCursor()
    }
  }, [mode, words, needsRegion])

  // 실제 줄 bbox 위에 있는 동안만, 또는 영역을 드래그로 그리는 동안은 통째로
  // 클릭스루를 꺼서(windows.ts: setOverlayInteractive) 오버레이가 입력을 받게 한다.
  // interactive 의 참/거짓 값이 실제로 바뀔 때만 호출한다(2026-07-30, mac 실사용
  // 버그 수정) — hoveredLine 은 findLineWordsAtPoint 가 매 mousemove 마다 새 배열을
  // 반환해서, 같은 단어 위에 커서가 계속 머물러도 이 값의 참조가 매번 바뀌어 이
  // effect 가 매 mousemove 마다(초당 수십 번) 다시 실행됐다 — bool 값 자체는 안
  // 바뀌었는데도 네이티브 setIgnoreMouseEvents 를 반복 호출한 셈이라, mac에서 커서
  // 모양이 안 바뀌고 클릭이 가끔 밑 창으로 새는 증상으로 이어졌다(사용자 제보).
  // cursor 인자는 mac 전용(비활성 앱 창은 CSS cursor 가 안 먹혀 메인이 NSCursor 를 직접
  // 설정, preload 주석 참고) — 영역 드래그 중엔 십자, 단어 hover 중엔 클릭(pointer) 모양.
  // win32는 이 인자를 무시하고 아래 className 의 CSS(cursor: crosshair/pointer)가 담당한다.
  const interactive = needsRegion || hoveredLine.length > 0
  const interactiveCursor = needsRegion ? ('crosshair' as const) : ('pointer' as const)
  const lastInteractiveRef = useRef<string | null>(null)
  useEffect(() => {
    const key = interactive ? interactiveCursor : 'off'
    if (lastInteractiveRef.current === key) return
    lastInteractiveRef.current = key
    window.nuance.setOverlayInteractive(interactive, interactive ? interactiveCursor : null)
  }, [interactive, interactiveCursor])

  async function onOverlayClick(e: React.MouseEvent) {
    if (justSubmittedRegionRef.current) {
      justSubmittedRegionRef.current = false
      return
    }
    if (mode !== 'select' || needsRegion || resolving) return
    setResolving(true)
    try {
      await window.nuance.extractSelection({ x: e.clientX, y: e.clientY })
    } finally {
      setResolving(false)
    }
  }

  function onRootMouseDown(e: React.MouseEvent) {
    if (!needsRegion) return
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragCurrent({ x: e.clientX, y: e.clientY })
  }

  function onRootMouseMove(e: React.MouseEvent) {
    if (!needsRegion || !dragStart) return
    setDragCurrent({ x: e.clientX, y: e.clientY })
  }

  async function onRootMouseUp(e: React.MouseEvent) {
    if (!needsRegion || !dragStart) return
    const rect = normalizeRect(dragStart, { x: e.clientX, y: e.clientY })
    setDragStart(null)
    setDragCurrent(null)
    if (rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) return // 실수 클릭 무시

    justSubmittedRegionRef.current = true
    setNeedsRegion(false)
    setExtracting(true)
    await window.nuance.submitRegion(rect)
  }

  const dragRect = dragStart && dragCurrent ? normalizeRect(dragStart, dragCurrent) : null
  const hoveredBox = unionBbox(hoveredLine)

  return (
    <div
      className={`overlay-root mode-${mode}${hoveredBox ? ' hovering-word' : ''}${IS_MAC ? ' is-mac' : ''}${needsRegion ? ' region-select-cursor' : ''}`}
      onClick={onOverlayClick}
      onMouseDown={onRootMouseDown}
      onMouseMove={onRootMouseMove}
      onMouseUp={onRootMouseUp}
    >
      {/* 자동 탐지 영역 시각화(2026-07-30 디자인 변경, 사용자 요청) — 예전엔 블록마다
          노란 점선 사각형을 그렸는데, 이제 반대로 "탐지된 영역만 투명하게 뚫린 반투명
          회색 덮개"로 보여준다(테두리 없음) — 영역 수동 드래그 UI(.region-dim)와 동일한
          시각 언어. 블록이 여러 개(다단 등)라 box-shadow 트릭으론 구멍을 여러 개 못
          뚫어서 SVG mask(흰 바탕=칠함, 검정 사각형=구멍)로 처리한다. */}
      {debugBlocks.length > 0 && (
        <svg className="region-mask" width="100%" height="100%">
          <defs>
            <mask id="region-holes">
              <rect width="100%" height="100%" fill="white" />
              {debugBlocks.map((block, i) => (
                <rect key={i} x={block.x} y={block.y} width={block.width} height={block.height} fill="black" />
              ))}
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(128, 128, 128, 0.5)" mask="url(#region-holes)" />
        </svg>
      )}
      {hoveredBox && (
        <div
          className="word-box"
          style={{
            // hover 판정(findLineWordsAtPoint)은 그 줄에 속한 단어들의 bbox 합집합을
            // 그대로 쓰고, 화면에 그리는 박스만 사방에 살짝 여백을 둔다 — bbox 좌우
            // 경계가 글자 획(왼쪽: L/T/I 처럼 세로획이 끝에 붙은 글자, 오른쪽: 문장부호를
            // 제외하고 나면 마지막 글자의 잉크 픽셀 끝에 딱 붙음, ocr.ts:
            // splitWordBySymbols)에 딱 붙어 있어서 그대로 그리면 테두리가 글자와 겹쳐
            // 보인다. 세로쓰기는 줄 끝(아래쪽)의 문장부호가 bbox 없이 제외되면서
            // (groupCjkCharsGrid: bbox 없는 "gap 글자") 그 앞 실제 글자의 bbox 가 문장부호
            // 자리 바로 앞에서 끝나 아래쪽 테두리가 마지막 글자와 겹쳐 보이는 문제가
            // 사용자 실측으로 확인됨 — 위쪽 테두리도 같은 이유로 살짝 겹쳐 보일 수 있어
            // (사용자 요청) 위/아래 둘 다 여백을 준다. 색상/두께/여백은
            // shared/highlightStyle.ts 단일 소스 — 크롬 확장의 자막 하이라이트
            // (extension/src/highlight.ts)와 값을 공유해 스타일을 통일한다.
            left: hoveredBox.x - WORD_BOX_STYLE.padding,
            top: hoveredBox.y - WORD_BOX_STYLE.padding,
            width: hoveredBox.width + WORD_BOX_STYLE.padding * 2,
            height: hoveredBox.height + WORD_BOX_STYLE.padding * 2,
            border: `${WORD_BOX_STYLE.borderWidth}px solid ${WORD_BOX_STYLE.borderColor}`,
            background: WORD_BOX_STYLE.background,
            borderRadius: WORD_BOX_STYLE.borderRadius,
          }}
        />
      )}
      {needsRegion && (
        <>
          {/* 캡처 도구처럼 전체를 어둡게 하고, 드래그 중인 사각형만 원래 밝기로 "구멍"을
              낸다(사각형 자신에 거대한 box-shadow 를 씌우는 트릭 — 사각형이 없으면 0
              크기라 화면 전체가 균일하게 어두워짐). */}
          <div className="region-dim-clip">
            <div
              className="region-dim"
              style={{
                left: dragRect?.x ?? 0,
                top: dragRect?.y ?? 0,
                width: dragRect?.width ?? 0,
                height: dragRect?.height ?? 0,
              }}
            />
          </div>
          {/* 어두운 레이어가 부모(overlay-root)의 outline 테두리 위를 덮어버려서, 같은
              색으로 한 번 더 그린 테두리를 DOM 순서상 맨 뒤(= 항상 맨 위에 그려짐)에
              둔다 — 여기선 정확한 위치를 맞출 필요 없이 그냥 항상 위에 덮어씌운다. */}
          <div className="region-border-topcoat" />
        </>
      )}
      {notice ? (
        <div className="overlay-resolving">{notice}</div>
      ) : needsRegion ? (
        <div className="overlay-resolving">
          선택된 영역에 한하여 화면 변화를 감지하고 텍스트를 추출합니다.
        </div>
      ) : (
        (extracting || resolving) && (
          <div className="overlay-resolving">
            <span className="overlay-spinner" />
            {extracting && extractionPhase === 'detect'
              ? '언어 감지 & 텍스트 영역 탐지 중…'
              : '텍스트 추출 중…'}
          </div>
        )
      )}
    </div>
  )
}
