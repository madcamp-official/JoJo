// PDF/epub 목차(있을 때만) — 왼쪽에서 밀려나오는 패널. 항목을 누르면 그 위치로 이동한다.
// 이동 방법은 포맷마다 달라(PDF 는 페이지 번호, epub 은 CFI/href) 각 뷰가 채워 넣은
// 콜백(TocEntry.go)을 그대로 호출하기만 한다.

export interface TocEntry {
  /** 화면에 보이는 제목 */
  label: string
  /** 들여쓰기 깊이(0부터) */
  depth: number
  /** 이 항목으로 이동 */
  go: () => void
}

export function Toc({
  entries,
  open,
  onClose,
}: {
  entries: TocEntry[]
  open: boolean
  onClose: () => void
}) {
  if (!open || entries.length === 0) return null
  return (
    <aside className="viewer-toc">
      <header className="viewer-toc-head">
        <span>목차</span>
        <button className="viewer-toc-close" title="닫기" onClick={onClose}>
          ✕
        </button>
      </header>
      <nav className="viewer-toc-list">
        {entries.map((e, i) => (
          <button
            key={i}
            className="viewer-toc-item"
            style={{ paddingLeft: 14 + e.depth * 14 }}
            title={e.label}
            onClick={() => {
              e.go()
              onClose()
            }}
          >
            {e.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}
