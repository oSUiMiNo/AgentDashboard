import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from '@milkdown/kit/prose/tables'

const tableActions = { addRowAfter, addColumnAfter, deleteRow, deleteColumn }

export function editTable(view: EditorView, action: keyof typeof tableActions): boolean {
  if (!view.editable || view.composing) return false
  const changed = tableActions[action](view.state, view.dispatch)
  if (changed) view.focus()
  return changed
}

export function selectedBlock(view: EditorView) {
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

export function duplicateSelectedBlock(view: EditorView): boolean {
  if (!view.editable || view.composing) return false
  const { from, node } = selectedBlock(view)
  if (node.attrs.pinned) return false
  const duplicate = node.type.create({ ...node.attrs, sourceId: null }, node.content, node.marks)
  const at = from + node.nodeSize
  const transaction = view.state.tr.insert(at, duplicate)
  transaction.setSelection(selectAt(transaction.doc, at, duplicate))
  view.dispatch(transaction.scrollIntoView())
  view.focus()
  return true
}

export function deleteSelectedBlock(view: EditorView): boolean {
  if (!view.editable || view.composing) return false
  const { from, node } = selectedBlock(view)
  view.dispatch(view.state.tr.delete(from, from + node.nodeSize).scrollIntoView())
  view.focus()
  return true
}

export function insertParagraphAfter(view: EditorView): boolean {
  if (!view.editable || view.composing) return false
  const { from, node } = selectedBlock(view)
  const at = from + node.nodeSize
  const transaction = view.state.tr.insert(at, view.state.schema.nodes.paragraph!.create())
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(at + 1)))
  view.dispatch(transaction.scrollIntoView())
  view.focus()
  return true
}
