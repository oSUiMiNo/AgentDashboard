import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, editorViewCtx, parserCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { undo, redo } from '@milkdown/kit/prose/history'
import { setBlockType } from '@milkdown/kit/prose/commands'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { configureSourceSchema, protectedSourceSchema, sourceIdentityPlugin, type SourceSession } from '../components/FileView/markdown/sourcePlugin'
import { MarkdownSource, safeMarkdownUrl } from './fileMarkdown'

const editors: Editor[] = []

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy()
  document.body.replaceChildren()
})

async function open(source: string) {
  const root = document.createElement('div')
  document.body.append(root)
  const changed = vi.fn()
  const failed = vi.fn()
  const session: SourceSession = { book: null, serialize: null, composing: false, lastValue: source, onChange: changed, onError: failed }
  const editor = Editor.make()
    .use(commonmark).use(gfm).use(history)
    .use(protectedSourceSchema).use(sourceIdentityPlugin(session))
    .config((ctx) => {
      ctx.set(rootCtx, root)
      configureSourceSchema(ctx)
    })
  editors.push(editor)
  await editor.create()
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const serializer = ctx.get(serializerCtx)
    const book = new MarkdownSource(source)
    const doc = book.createDoc(ctx.get(parserCtx), serializer, view.state.schema)
    session.book = book
    session.serialize = serializer
    view.updateState(EditorState.create({ doc, plugins: view.state.plugins, selection: TextSelection.atStart(doc) }))
    return { view, book, changed, failed, text: () => book.serialize(view.state.doc, serializer) }
  })
}

describe('Markdownの原文保持', () => {
  it.each([
    '', '  \r\n\r\n', '# 日本語\n\n本文です。', '﻿# 見出し\r\n\r\n段落\r\n',
    '見出し\n=======\n\n* そのまま\n* 残す\n',
    '---\ntitle: 試験\n---\n\n# 本文\n\n<!-- 保持 -->\n\n<br/>\n<br/>\n\n次の段落\n',
    '~~~typescript\nconst value = "```"\n~~~\n\n[参照][link]\n\n[link]: https://example.com "例"\n',
    '| 列1 | 列2 |\n| :--- | ---: |\n| 値 | a\\|b |\n\n- [x] 済み\n- [ ] まだ\n',
    '<details>\n<summary>詳細</summary>\n\n内側\n</details>\n\n本文',
  ])('開いただけで原文を書き換えない：%j', async (source) => {
    const { text, changed } = await open(source)
    expect(text()).toBe(source)
    expect(changed).not.toHaveBeenCalled()
  })

  it('主要ブロックは原文保護に逃げず編集ノードになる', async () => {
    const { view } = await open('# 題\n\n段落\n\n- 項目\n\n> 引用\n\n```js\nlet x = 1\n```\n\n| 列 |\n| --- |\n| 値 |\n')
    const types: string[] = []
    view.state.doc.forEach((node) => types.push(node.type.name))
    expect(types).toEqual(['heading', 'paragraph', 'bullet_list', 'blockquote', 'code_block', 'table'])
  })

  it('一段落だけ変えると他の記法と空行はそのまま残る', async () => {
    const source = '見出し\n=======\n\n\n同じ本文\n\n* そのまま\n* 残す\n\n<!-- 消さない -->\n'
    const { view, text } = await open(source)
    const pos = view.state.doc.child(0).nodeSize + 1
    view.dispatch(view.state.tr.insertText('追記', pos))
    expect(text()).toBe(source.replace('同じ本文', '追記同じ本文'))
  })

  it('同じ本文が二つあっても選んだ方だけ変える', async () => {
    const { view, text } = await open('同じ\n\n同じ')
    const pos = view.state.doc.child(0).nodeSize + 1
    view.dispatch(view.state.tr.insertText('二つ目', pos))
    expect(text()).toBe('同じ\n\n二つ目同じ')
  })

  it('日本語の編集を全てUndoすると原文へ完全に戻りRedoもできる', async () => {
    const source = '見出し\n=======\n\n本文\r\n'
    const { view, text } = await open(source)
    const pos = view.state.doc.firstChild!.nodeSize + 1
    view.dispatch(view.state.tr.insertText('追加', pos))
    expect(text()).toContain('追加本文')
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(text()).toBe(source)
    expect(redo(view.state, view.dispatch)).toBe(true)
    expect(text()).toContain('追加本文')
  })

  it('前付け情報とHTMLを保ったまま後ろの段落を編集する', async () => {
    const source = '---\ntitle: 原文\n---\n\n<script>alert(1)</script>\n\n本文'
    const { view, text } = await open(source)
    const pos = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize + 1
    view.dispatch(view.state.tr.insertText('追記', pos))
    expect(text()).toBe(source.replace('本文', '追記本文'))
    expect(document.querySelector('script')).toBeNull()
  })

  it('ブロック移動とUndoで原文の対応を取り違えない', async () => {
    const source = '最初\n\n# 次\n\n最後'
    const { view, text } = await open(source)
    const first = view.state.doc.firstChild!
    view.dispatch(view.state.tr.delete(0, first.nodeSize).insert(view.state.doc.content.size - first.nodeSize, first))
    expect(text()).toBe('# 次\n\n最後\n\n最初')
    undo(view.state, view.dispatch)
    expect(text()).toBe(source)
  })

  it('複製には別のIDを付けて片方だけを編集できる', async () => {
    const { view, text } = await open('本文')
    const first = view.state.doc.firstChild!
    view.dispatch(view.state.tr.insert(first.nodeSize, first))
    expect(view.state.doc.child(0).attrs.sourceId).not.toBe(view.state.doc.child(1).attrs.sourceId)
    view.dispatch(view.state.tr.insertText('後', view.state.doc.child(0).nodeSize + 1))
    expect(text()).toBe('本文\n\n後本文')
  })

  it('前付け情報の意味が変わる移動を拒否する', async () => {
    const source = '---\ntitle: 原文\n---\n\n本文'
    const { view, text, failed } = await open(source)
    const first = view.state.doc.firstChild!
    view.dispatch(view.state.tr.delete(0, first.nodeSize).insert(view.state.doc.content.size - first.nodeSize, first))
    expect(text()).toBe(source)
    expect(failed).toHaveBeenCalledWith(expect.stringContaining('先頭'))
  })

  it('ブロックの種類を変えても周りの空行と識別子を保つ', async () => {
    const { view, text } = await open('本文\n\n\n後ろ')
    const id = view.state.doc.firstChild!.attrs.sourceId
    setBlockType(view.state.schema.nodes.heading!, { level: 2 })(view.state, view.dispatch)
    expect(view.state.doc.firstChild!.attrs.sourceId).toBe(id)
    expect(text()).toBe('## 本文\n\n\n後ろ')
    undo(view.state, view.dispatch)
    expect(text()).toBe('本文\n\n\n後ろ')
  })

  it('分割と結合をUndoしても元の区切りへ戻れる', async () => {
    const source = '前半後半\n\n\n次の段落\n'
    const { view, text } = await open(source)
    view.dispatch(view.state.tr.split(3))
    expect(text()).toBe('前半\n\n後半\n\n次の段落\n')
    expect(view.state.doc.child(0).attrs.sourceId).not.toBe(view.state.doc.child(1).attrs.sourceId)
    view.dispatch(view.state.tr.join(view.state.doc.firstChild!.nodeSize))
    expect(text()).toBe(source)
    undo(view.state, view.dispatch)
    expect(text()).toBe(source)
  })

  it('改行は編集画面でも改行として表示する', async () => {
    const { view, text } = await open('一行目\n二行目')
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.dom.querySelector('br')).not.toBeNull()
    expect(text()).toBe('一行目\n二行目')
  })
})

describe('Markdownのリンク', () => {
  it.each(['https://example.com', '../image.png', '/path', '#heading', 'mailto:test@example.com'])('安全な参照を許可する：%s', (url) => {
    expect(safeMarkdownUrl(url)).toBe(true)
  })
  it.each(['javascript:alert(1)', 'JaVa\nScript:alert(1)', 'data:text/html,hello', 'file:///private'])('実行を伴う参照を許可しない：%s', (url) => {
    expect(safeMarkdownUrl(url)).toBe(false)
  })
})
