import type { Ctx } from '@milkdown/kit/ctx'
import { imageBlockSchema } from '@milkdown/kit/component/image-block'
import { serializerCtx } from '@milkdown/kit/core'
import {
  blockquoteSchema, bulletListSchema, codeBlockSchema, hardbreakSchema, headingSchema,
  hrSchema, htmlSchema, orderedListSchema, paragraphSchema,
} from '@milkdown/kit/preset/commonmark'
import { tableSchema } from '@milkdown/kit/preset/gfm'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Mapping } from '@milkdown/kit/prose/transform'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $prose, type $NodeSchema } from '@milkdown/kit/utils'
import { MarkdownIntegrityError, MarkdownSource, safeMarkdownUrl } from '../../../lib/fileMarkdown'

export const protectedSourceSchema = $nodeSchema('markdown_source', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  draggable: true,
  attrs: {
    sourceId: { default: null },
    raw: { default: '' },
    kind: { default: 'source' },
    pinned: { default: false },
    spacer: { default: false },
  },
  parseDOM: [{
    tag: 'div[data-markdown-source]',
    getAttrs: (dom) => ({ raw: dom.getAttribute('data-markdown-source') ?? '', kind: 'source' }),
  }],
  toDOM: (node) => node.attrs.spacer
    ? ['div', {
      class: 'md-source-spacer', 'data-markdown-source': node.attrs.raw,
      'data-md-block': node.attrs.sourceId, contenteditable: 'false', 'aria-label': '原文の改行',
    }, ...Array.from({ length: Math.max(1, String(node.attrs.raw).match(/<br\s*\/?\s*>/gi)?.length ?? 1) }, () => ['br'] as ['br'])]
    : ['div', {
      class: 'md-source-block', 'data-markdown-source': node.attrs.raw,
      'data-md-block': node.attrs.sourceId, contenteditable: 'false',
    },
    ['span', { class: 'md-source-label', 'data-file-find-skip': 'true' },
      `${node.attrs.pinned ? '前付け情報' : node.attrs.kind === 'html' ? 'HTML' : '原文'} · そのまま保持`],
    ['pre', { class: 'md-source-text' }, node.attrs.raw as string]],
  parseMarkdown: {
    match: (node) => node.type === 'markdown_source',
    runner: (state, node, type) => state.addNode(type, { raw: String(node.value ?? '') }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'markdown_source',
    runner: (state, node) => state.addNode('html', undefined, node.attrs.raw as string),
  },
}))

function extendSourceIdentity<Name extends string>(ctx: Ctx, schema: $NodeSchema<Name>) {
  ctx.update(schema.key, (factory) => (inner) => {
    const previous = factory(inner)
    return {
      ...previous,
      attrs: { ...previous.attrs, sourceId: { default: null } },
    }
  })
}

export function configureSourceSchema(ctx: Ctx, imageBlock = false) {
  const schemas = [paragraphSchema, headingSchema, blockquoteSchema, bulletListSchema,
    orderedListSchema, codeBlockSchema, hrSchema, tableSchema]
  for (const schema of schemas) extendSourceIdentity(ctx, schema as $NodeSchema<string>)
  if (imageBlock) {
    extendSourceIdentity(ctx, imageBlockSchema)
    ctx.update(imageBlockSchema.key, (factory) => (inner) => ({
      ...factory(inner),
      attrs: { ...factory(inner).attrs, title: { default: null } },
      parseMarkdown: {
        match: (node) => node.type === 'image-block',
        runner: (state, node, type) => state.addNode(type, {
          src: String(node.url ?? ''), caption: String(node.alt ?? ''), title: node.title ?? null, ratio: 1,
        }),
      },
      toMarkdown: {
        match: (node) => node.type.name === 'image-block',
        runner: (state, node) => {
          state.openNode('paragraph')
          state.addNode('image', undefined, undefined, {
            url: node.attrs.src, alt: node.attrs.caption, title: node.attrs.title,
          })
          state.closeNode()
        },
      },
    }))
  }
  ctx.update(htmlSchema.key, (factory) => (inner) => {
    const previous = factory(inner)
    return {
      ...previous,
      toDOM: (node) => /^<br\s*\/?\s*>$/i.test(String(node.attrs.value))
        ? ['br', { 'data-md-source-break': node.attrs.value }]
        : previous.toDOM!(node),
      parseDOM: [{ tag: 'br[data-md-source-break]', getAttrs: (dom) => ({ value: dom.getAttribute('data-md-source-break') }) }, ...previous.parseDOM ?? []],
    }
  })
  ctx.update(hardbreakSchema.key, (factory) => (inner) => ({
    ...factory(inner),
    toDOM: (node) => ['br', { 'data-type': 'hardbreak', 'data-is-inline': node.attrs.isInline }],
  }))
}

export type SourceSession = {
  book: MarkdownSource | null
  serialize: ((node: ProseNode) => string) | null
  composing: boolean
  lastValue: string
  onChange: (value: string) => void
  onError: (message: string | null) => void
  onReady?: (view: EditorView) => void
}

function topNodes(doc: ProseNode): ProseNode[] {
  const nodes: ProseNode[] = []
  doc.forEach((node) => nodes.push(node))
  return nodes
}

export function sourceIdentityPlugin(session: SourceSession) {
  return $prose((ctx) => new Plugin({
    key: new PluginKey('markdown-source-identity'),
    filterTransaction: (transaction) => {
      if (!transaction.docChanged || session.book === null) return true
      let safe = true
      transaction.doc.descendants((node) => {
        if (typeof node.attrs.src === 'string' && !safeMarkdownUrl(node.attrs.src)) safe = false
        for (const mark of node.marks) {
          if (mark.type.name === 'link' && !safeMarkdownUrl(String(mark.attrs.href ?? ''))) safe = false
        }
      })
      if (!safe) {
        session.onError('この種類のURLは使えません。httpsのURLや相対パスを指定してください。')
        return false
      }
      if (session.composing) return true
      try {
        session.book.serialize(transaction.doc, ctx.get(serializerCtx))
        session.onError(null)
        return true
      } catch (error) {
        session.onError(error instanceof Error ? error.message : new MarkdownIntegrityError().message)
        return false
      }
    },
    appendTransaction: (transactions, old, next) => {
      const book = session.book
      if (book === null || !transactions.some((transaction) => transaction.docChanged)) return null
      const mapping = new Mapping()
      for (const transaction of transactions) mapping.appendMapping(transaction.mapping)
      const origins = new Map<number, string>()
      old.doc.forEach((node, offset) => {
        const mapped = mapping.mapResult(offset, 1)
        const id = node.attrs.sourceId as string | null
        if (!id || mapped.deletedAcross) return
        const index = next.doc.resolve(Math.min(mapped.pos, next.doc.content.size)).index(0)
        if (!origins.has(index)) origins.set(index, id)
      })
      const seen = new Set<string>()
      const transaction = next.tr
      next.doc.forEach((node, offset, index) => {
        let id = node.attrs.sourceId as string | null
        if (!id || seen.has(id)) {
          const origin = origins.get(index)
          id = origin && !seen.has(origin) ? origin : book.nextId()
          transaction.setNodeMarkup(offset, undefined, { ...node.attrs, sourceId: id })
        }
        seen.add(id)
      })
      return transaction.docChanged ? transaction.setMeta('addToHistory', false) : null
    },
    props: {
      handleDOMEvents: {
        compositionstart: () => {
          session.composing = true
          return false
        },
        compositionend: (view) => {
          session.composing = false
          queueMicrotask(() => {
            if (!view.isDestroyed) publish(view)
          })
          return false
        },
      },
    },
    view: (view) => {
      session.onReady?.(view)
      return {
        update: (next, previous) => {
          if (!next.state.doc.eq(previous.doc)) publish(next)
        },
      }
    },
  }))

  function publish(view: EditorView) {
    const book = session.book
    if (book === null) return
    try {
      if (session.serialize === null) return
      const value = book.serialize(view.state.doc, session.serialize)
      if (value !== session.lastValue) {
        session.lastValue = value
        session.onChange(value)
      }
      session.onError(null)
    } catch (error) {
      session.onError(error instanceof Error ? error.message : new MarkdownIntegrityError().message)
    }
  }
}

export { topNodes }
