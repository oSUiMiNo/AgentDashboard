/** フェーズ1 の実測用。測り終えたら消す。 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'

/** react-markdown と同じ並び（lib/index.js の 266〜273行）で hast を作る。 */
function hastOf(markdown: string): unknown {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .runSync(unified().use(remarkParse).parse(markdown))
  return tree
}

function kinds(node: unknown, out: string[] = []): string[] {
  const n = node as { type?: string; tagName?: string; value?: string; children?: unknown[] }
  if (n.type === 'raw') {
    out.push(`raw(${JSON.stringify(n.value)})`)
  } else if (n.type === 'element') {
    out.push(`element:${n.tagName}`)
  } else if (n.type === 'text') {
    out.push(`text(${JSON.stringify(n.value)})`)
  }
  for (const child of n.children ?? []) {
    kinds(child, out)
  }
  return out
}

it('probe', () => {
  const cases: Record<string, string> = {
    '段落の中の <br/>': 'まえ<br/>あと',
    '行頭の <br/>': '<br/>\n\n本文',
    '他のHTML': 'まえ<span>なか</span>あと',
    'script': 'まえ<script>alert(1)</script>あと',
    'コードブロックの中': '```\n<br/>\nline\n```',
    '行内コードの中': 'まえ `<br/>` あと',
    '大文字': 'まえ<BR/>あと',
    '連続': 'まえ<br/><br/>あと',
    'このPJTの作法': '## 見出し\n本文\n\n---\n<br/>\n<br/>\n\n## つぎ\n本文',
    'ブロックのHTML': '<div>\nなか\n</div>\n\n本文',
  }
  for (const [name, src] of Object.entries(cases)) {
    // eslint-disable-next-line no-console
    console.log(`\n### ${name}\n${kinds(hastOf(src)).join('\n')}`)
  }
})
