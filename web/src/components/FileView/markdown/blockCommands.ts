import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

function selectedBlock(view: EditorView) {
  const { doc, selection } = view.state
  const index = Math.min(selection.$from.index(0), doc.childCount - 1)
  let from = 0
  for (let cursor = 0; cursor < index; cursor++) from += doc.child(cursor).nodeSize
  return { index, from, node: doc.child(index) }
}

function selectAt(doc: ProseNode, from: number, node: ProseNode) {
  return node.isAtom ? NodeSelection.create(doc, from) : TextSelection.near(doc.resolve(from + 1))
}

export function moveSelectedBlock(view: EditorView, direction: -1 | 1): boolean {
  if (!view.editable || view.composing) return false
  const { index, node } = selectedBlock(view)
  const target = index + direction
  const { doc } = view.state
  if (target < 0 || target >= doc.childCount || node.attrs.pinned || doc.child(target).attrs.pinned) return false
  const nodes: ProseNode[] = []
  doc.forEach((child) => nodes.push(child))
  nodes.splice(index, 1)
  nodes.splice(target, 0, node)
  const from = nodes.slice(0, target).reduce((sum, child) => sum + child.nodeSize, 0)
  const transaction = view.state.tr.replaceWith(0, doc.content.size, nodes)
  transaction.setSelection(selectAt(transaction.doc, from, node))
  view.dispatch(transaction.scrollIntoView())
  view.focus()
  return true
}
