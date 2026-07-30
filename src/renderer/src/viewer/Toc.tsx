import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

// PDF/epub 목차(있을 때만) — 왼쪽에서 밀려나오는 패널. 하위 항목이 있으면 접었다 펼 수
// 있고, 기본은 접힌 상태다(사용자 지정 — 장 수가 많은 책에서 첫 화면이 덜 복잡하다).
// 이동 방법은 포맷마다 달라(PDF 는 페이지 번호, epub 은 CFI/href) 각 뷰가 채워 넣은
// 콜백(TocEntry.go)을 그대로 호출하기만 한다.

export interface TocEntry {
  /** 화면에 보이는 제목 */
  label: string
  /** 이 항목으로 이동 */
  go: () => void
  /** 하위 목차(없으면 빈 배열) */
  children: TocEntry[]
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
          <TocRow key={i} entry={e} depth={0} onNavigate={onClose} />
        ))}
      </nav>
    </aside>
  )
}

function TocRow({
  entry,
  depth,
  onNavigate,
}: {
  entry: TocEntry
  depth: number
  onNavigate: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasChildren = entry.children.length > 0

  return (
    <>
      <div className="viewer-toc-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {/* 펼침 화살표는 하위가 있을 때만 — 없을 때도 같은 너비를 비워 제목 시작선을 맞춘다. */}
        {hasChildren ? (
          <button
            className={`viewer-toc-caret${expanded ? ' open' : ''}`}
            title={expanded ? '접기' : '펼치기'}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronRight size={13} strokeWidth={2.5} aria-hidden="true" />
          </button>
        ) : (
          <span className="viewer-toc-caret placeholder" />
        )}
        <button
          className="viewer-toc-item"
          title={entry.label}
          onClick={() => {
            entry.go()
            onNavigate()
          }}
        >
          {entry.label}
        </button>
      </div>
      {expanded &&
        entry.children.map((c, i) => (
          <TocRow key={i} entry={c} depth={depth + 1} onNavigate={onNavigate} />
        ))}
    </>
  )
}
