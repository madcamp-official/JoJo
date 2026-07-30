import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from './search'

// 왼쪽에서 밀려나오는 검색 패널 — 목차(Toc)와 같은 자리·같은 모양을 쓴다.
// 찾는 일 자체는 포맷별 구현(onSearch)이 하고, 여기서는 입력과 결과 목록만 다룬다.

export function SearchPanel({
  open,
  onClose,
  onSearch,
}: {
  open: boolean
  onClose: () => void
  /** 검색어로 결과를 만들어 준다. 문서가 크면 오래 걸릴 수 있어 Promise 로 받는다. */
  onSearch: (query: string) => Promise<SearchHit[]>
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 타이핑이 멈춘 뒤에 찾는다 — 글자마다 문서 전체를 훑으면 큰 파일에서 버벅인다.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearched(false)
      return
    }
    let cancelled = false
    setBusy(true)
    const timer = window.setTimeout(() => {
      void onSearch(q).then((result) => {
        if (cancelled) return
        setHits(result)
        setSearched(true)
        setBusy(false)
      })
    }, 260)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, open, onSearch])

  if (!open) return null

  return (
    <aside className="viewer-toc viewer-search">
      <header className="viewer-toc-head">
        <span>검색</span>
        <button className="viewer-toc-close" title="닫기" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="search-input-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="본문에서 찾기"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />
      </div>

      <div className="search-status">
        {busy ? '찾는 중…' : searched ? `${hits.length}곳에서 찾음` : '두 글자 이상 입력하세요'}
      </div>

      <nav className="viewer-toc-list">
        {hits.map((h, i) => (
          <button key={i} className="search-hit" onClick={h.go}>
            <span className="search-hit-loc">{h.location}</span>
            <span className="search-hit-text">
              {h.snippet.slice(0, h.hitStart)}
              <mark>{h.snippet.slice(h.hitStart, h.hitStart + h.hitLength)}</mark>
              {h.snippet.slice(h.hitStart + h.hitLength)}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  )
}
