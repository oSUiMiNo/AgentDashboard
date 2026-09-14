import type { Node as ProseNode, Schema } from '@milkdown/kit/prose/model'
import type { Root, RootContent } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])
const supportedNodes = new Set([
  'root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem', 'thematicBreak',
  'code', 'text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link',
  'image', 'linkReference', 'imageReference', 'table', 'tableRow', 'tableCell',
])

export type MarkdownSlice = {
  id: string
  raw: string
  gap: string
  type: string
  protected: boolean
  pinned: boolean
  spacer: boolean
}

type MarkdownNode = {
  type: string
  children?: MarkdownNode[]
  value?: string
  identifier?: string
  url?: string
  title?: string | null
  [key: string]: unknown
}

type Parse = (markdown: string) => ProseNode
export type MarkdownSerializer = (doc: ProseNode) => string

type Original = {
  slice: MarkdownSlice
  node: ProseNode
  index: number
}

export class MarkdownIntegrityError extends Error {
  constructor(message = 'この操作ではMarkdownの構造が変わるため反映できません。ソース編集で操作できます。') {
    super(message)
    this.name = 'MarkdownIntegrityError'
  }
}

export function parseFileMarkdown(source: string): Root {
  return markdownParser.parse(source)
}

export function safeMarkdownUrl(value: string): boolean {
  const compact = Array.from(value)
    .filter((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127 && !/\s/u.test(character))
    .join('')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)
  return scheme === null || /^(https?|mailto|tel)$/i.test(scheme[1] ?? '')
}

function protectedSyntax(node: MarkdownNode, refs: Map<string, MarkdownNode>): boolean {
  if (node.type === 'linkReference' || node.type === 'imageReference') {
    const reference = refs.get((node.identifier ?? '').toLowerCase())
    if (reference && !safeMarkdownUrl(reference.url ?? '')) return true
  }
  if (node.type === 'html') return !/^(?:\s*<br\s*\/?\s*>\s*)+$/i.test(node.value ?? '')
  if (!supportedNodes.has(node.type)) return true
  if (node.type === 'code' && node.meta) return true
  if ((node.type === 'image' || node.type === 'link') && !safeMarkdownUrl(node.url ?? '')) return true
  return node.children?.some((child) => protectedSyntax(child, refs)) ?? false
}

function definitions(tree: Root): Map<string, MarkdownNode> {
  return new Map(tree.children
    .filter((node) => node.type === 'definition')
    .map((node) => [node.identifier.toLowerCase(), node as MarkdownNode]))
}

function semantic(node: MarkdownNode, refs: Map<string, MarkdownNode>): unknown {
  let current = node
  if (node.type === 'linkReference' || node.type === 'imageReference') {
    const ref = refs.get((node.identifier ?? '').toLowerCase())
    if (ref) {
      current = {
        ...node,
        type: node.type === 'linkReference' ? 'link' : 'image',
        url: ref.url,
        title: ref.title ?? null,
      }
    }
  }
  const result: Record<string, unknown> = { type: current.type }
  for (const key of ['value', 'depth', 'ordered', 'start', 'checked', 'lang', 'meta', 'url', 'title', 'alt', 'align']) {
    let value = current[key]
    if (key === 'value' && typeof value === 'string') value = value.replace(/\r\n?/g, '\n')
    if (value !== undefined && value !== null) result[key] = value
  }
  if (current.type === 'linkReference' || current.type === 'imageReference' || current.type === 'definition') {
    result.identifier = current.identifier
  }
  if (current.children) result.children = current.children.map((child) => semantic(child, refs))
  return result
}

function sameMeaning(left: RootContent[], right: RootContent[], refs: Map<string, MarkdownNode>): boolean {
  return JSON.stringify(left.map((node) => semantic(node as MarkdownNode, refs))) ===
    JSON.stringify(right.map((node) => semantic(node as MarkdownNode, refs)))
}

function sameSourceNode(left: ProseNode, right: ProseNode): boolean {
  if (left.eq(right)) return true
  if (left.type !== right.type || left.childCount !== right.childCount || left.text !== right.text) return false
  const attrs = (node: ProseNode) => Object.fromEntries(Object.entries(node.attrs)
    .filter(([key]) => key !== 'sourceId' && !(node.type.name === 'heading' && key === 'id')))
  if (JSON.stringify(attrs(left)) !== JSON.stringify(attrs(right))) return false
  if (JSON.stringify(left.marks.map((mark) => mark.toJSON())) !== JSON.stringify(right.marks.map((mark) => mark.toJSON()))) return false
  for (let index = 0; index < left.childCount; index++) {
    if (!sameSourceNode(left.child(index), right.child(index))) return false
  }
  return true
}

let bookSequence = 0

export class MarkdownSource {
  readonly source: string
  readonly slices: MarkdownSlice[]
  readonly newline: string
  readonly prefix: string
  readonly suffix: string
  private readonly references: string
  private readonly refs: Map<string, MarkdownNode>
  private readonly tag = `md${++bookSequence}`
  private sequence = 0
  private originals = new Map<string, Original>()
  private initialNodes: ProseNode[] = []
  private initialDoc: ProseNode | null = null
  private serialized = new WeakMap<ProseNode, string>()

  constructor(source: string) {
    this.source = source
    this.newline = source.includes('\r\n') ? '\r\n' : '\n'
    const tree = parseFileMarkdown(source)
    this.refs = definitions(tree)
    this.references = tree.children.filter((node) => node.type === 'definition')
      .map((node) => source.slice(node.position?.start.offset, node.position?.end.offset)).join('\n\n')
    this.prefix = source.slice(0, tree.children[0]?.position?.start.offset ?? source.length)
    this.suffix = tree.children.length === 0 ? '' : source.slice(tree.children.at(-1)?.position?.end.offset)
    this.slices = tree.children.map((node, index) => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) throw new MarkdownIntegrityError('原文の位置を確認できませんでした。')
      const raw = source.slice(start, end)
      return {
        id: this.nextId(),
        raw,
        gap: index === tree.children.length - 1 ? '' : source.slice(end, tree.children[index + 1]?.position?.start.offset),
        type: node.type,
        protected: protectedSyntax(node as MarkdownNode, this.refs) || node.type === 'html',
        pinned: index === 0 && ['yaml', 'toml'].includes(node.type),
        spacer: node.type === 'html' && /^(?:\s*<br\s*\/?\s*>\s*)+$/i.test(raw),
      }
    })
  }

  nextId(): string {
    return `${this.tag}-${++this.sequence}`
  }

  createDoc(parse: Parse, serialize: MarkdownSerializer, schema: Schema): ProseNode {
    this.originals = new Map()
    this.serialized = new WeakMap()
    const nodes = this.slices.map((slice, index) => {
      let node: ProseNode | null = null
      if (!slice.protected) {
        try {
          const parsed = parse(`${slice.raw}${this.references ? `\n\n${this.references}` : ''}`)
          if (parsed.childCount === 1) {
            const candidate = parsed.firstChild!
            const output = serialize(schema.topNodeType.create(null, candidate))
            const inputTree = parseFileMarkdown(slice.raw)
            if (sameMeaning(inputTree.children, parseFileMarkdown(output).children, this.refs)) node = candidate
          }
        } catch {
          node = null
        }
      }
      if (node === null) {
        node = schema.nodes.markdown_source!.create({
          raw: slice.raw, kind: slice.type, pinned: slice.pinned, spacer: slice.spacer,
          sourceId: slice.id,
        })
      } else {
        node = node.type.create({ ...node.attrs, sourceId: slice.id }, node.content, node.marks)
      }
      this.originals.set(slice.id, { slice, node, index })
      return node
    })
    this.initialNodes = nodes
    this.initialDoc = schema.topNodeType.create(null, nodes.length ? nodes : schema.nodes.paragraph!.create())
    return this.initialDoc
  }

  isPinned(id: string): boolean {
    return this.originals.get(id)?.slice.pinned ?? false
  }

  private documentNodes(doc: ProseNode): ProseNode[] {
    const nodes: ProseNode[] = []
    doc.forEach((node) => nodes.push(node))
    const last = nodes.at(-1)
    if (last?.type.name === 'paragraph' && last.content.size === 0 && !this.originals.has(last.attrs.sourceId as string)) {
      nodes.pop()
    }
    return nodes
  }

  serialize(doc: ProseNode, serializer: MarkdownSerializer): string {
    if (this.initialDoc === null) throw new MarkdownIntegrityError('エディタを準備しています。')
    const nodes = this.documentNodes(doc)
    if (nodes.length === this.initialNodes.length && nodes.every((node, index) => sameSourceNode(node, this.initialNodes[index]!))) {
      return this.source
    }
    if (nodes.length === 0) return ''
    const chunks = nodes.map((node, index) => {
      const original = this.originals.get(node.attrs.sourceId as string)
      if (original?.slice.pinned && index !== 0) throw new MarkdownIntegrityError('前付け情報は文書の先頭に置いてください。')
      if (original && sameSourceNode(node, original.node)) return original.slice.raw
      if (node.type.name === 'markdown_source') return node.attrs.raw as string
      const cached = this.serialized.get(node)
      if (cached !== undefined) return cached
      const output = node.type.name === 'paragraph' && node.content.size === 0
        ? '<br />'
        : serializer(doc.type.create(null, node)).replace(/\r?\n$/, '')
      const normalized = output.replace(/\r\n?/g, '\n').replace(/\n/g, this.newline)
      this.serialized.set(node, normalized)
      return normalized
    })
    let output = this.prefix
    if (this.initialNodes.length === 0 && /[\t ]$/.test(output)) output += this.newline
    for (let index = 0; index < nodes.length; index++) {
      if (index > 0) {
        const previous = this.originals.get(nodes[index - 1]!.attrs.sourceId as string)
        const current = this.originals.get(nodes[index]!.attrs.sourceId as string)
        output += previous && current && current.index === previous.index + 1
          ? previous.slice.gap
          : `${this.newline}${this.newline}`
      }
      output += chunks[index]
    }
    output += this.suffix
    const resultTree = parseFileMarkdown(output)
    const expected = chunks.flatMap((chunk) => parseFileMarkdown(chunk).children)
    if (!sameMeaning(expected, resultTree.children, definitions(resultTree))) throw new MarkdownIntegrityError()
    return output
  }
}
