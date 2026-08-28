import type { Element, Root } from 'hast'
import type { PhrasingContent, Root as MdastRoot } from 'mdast'
import {
  BODY_FOLD_LIMIT,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  foldMarkdown,
  rehypeLineBreaks,
  remarkSoftBreaks,
  splitLineBreaks,
  splitSoftBreaks,
} from './markdown'

/**
 * 本文の畳み方と `<br>` の読み替え（テスト計画フェーズ2）。
 *
 * ここで守るべき約束は2つ。
 * - **切った位置がマークダウンを壊さない**（長い応答こそ畳まれる側なので、壊れると被害が大きい）
 * - **`<br/>` だけを改行にし、それ以外の HTML は落とさない**（消えたことに気づけない側へ倒さない）
 *
 * しきい値は**小さい値を渡して**確かめる。既定の 1000 で試すと、境目を作るためだけに
 * 1000文字の本文を書くことになり、**どこで切れたのかがテストから読めなくなる**。
 */

describe('本文を畳む', () => {
  it('しきい値以下なら畳まない', () => {
    expect(foldMarkdown('あいうえお', 10)).toEqual({ head: 'あいうえお', folded: false })
  })

  it('しきい値ちょうどでも畳まない', () => {
    // `<=` を `<` に取り違えると、ここだけが落ちる
    const text = 'あいうえおかきくけこ'
    expect(text).toHaveLength(10)
    expect(foldMarkdown(text, 10)).toEqual({ head: text, folded: false })
  })

  it('しきい値を超えたら、最後の改行まで戻して切る', () => {
    // limit=6 は「2行目」の途中に落ちる。戻さない実装だと `1行目\n2行` になる
    const result = foldMarkdown('1行目\n2行目\n3行目', 6)
    expect(result).toEqual({ head: '1行目', folded: true })
  })

  it('1行目がしきい値より長ければ、戻す先が無いのでそのまま切る', () => {
    const result = foldMarkdown('あいうえおかきくけこさ', 5)
    expect(result).toEqual({ head: 'あいうえお', folded: true })
  })

  it('戻した先が空になるときも、そのまま切る', () => {
    // 改行はあるが先頭にしか無い。戻すと本文が1文字も残らない
    const result = foldMarkdown('\nあいうえおかきくけこ', 5)
    expect(result).toEqual({ head: '\nあいうえ', folded: true })
  })

  it('畳んだ本文の末尾に印を足さない', () => {
    // `…` を足すと整形の対象になり、記法の途中に入って崩れる（設計§3-4）
    const { head } = foldMarkdown('1行目\n2行目\n3行目', 6)
    expect(head).not.toContain('…')
    expect(head).not.toContain('...')
  })
})

describe('囲みコードブロックを閉じる', () => {
  it('途中で切れたら、同じ綴りで閉じる', () => {
    const text = '```js\nconst a = 1\nconst b = 2\n```\nあと'
    const { head } = foldMarkdown(text, 25)
    expect(head).toBe('```js\nconst a = 1\n```')
  })

  it('チルダで開いたものは、チルダで閉じる', () => {
    // バッククォートで閉じても閉じたことにならない
    const text = '~~~\nabcdefghij\nklmnopqrst\n~~~\nあと'
    const { head } = foldMarkdown(text, 20)
    expect(head).toBe('~~~\nabcdefghij\n~~~')
  })

  it('4連で開いたものは、4連で閉じる', () => {
    // 3連では閉じられない。数を数えて偶数奇数で決める実装だとここが落ちる
    const text = '````\nabcdefghij\nklmnopqrst\n````\nあと'
    const { head } = foldMarkdown(text, 21)
    expect(head).toBe('````\nabcdefghij\n````')
  })

  it('閉じている位置で切れたら、フェンスを足さない', () => {
    // 常に足す実装だとここだけが落ちる（肯定側と否定側を対で置く）
    const text = '```\nab\n```\nつづきの文章がここに長く続く'
    const { head } = foldMarkdown(text, 20)
    expect(head).toBe('```\nab\n```')
  })

  it('コードブロックの中のチルダは、閉じ記号として数えない', () => {
    const text = '```\n~~~\nabcdefghij\nklmnopqrst\n```\nあと'
    const { head } = foldMarkdown(text, 24)
    // `~~~` を閉じと読むと、ここで開きっぱなしが解消されてしまい末尾の ``` が付かない
    expect(head.endsWith('\n```')).toBe(true)
  })
})

describe('切る位置が壊すもの（許容した振る舞い）', () => {
  it('表の区切り行の直前で切れると、表にならない', () => {
    // **これは仕様である**（設計§3-3）。戻す先を増やすと切る位置の規則が2つになるため
    // 許容した。知らずに壊れた状態と区別できるよう、ここで固定しておく
    const text = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'
    const { head } = foldMarkdown(text, 15)
    expect(head).toBe('| A | B |')
    expect(head).not.toContain('---')
  })
})

describe('`<br>` を改行として読み替える', () => {
  const breaks = (pieces: ReturnType<typeof splitLineBreaks>) =>
    pieces.filter((piece) => piece.kind === 'break').length

  it.each(['<br>', '<br/>', '<br />', '<BR/>', '<Br />'])('%s を改行として読む', (tag) => {
    expect(breaks(splitLineBreaks(`まえ${tag}あと`))).toBe(1)
  })

  it('前後にある字が落ちない', () => {
    expect(splitLineBreaks('まえ<br/>あと')).toEqual([
      { kind: 'raw', value: 'まえ' },
      { kind: 'break' },
      { kind: 'raw', value: 'あと' },
    ])
  })

  it('`<br>` 以外の HTML はそのまま残る', () => {
    // ここで消すと、生の HTML を字面として出すという判断（設計§4-1）が死ぬ
    expect(splitLineBreaks('<span>')).toEqual([{ kind: 'raw', value: '<span>' }])
    expect(splitLineBreaks('x<span>y<br/>z')).toEqual([
      { kind: 'raw', value: 'x<span>y' },
      { kind: 'break' },
      { kind: 'raw', value: 'z' },
    ])
  })

  it('連続した `<br/>` は、その数だけ改行になる', () => {
    expect(breaks(splitLineBreaks('<br/><br/>'))).toBe(2)
    expect(breaks(splitLineBreaks('まえ<br/><br/><br/>あと'))).toBe(3)
  })

  it('このリポジトリの作法（1つの断片にタグと地の文が混ざる形）でも読める', () => {
    // 行頭から始まる HTML は塊で1つの断片になる（フェーズ1 の実測）。
    // 「断片がタグと一致するか」で判定する実装だと、ここだけが落ちる
    expect(splitLineBreaks('<br/>\n<br/>')).toEqual([
      { kind: 'break' },
      { kind: 'raw', value: '\n' },
      { kind: 'break' },
    ])
  })
})

describe('rehype プラグイン', () => {
  /** `<p>` の下に生 HTML が1つある木。 */
  function tree(value: string): Root {
    return {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [{ type: 'raw', value } as never],
        },
      ],
    }
  }

  function tagsOf(root: Root): string[] {
    const out: string[] = []
    const visit = (node: Root | Element) => {
      for (const child of node.children as { type: string; tagName?: string; value?: string }[]) {
        out.push(child.type === 'element' ? `element:${child.tagName}` : `${child.type}(${child.value})`)
        if (child.type === 'element') {
          visit(child as unknown as Element)
        }
      }
    }
    visit(root)
    return out
  }

  it('入れ子の中の `<br/>` も `br` 要素になる', () => {
    const root = tree('まえ<br/>あと')
    rehypeLineBreaks()(root)
    expect(tagsOf(root)).toEqual([
      'element:p',
      'raw(まえ)',
      'element:br',
      'raw(あと)',
    ])
  })

  it('`<br>` 以外の生 HTML は木に残る', () => {
    const root = tree('<span>')
    rehypeLineBreaks()(root)
    expect(tagsOf(root)).toEqual(['element:p', 'raw(<span>)'])
  })
})

describe('素の改行を割る', () => {
  it('改行のところで割れる', () => {
    expect(splitSoftBreaks('あいう\nかきく')).toEqual([
      { kind: 'text', value: 'あいう' },
      { kind: 'break' },
      { kind: 'text', value: 'かきく' },
    ])
  })

  it('CRLF でも `\\r` が残らない', () => {
    // **`\n` だけで割ると断片の先頭に `\r` が残る。** Windows で書かれた `.md` や
    // Windows から貼り付けた本文が普通に通る道なので、ここは端の話ではない
    expect(splitSoftBreaks('あいう\r\nかきく')).toEqual([
      { kind: 'text', value: 'あいう' },
      { kind: 'break' },
      { kind: 'text', value: 'かきく' },
    ])
  })

  it('前後の空白は落とさない', () => {
    expect(splitSoftBreaks('あいう  \n  かきく')).toEqual([
      { kind: 'text', value: 'あいう  ' },
      { kind: 'break' },
      { kind: 'text', value: '  かきく' },
    ])
  })

  it('空の断片はノードにしない', () => {
    expect(splitSoftBreaks('\nあいう')).toEqual([{ kind: 'break' }, { kind: 'text', value: 'あいう' }])
    expect(splitSoftBreaks('あいう\n')).toEqual([{ kind: 'text', value: 'あいう' }, { kind: 'break' }])
  })

  it('改行が無ければそのまま', () => {
    expect(splitSoftBreaks('あいう')).toEqual([{ kind: 'text', value: 'あいう' }])
  })
})

describe('remark プラグイン', () => {
  /** `paragraph` の下に子を並べた木。 */
  function tree(...children: PhrasingContent[]): MdastRoot {
    return { type: 'root', children: [{ type: 'paragraph', children }] }
  }

  function shapeOf(root: MdastRoot): string[] {
    const out: string[] = []
    const visit = (node: { children?: unknown[] }) => {
      for (const raw of node.children ?? []) {
        const child = raw as { type: string; value?: string; children?: unknown[] }
        out.push(child.value === undefined ? child.type : `${child.type}(${child.value})`)
        visit(child)
      }
    }
    visit(root)
    return out
  }

  it('本文の `\\n` が `break` になる', () => {
    const root = tree({ type: 'text', value: 'あいう\nかきく' })
    remarkSoftBreaks()(root)
    expect(shapeOf(root)).toEqual(['paragraph', 'text(あいう)', 'break', 'text(かきく)'])
  })

  it('囲みコードの中は触らない', () => {
    // **`code` は `text` ではない別のノード。** 中の改行は値として持たれているので、
    // `text` だけを歩いている限り構造的に触りようがない（設計§4 の実測）
    const root: MdastRoot = { type: 'root', children: [{ type: 'code', value: '1行目\n2行目' }] }
    remarkSoftBreaks()(root)
    expect(shapeOf(root)).toEqual(['code(1行目\n2行目)'])
  })

  it('生の HTML の中は触らない', () => {
    const root: MdastRoot = { type: 'root', children: [{ type: 'html', value: '<br/>\n<br/>' }] }
    remarkSoftBreaks()(root)
    expect(shapeOf(root)).toEqual(['html(<br/>\n<br/>)'])
  })

  it('表のセルの中まで歩く（セルに改行が無ければ何も起きない）', () => {
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'table',
          children: [
            {
              type: 'tableRow',
              children: [{ type: 'tableCell', children: [{ type: 'text', value: 'あ' }] }],
            },
          ],
        },
      ],
    }
    remarkSoftBreaks()(root)
    expect(shapeOf(root)).toEqual(['table', 'tableRow', 'tableCell', 'text(あ)'])
  })

  it('ハード改行（既にある `break`）は増やさない', () => {
    const root = tree({ type: 'text', value: 'あいう' }, { type: 'break' }, { type: 'text', value: 'かきく' })
    remarkSoftBreaks()(root)
    expect(shapeOf(root)).toEqual(['paragraph', 'text(あいう)', 'break', 'text(かきく)'])
  })
})

describe('改行が二重になるもの（許容した振る舞い）', () => {
  it('行内の `<br/>` の直後の改行は、改行2つになる', () => {
    // **抑えない。** 抑えるには「隣が `<br>` なら割らない」という兄弟を覗く規則が要り、
    // どちらの規則が効いたのかを読む側が追えなくなる（設計§6）。打った側から見れば
    // `<br/>` と改行を2つ書いているので、「打ったとおりに見せる」からは外れてもいない。
    //
    // 行頭の `<br/>`（このリポジトリの作法）はブロックの `html` ノード1つになるので
    // ここを通らない——そちらが二重にならないことは E2E が `toHaveCount(2)` で固定している
    const root: MdastRoot = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'あいう' },
            { type: 'html', value: '<br/>' },
            { type: 'text', value: '\nえお' },
          ],
        },
      ],
    }
    remarkSoftBreaks()(root)
    expect(shapeOfBreaks(root)).toEqual(['html(<br/>)', 'break'])
  })

  function shapeOfBreaks(root: MdastRoot): string[] {
    const out: string[] = []
    const visit = (node: { children?: unknown[] }) => {
      for (const raw of node.children ?? []) {
        const child = raw as { type: string; value?: string; children?: unknown[] }
        if (child.type === 'break') {
          out.push('break')
        }
        if (child.type === 'html') {
          out.push(`html(${child.value})`)
        }
        visit(child)
      }
    }
    visit(root)
    return out
  }
})

describe('プラグインの並び', () => {
  it('素の改行の段は、いちばん後ろ', () => {
    // 他のプラグインが組み立て終わった木に対して働かせる。途中に挟むと
    // 「誰が作ったノードを見ているのか」が並びに依存して読めなくなる（設計§2）
    expect(REMARK_PLUGINS.at(-1)).toBe(remarkSoftBreaks)
  })

  it('`<br/>` の段は rehype 側に居る', () => {
    expect(REHYPE_PLUGINS).toEqual([rehypeLineBreaks])
  })
})

describe('しきい値の既定', () => {
  it('1000 文字', () => {
    // 実装・設計・実機で確定した値の3つがずれると、どれが正なのか分からなくなる
    expect(BODY_FOLD_LIMIT).toBe(1000)
  })
})

describe('絵文字を割らない', () => {
  it('しきい値の境目に絵文字が跨っても、末尾が壊れない', () => {
    // **1行目がしきい値より長いときだけ通る道。** 行の切れ目へ戻せないので、
    // そのまま切ることになる——素の `slice` はサロゲートペアの途中で切れて
    // 末尾に `�` が出る（コードレビュー対応12）
    const 絵文字 = '🙂'
    // 境目のちょうど上に絵文字の**上位**が来るように詰める
    const text = 'a'.repeat(9) + 絵文字.repeat(10)
    const { head, folded } = foldMarkdown(text, 10)

    expect(folded).toBe(true)
    expect(head).not.toContain('�')
    // 割れていない＝そのまま読み戻せる
    expect([...head].every((ch) => ch === 'a' || ch === 絵文字)).toBe(true)
  })

  it('絵文字を含まない本文の畳み方は変わらない', () => {
    const text = ['一行目', '二行目', '三行目'].join('\n')
    // 行の切れ目まで戻すので、2行目までが残る（この振る舞いは変えていない）
    expect(foldMarkdown(text, 8).head).toBe('一行目\n二行目')
  })
})
