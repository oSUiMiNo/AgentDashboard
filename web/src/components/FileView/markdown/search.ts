import { EditorView as CodeView } from '@codemirror/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { findTextMatches, type FileSearchAdapter } from '../../../lib/fileSearch'

type Match = { from: number; to: number; rawOffset?: number }
type Segment = { start: number; end: number; position: number; raw: boolean }

export function findBlockMatches(doc: ProseNode, query: string): Match[] {
  if (!query) return []
  let text = ''
  const segments: Segment[] = []
  doc.descendants((node, position) => {
    const raw = node.type.name === 'markdown_source'
    if ((node.isTextblock || raw) && text !== '') text += '\n'
    const value = raw ? String(node.attrs.raw) : node.isText ? node.text! : node.type.name === 'hardbreak' ? '\n' : ''
    if (value !== '') {
      segments.push({ start: text.length, end: text.length + value.length, position, raw })
      text += value
    }
    return !raw
  })
  const locate = (offset: number) => {
    let low = 0
    let high = segments.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const segment = segments[middle]!
      if (offset < segment.start) high = middle - 1
      else if (offset >= segment.end) low = middle + 1
      else return segment
    }
    return null
  }
  return findTextMatches(text, query).flatMap(([start, end]) => {
    const first = locate(start)
    const last = locate(end - 1)
    if (!first || !last) return []
    if (first.raw) return first === last ? [{ from: first.position, to: first.position + 1, rawOffset: start - first.start }] : []
    if (last.raw) return []
    return [{ from: first.position + start - first.start, to: last.position + end - last.start }]
  })
}

export function markdownSearch() {
  let view: EditorView | null = null
  let searchedDoc: ProseNode | null = null
  let matches: Match[] = []
  let active = 0
  let frame = 0
  const paint = () => {
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta('markdown-search', true))
  }
  const adapter: FileSearchAdapter = {
    search(query) {
      if (!view || view.isDestroyed) return 0
      searchedDoc = view.state.doc
      matches = findBlockMatches(searchedDoc, query)
      active = 0
      paint()
      return matches.length
    },
    show(index) {
      if (!view || view.isDestroyed || searchedDoc !== view.state.doc) return
      const match = matches[index]
      if (!match) return
      active = index
      const current = view
      const focused = current.dom.ownerDocument.activeElement
      const restoreFocus = () => {
        if (focused instanceof HTMLElement && focused.isConnected && focused !== current.dom) focused.focus({ preventScroll: true })
      }
      const selection = match.rawOffset === undefined
        ? TextSelection.create(current.state.doc, match.from, match.to)
        : NodeSelection.create(current.state.doc, match.from)
      current.dispatch(current.state.tr.setSelection(selection).scrollIntoView().setMeta('markdown-search', true))
      restoreFocus()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (current.isDestroyed || searchedDoc !== current.state.doc) return
        if (match.rawOffset !== undefined) {
          const dom = current.nodeDOM(match.from)
          const pre = dom instanceof HTMLElement ? dom.querySelector('pre') : null
          if (pre) {
            const row = (pre.textContent ?? '').slice(0, match.rawOffset).split('\n').length - 1
            pre.scrollTop = row * (Number.parseFloat(getComputedStyle(pre).lineHeight) || 20)
          }
          return
        }
        const position = current.state.doc.resolve(match.from)
        for (let depth = position.depth; depth > 0; depth--) {
          if (position.node(depth).type.name !== 'code_block') continue
          const dom = current.nodeDOM(position.before(depth))
          const code = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.cm-editor') : null
          const inner = code ? CodeView.findFromDOM(code) : null
          if (inner) {
            const start = match.from - position.start(depth)
            const end = Math.min(match.to - position.start(depth), inner.state.doc.length)
            inner.dispatch({ selection: { anchor: start, head: end }, effects: CodeView.scrollIntoView(start, { y: 'center' }) })
          }
          break
        }
        restoreFocus()
      })
    },
    clear() {
      cancelAnimationFrame(frame)
      matches = []
      searchedDoc = null
      paint()
    },
  }
  const plugin = $prose(() => new Plugin({
    key: new PluginKey('markdown-file-search'),
    props: {
      decorations(state) {
        if (searchedDoc !== state.doc || matches.length === 0) return null
        return DecorationSet.create(state.doc, matches.map((match, index) => {
          const attributes = { class: index === active ? 'md-find-current' : 'md-find-hit' }
          return match.rawOffset === undefined
            ? Decoration.inline(match.from, match.to, attributes)
            : Decoration.node(match.from, match.to, attributes)
        }))
      },
    },
    view(instance) {
      view = instance
      return { destroy() { cancelAnimationFrame(frame); view = null } }
    },
  }))
  return { adapter, plugin }
}
