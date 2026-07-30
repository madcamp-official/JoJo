import type { Book } from 'epubjs'
import type { SearchHit } from './search'
import { findAll, makeSnippet, revealElement } from './search'

// 포맷별 "문서 전체에서 찾기" 구현. 어디서 텍스트를 얻는지가 전부 다르다.

/** 한 요소(문단/줄) 안에서 찾은 매치들을 결과로 바꾼다. */
function hitsInElement(el: HTMLElement, query: string, location: string): SearchHit[] {
  const text = el.textContent ?? ''
  return findAll(text, query).map((at) => ({
    location,
    ...makeSnippet(text, at, query.length),
    go: () => revealElement(el),
  }))
}

/** txt — 화면에 그려진 문단들을 그대로 훑는다. */
export function searchTxt(root: HTMLElement | null, query: string): SearchHit[] {
  if (!root) return []
  const out: SearchHit[] = []
  const paras = Array.from(root.querySelectorAll<HTMLElement>('.viewer-doc p'))
  paras.forEach((p, i) => out.push(...hitsInElement(p, query, `${i + 1}번째 문단`)))
  return out
}

/**
 * pdf — 이미 렌더된 페이지의 텍스트 레이어를 훑는다. 페이지를 전부 미리 그려두기
 * 때문에(PdfView 1단계) 파일을 다시 파싱하지 않아도 전체 검색이 된다.
 * 줄(.pdf-line) 단위로 찾아야 매치가 줄 경계에서 잘리지 않는다.
 */
export function searchPdf(root: HTMLElement | null, query: string): SearchHit[] {
  if (!root) return []
  const out: SearchHit[] = []
  const pages = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page'))
  pages.forEach((page, pi) => {
    for (const line of Array.from(page.querySelectorAll<HTMLElement>('.pdf-line'))) {
      out.push(...hitsInElement(line, query, `${pi + 1}쪽`))
    }
  })
  return out
}

/**
 * epub — 화면에는 지금 챕터만 있어서 DOM 만으로는 책 전체를 못 찾는다. spine(챕터 목록)을
 * 돌며 각 챕터 원문을 따로 읽어 검색하고, 결과를 누르면 그 챕터를 띄운 뒤 해당 문단으로
 * 데려간다. 챕터를 여는 건 비동기라 go() 안에서 렌더가 끝나길 잠깐 기다린다.
 */
export async function searchEpub(
  book: Book,
  display: (href: string) => Promise<unknown>,
  hostRef: () => HTMLElement | null,
  query: string,
): Promise<SearchHit[]> {
  const out: SearchHit[] = []
  // 목차/spine 은 책을 다 읽은 뒤에야 채워진다 — 기다리지 않으면 빈 목록이 나온다
  // (실측: 기다리지 않았을 때 spine items = 0).
  await book.ready
  // epubjs 타입에는 spine 순회가 얇게만 있어 실제 구조에 맞춰 좁혀 쓴다.
  type SpineItem = { href: string; load(req: unknown): Promise<ParentNode | null>; unload(): void }
  const spine = book.spine as unknown as { spineItems?: SpineItem[]; each?(fn: (i: SpineItem) => void): void }
  const items: SpineItem[] = []
  if (Array.isArray(spine.spineItems)) items.push(...spine.spineItems)
  else spine.each?.((it) => items.push(it))

  for (const [ci, item] of items.entries()) {
    let root: ParentNode | null = null
    try {
      root = await item.load(book.load.bind(book))
    } catch {
      continue // 못 읽는 챕터는 건너뛴다(표지 이미지 전용 등)
    }
    // load() 가 주는 건 Document 가 아니라 그 documentElement 다(epubjs Section.load 는
    // this.contents = xml.documentElement 를 resolve 한다). Document 인 줄 알고 .body 를
    // 읽으면 undefined 라 본문이 늘 빈 문자열이 됐고, 그게 검색이 항상 0곳이던 이유다.
    const text = root?.querySelector('body')?.textContent ?? ''
    for (const at of findAll(text, query)) {
      const snippet = makeSnippet(text, at, query.length)
      const href = item.href
      const needle = text.slice(at, at + query.length)
      out.push({
        location: `${ci + 1}장`,
        ...snippet,
        go: () => {
          void display(href).then(() => {
            // 렌더가 끝난 뒤 그 글자가 든 문단을 찾아 강조한다.
            window.setTimeout(() => {
              const inner = hostRef()?.querySelector('iframe')?.contentDocument
              const target = Array.from(inner?.querySelectorAll('p, div, li') ?? []).find((el) =>
                (el.textContent ?? '').includes(needle),
              )
              revealElement(target)
            }, 350)
          })
        },
      })
    }
    item.unload()
  }
  return out
}
