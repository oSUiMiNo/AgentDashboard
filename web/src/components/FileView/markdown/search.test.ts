import { Schema } from '@milkdown/kit/prose/model'
import { describe, expect, it } from 'vitest'
import { findBlockMatches } from './search'

const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'inline*' },
    code_block: { group: 'block', content: 'text*', marks: '', code: true },
    markdown_source: { group: 'block', atom: true, attrs: { raw: {} } },
    text: { group: 'inline' },
    hardbreak: { group: 'inline', inline: true },
  },
  marks: { strong: {}, em: {} },
})

describe('findBlockMatches', () => {
  it('inline markをまたぐ語の位置を返す', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('pre '),
        schema.text('ab', [schema.mark('strong')]),
        schema.text('cd', [schema.mark('em')]),
        schema.text('ef post'),
      ]),
    ])
    expect(findBlockMatches(doc, 'bcde')).toEqual([{ from: 6, to: 10 }])
  })

  it('日本語の一致をすべて文書内の位置へ戻す', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('前文 日本語と日本語')),
    ])
    expect(findBlockMatches(doc, '日本語')).toEqual([
      { from: 4, to: 7 },
      { from: 8, to: 11 },
    ])
    expect(findBlockMatches(doc, '')).toEqual([])
  })

  it('長いcode_blockの末尾も全文から見つける', () => {
    const prefix = 'const value = 1\n'.repeat(2000)
    const text = `${prefix}末尾の検索語`
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, schema.text(text)),
    ])
    expect(findBlockMatches(doc, '末尾の検索語')).toEqual([
      { from: prefix.length + 1, to: text.length + 1 },
    ])
  })

  it('HTML保護ノードではノード位置と原文のrawOffsetを返す', () => {
    const paragraph = schema.node('paragraph', null, schema.text('前文'))
    const raw = '<section>\n<p>日本語</p>\n<p>日本語</p>\n</section>'
    const doc = schema.node('doc', null, [
      paragraph,
      schema.node('markdown_source', { raw }),
    ])
    expect(findBlockMatches(doc, '日本語')).toEqual([
      { from: paragraph.nodeSize, to: paragraph.nodeSize + 1, rawOffset: raw.indexOf('日本語') },
      { from: paragraph.nodeSize, to: paragraph.nodeSize + 1, rawOffset: raw.lastIndexOf('日本語') },
    ])
  })

  it('ブロック境界や改行を除去して別々の語を誤結合しない', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('日本')),
      schema.node('paragraph', null, schema.text('語')),
      schema.node('paragraph', null, [schema.text('日本'), schema.node('hardbreak'), schema.text('語')]),
      schema.node('code_block', null, schema.text('日本\n語')),
    ])
    expect(findBlockMatches(doc, '日本語')).toEqual([])
    expect(findBlockMatches(doc, '日本')).toHaveLength(3)
  })
})
