import type { Element, Root } from 'hast'
import type { PhrasingContent, Root as MdastRoot } from 'mdast'
import {
  type ActivitySummaryInput,
  BODY_FOLD_GRACE_LINES,
  BODY_FOLD_LINES,
  BODY_FOLD_LINES_EXCESSIVE,
  BODY_FOLD_LINES_MINIMAL,
  NOMINAL_COLUMNS,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  activitySummary,
  effectiveLines,
  foldDecision,
  foldMarkdown,
  foldMarkdownByLines,
  rehypeLineBreaks,
  remarkSoftBreaks,
  splitLineBreaks,
  splitSoftBreaks,
  summarizeInput,
} from './markdown'

/**
 * 本文の畳み方と `<br>` の読み替え（テスト計画フェーズ2）。
 *
 * ここで守るべき約束は2つ。
 * - **切った位置がマークダウンを壊さない**（長い応答こそ畳まれる側なので、壊れると被害が大きい）
 * - **`<br/>` だけを改行にし、それ以外の HTML は落とさない**（消えたことに気づけない側へ倒さない）
 *
 * 切る位置は**小さいしきい値を渡して**確かめる。既定の 75行で試すと、境目を作るためだけに
 * 75行の本文を書くことになり、**どこで切れたのかがテストから読めなくなる**。
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
  it('実装・設計・実機で同じ値', () => {
    // 3つがずれると、どれが正なのか分からなくなる。動かしたら `設計.md` §4 も直すこと
    expect(NOMINAL_COLUMNS).toBe(80)
    expect(BODY_FOLD_LINES).toBe(75)
    expect(BODY_FOLD_LINES_EXCESSIVE).toBe(200)
    expect(BODY_FOLD_LINES_MINIMAL).toBe(10)
    expect(BODY_FOLD_GRACE_LINES).toBe(5)
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

/**
 * 量の測り方（イシューグループ_2026-0820-2129 テスト計画フェーズ2）。
 *
 * ここで守るべき約束は3つ。
 * - **数えるのは縦の高さ**であって文字数ではない（要望5）
 * - **画面の幅を見ない**。見ると同じ本文が端末によって違うところで畳まれる（設計§4-1）
 * - **長いほど短く畳まれる**のは意図である（要望6・設計§4-3）
 */
describe('実効行数の数え方', () => {
  it('空行も1行と数える', () => {
    // 空行は縦の高さを食うので、数えないと「短い」と誤って判定する
    expect(effectiveLines('あ\n\nい')).toBe(3)
    expect(effectiveLines('\n\n\n')).toBe(4)
  })

  it('改行を打たない長い散文が、代表幅で割った行数として数えられる', () => {
    // **文字数で測っていたときに拾えなかったもの。** 素朴に見れば1行だが、実際は折り返す
    const 散文 = 'a'.repeat(NOMINAL_COLUMNS * 3)
    expect(散文.split('\n')).toHaveLength(1)
    expect(effectiveLines(散文)).toBe(3)
  })

  it('端数は切り上げる', () => {
    expect(effectiveLines('a'.repeat(NOMINAL_COLUMNS + 1))).toBe(2)
    expect(effectiveLines('a'.repeat(NOMINAL_COLUMNS))).toBe(1)
  })

  it('囲みコードと表を含んでいても、行の種類で重みを変えない', () => {
    // 素朴に数える。種類で重みを付けると「なぜこの本文だけ畳まれたか」が説明できなくなる
    const 囲み = ['```ts', 'const a = 1', '```'].join('\n')
    const 表 = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    const 素 = ['あ', 'い', 'う'].join('\n')

    expect(effectiveLines(囲み)).toBe(3)
    expect(effectiveLines(表)).toBe(3)
    expect(effectiveLines(素)).toBe(3)
  })

  it('画面の幅を一切見ていない', () => {
    // 代表幅は定数。引数にも環境にも依存しない（設計§4-1）
    expect(effectiveLines.length).toBe(1)
    expect(NOMINAL_COLUMNS).toBe(80)
  })
})

/** 実効行数がちょうど `count` 行になる本文を作る。 */
function linesOf(count: number): string {
  return Array.from({ length: count }, () => 'あ').join('\n')
}

describe('しきい値の3段と猶予', () => {
  const 境目 = BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES

  it('しきい値ちょうどは畳まない', () => {
    expect(foldDecision(linesOf(BODY_FOLD_LINES)).fold).toBe(false)
  })

  it('猶予の中は畳まない', () => {
    // **上の端だけを見ていると、猶予そのものを消しても気づけない**（壊し方2と1が
    // 同じ落ち方になる）。中を1つ突いておく
    expect(foldDecision(linesOf(BODY_FOLD_LINES + 1)).fold).toBe(false)
  })

  it('しきい値＋猶予ちょうどは畳まない', () => {
    // `>` と `>=` の取り違えをここで固定する
    expect(foldDecision(linesOf(境目)).fold).toBe(false)
  })

  it('しきい値＋猶予＋1で初めて畳む', () => {
    const decision = foldDecision(linesOf(境目 + 1))
    expect(decision.fold).toBe(true)
    expect(decision.lines).toBe(BODY_FOLD_LINES)
  })

  it('2段目の境目ちょうどは1段目の量で畳み、＋1で2段目の量へ落ちる', () => {
    expect(foldDecision(linesOf(BODY_FOLD_LINES_EXCESSIVE)).lines).toBe(BODY_FOLD_LINES)
    expect(foldDecision(linesOf(BODY_FOLD_LINES_EXCESSIVE + 1)).lines).toBe(BODY_FOLD_LINES_MINIMAL)
  })

  it('2段目のほうが見せる量が少ない（長いほど短く畳まれるのは意図）', () => {
    // 知らずに見ると不具合に見えるので、意図であることをここでも固定する（設計§4-3）
    expect(BODY_FOLD_LINES_MINIMAL).toBeLessThan(BODY_FOLD_LINES)
    const ふつうに長い = foldDecision(linesOf(BODY_FOLD_LINES_EXCESSIVE)).lines
    const 度を超えて長い = foldDecision(linesOf(BODY_FOLD_LINES_EXCESSIVE + 1)).lines
    expect(度を超えて長い).toBeLessThan(ふつうに長い)
  })

  it('2段目に猶予を当てていない', () => {
    // 猶予を当てているなら、境目＋猶予までは1段目の量のままになるはず
    expect(foldDecision(linesOf(BODY_FOLD_LINES_EXCESSIVE + BODY_FOLD_GRACE_LINES)).lines).toBe(
      BODY_FOLD_LINES_MINIMAL,
    )
  })

  it('畳まないときは、本文の実効行数がそのまま返る', () => {
    expect(foldDecision(linesOf(10))).toEqual({ fold: false, lines: 10 })
  })

  it('本文の種別を見ていない（利用者の発言にも同じだけ効く）', () => {
    // 判定は本文だけを受け取る。種別ごとの分岐を作れない形にしてある（設計§4-6）
    expect(foldDecision.length).toBe(1)
  })
})

describe('行数で切る', () => {
  it('しきい値以下なら畳まない', () => {
    const text = linesOf(3)
    expect(foldMarkdownByLines(text, 5)).toEqual({ head: text, folded: false })
  })

  it('切る位置は行の切れ目へ寄る（文字数で切るときと同じ規則）', () => {
    const { head, folded } = foldMarkdownByLines('一行目\n二行目\n三行目', 2)
    expect(folded).toBe(true)
    expect(head).toBe('一行目\n二行目')
  })

  it('折り返す長い行は、代表幅ぶんだけ取ってから行の切れ目へ戻す', () => {
    const 長い行 = 'a'.repeat(NOMINAL_COLUMNS * 3)
    const { head, folded } = foldMarkdownByLines(`先頭\n${長い行}`, 2)
    expect(folded).toBe(true)
    // 1行目（先頭）＋長い行の1行ぶんが予算。戻せる切れ目は「先頭」の後ろ
    expect(head).toBe('先頭')
  })

  it('開いたままの囲みコードを閉じる（文字数で切るときと同じ）', () => {
    const text = ['```ts', 'const a = 1', 'const b = 2', '```'].join('\n')
    const { head } = foldMarkdownByLines(text, 2)
    expect(head.endsWith('```')).toBe(true)
  })

  it('畳んだ末尾に `…` を足さない', () => {
    const { head } = foldMarkdownByLines(linesOf(10), 3)
    expect(head).not.toContain('…')
  })
})

/**
 * まとめ行の文言（テスト計画フェーズ2・設計§3-1）。
 *
 * **並びを固定していること**がいちばん大事な約束である。出た順にすると、同じ内容でも
 * 並びが変わって読み比べられない。
 */
describe('まとめ行の文言', () => {
  const 空: ActivitySummaryInput = { edited: [], ran: 0, read: [], used: 0, unknown: 0 }

  it('1つなら名前、複数なら件数', () => {
    expect(activitySummary({ ...空, edited: ['auth.rs'] })).toBe('編集済み auth.rs')
    expect(activitySummary({ ...空, edited: ['a.rs', 'b.rs'] })).toBe('編集済み 2個のファイル')
    expect(activitySummary({ ...空, read: ['a.rs'] })).toBe('読み取り a.rs')
    expect(activitySummary({ ...空, read: ['a.rs', 'b.rs'] })).toBe('読み取り 2個のファイル')
  })

  it('ファイル名は末尾だけ', () => {
    expect(activitySummary({ ...空, edited: ['server/crates/core/src/auth.rs'] })).toBe(
      '編集済み auth.rs',
    )
    expect(activitySummary({ ...空, read: ['C:\\work\\notes.md'] })).toBe('読み取り notes.md')
  })

  it('コマンドは1件でも件数で書く', () => {
    // コマンドには短い名前が無い（コマンドそのものは長い）ため（設計§3-1）
    expect(activitySummary({ ...空, ran: 1 })).toBe('実行済み 1件のコマンド')
    expect(activitySummary({ ...空, ran: 6 })).toBe('実行済み 6件のコマンド')
  })

  it('その他と未知も件数で書く', () => {
    expect(activitySummary({ ...空, used: 1 })).toBe('使用済み 1個のツール')
    expect(activitySummary({ ...空, unknown: 2 })).toBe('未知のレコード 2件')
  })

  it('複数の種類が混ざったら `, ` で連なり、並びが固定される', () => {
    expect(
      activitySummary({ edited: ['a.rs', 'b.rs'], ran: 5, read: ['c.rs'], used: 1, unknown: 1 }),
    ).toBe('編集済み 2個のファイル, 実行済み 5件のコマンド, 読み取り c.rs, 使用済み 1個のツール, 未知のレコード 1件')
  })

  it('出た順に影響されない（同じ内容なら同じ文言）', () => {
    const 先に編集: ActivitySummaryInput = { ...空, edited: ['a.rs', 'b.rs'], ran: 5 }
    const 先に実行: ActivitySummaryInput = { ...空, ran: 5, edited: ['a.rs', 'b.rs'] }
    expect(activitySummary(先に編集)).toBe(activitySummary(先に実行))
    expect(activitySummary(先に編集)).toBe('編集済み 2個のファイル, 実行済み 5件のコマンド')
  })

  it('何も無ければ空になる', () => {
    expect(activitySummary(空)).toBe('')
  })
})

describe('子の1行の名前', () => {
  it('`description` をいちばん先に見る', () => {
    // Bash は `command` も持つ。**`description` が勝つ**のがこの節の変更点（設計§3-3）
    expect(
      summarizeInput({ command: 'git commit -m "..."', description: 'Committed stale-name fixes' }),
    ).toBe('Committed stale-name fixes')
  })

  it('`description` を訳さない', () => {
    // CLI が書いた文をそのまま見せるのが正直である（参考画面の実物が英語のまま）
    expect(summarizeInput({ description: 'Checked git state' })).toBe('Checked git state')
  })

  it('`description` が無ければ、これまでの順で決まる', () => {
    expect(summarizeInput({ file_path: 'a/b/auth.rs' })).toBe('a/b/auth.rs')
    expect(summarizeInput({ command: 'ls -la' })).toBe('ls -la')
    expect(summarizeInput({ pattern: 'foo' })).toBe('foo')
    expect(summarizeInput({ path: '/tmp' })).toBe('/tmp')
    expect(summarizeInput({ prompt: '調べて' })).toBe('調べて')
  })

  it('`file_path` より `description` が先（入れ替えたことの担保）', () => {
    expect(summarizeInput({ file_path: 'a.rs', description: '書いた' })).toBe('書いた')
  })

  it('どれも無ければ、そのまま JSON を出す', () => {
    expect(summarizeInput({ foo: 1 })).toBe('{"foo":1}')
  })

  it('オブジェクトでなければ空', () => {
    expect(summarizeInput(null)).toBe('')
    expect(summarizeInput('あ')).toBe('')
  })
})
