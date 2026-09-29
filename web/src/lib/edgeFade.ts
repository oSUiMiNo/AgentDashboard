export const EDGE_FADE_SELECTOR = [
  '.prose-dashboard pre > code',
  '.prose-dashboard table',
  '.markdown-block-editor .cm-scroller',
  '.markdown-block-editor .table-wrapper',
  '.markdown-block-editor .milkdown-slash-menu .tab-group ul',
  '.file-editor',
  '[data-edge-fade]',
].join(', ')

export type Edge = 'start' | 'end' | 'both'

export function edgeOf(box: { scrollLeft: number; clientWidth: number; scrollWidth: number }): Edge | null {
  const 左に = box.scrollLeft > 1
  const 右に = box.scrollLeft + box.clientWidth < box.scrollWidth - 1
  return 左に && 右に ? 'both' : 左に ? 'start' : 右に ? 'end' : null
}

function 目印の幅(element: HTMLElement): { start: number; end: number } {
  if (element.classList.contains('cm-scroller')) {
    return { start: element.querySelector<HTMLElement>('.cm-gutters')?.offsetWidth ?? 0, end: 0 }
  }
  if (element.classList.contains('file-editor')) {
    const 番号 = element.parentElement?.querySelector<HTMLElement>('.file-editor-gutter')
    return { start: 番号?.offsetWidth ?? 0, end: element.offsetWidth - element.clientWidth }
  }
  return { start: 0, end: 0 }
}

function 対象(element: HTMLElement): HTMLElement {
  return element.classList.contains('file-editor') ? element.parentElement ?? element : element
}

export function measureEdge(element: HTMLElement): void {
  const edge = edgeOf(element)
  const 塗る先 = 対象(element)
  if (edge === null) {
    塗る先.removeAttribute('data-edge')
    return
  }
  const { start, end } = 目印の幅(element)
  塗る先.style.setProperty('--edge-start', `${start}px`)
  塗る先.style.setProperty('--edge-end', `${end}px`)
  if (塗る先.getAttribute('data-edge') !== edge) 塗る先.setAttribute('data-edge', edge)
}

export function installEdgeFades(root: HTMLElement): () => void {
  const 見ている = new Set<HTMLElement>()
  const 待ち = new Set<HTMLElement>()
  let 予約 = 0
  const 測り直す = () => {
    予約 = 0
    for (const element of 待ち) if (element.isConnected) measureEdge(element)
    待ち.clear()
  }
  const 頼む = (element: HTMLElement) => {
    待ち.add(element)
    if (予約 === 0) 予約 = requestAnimationFrame(測り直す)
  }
  const 大きさ = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      頼む(element.matches(EDGE_FADE_SELECTOR) ? element : (element.parentElement?.closest<HTMLElement>(EDGE_FADE_SELECTOR) ?? element))
    }
  })
  const 送った = (event: Event) => {
    const element = event.target
    if (element instanceof HTMLElement && 見ている.has(element)) 頼む(element)
  }
  const 付ける = (element: HTMLElement) => {
    if (見ている.has(element)) return
    見ている.add(element)
    大きさ?.observe(element)
    const 中身 = element.firstElementChild
    if (中身) 大きさ?.observe(中身)
    頼む(element)
  }
  const 外す = (element: HTMLElement) => {
    if (!見ている.delete(element)) return
    大きさ?.unobserve(element)
    const 中身 = element.firstElementChild
    if (中身) 大きさ?.unobserve(中身)
  }
  const 探す = (node: Node, 見つけた: (element: HTMLElement) => void) => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(EDGE_FADE_SELECTOR)) 見つけた(node)
    for (const element of node.querySelectorAll<HTMLElement>(EDGE_FADE_SELECTOR)) 見つけた(element)
  }
  探す(root, 付ける)
  const 変化 = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) 探す(node, 外す)
      for (const node of record.addedNodes) 探す(node, 付ける)
      const 場所 = record.target instanceof HTMLElement ? record.target : record.target.parentElement
      const 近く = 場所?.closest<HTMLElement>(EDGE_FADE_SELECTOR)
      if (近く && 見ている.has(近く)) 頼む(近く)
    }
  })
  変化.observe(root, { childList: true, subtree: true, characterData: true })
  root.addEventListener('scroll', 送った, true)
  return () => {
    変化.disconnect()
    大きさ?.disconnect()
    root.removeEventListener('scroll', 送った, true)
    if (予約 !== 0) cancelAnimationFrame(予約)
    見ている.clear()
  }
}
