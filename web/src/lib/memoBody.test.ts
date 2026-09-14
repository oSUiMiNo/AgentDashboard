import { describe, expect, it } from 'vitest'

import { readMemoBody, sameMemoBody, 画像の幅 } from '@/lib/memoBody'

/*
  **`unknown` から読むところは、機械が何も守らない。**

  サーバは `body` を JSON のまま持ち、中身を読まない。したがって形が違うものが
  返ってくる余地が型の上では常にある——古い版が書いたもの、手で書き換えられたもの。

  **1件が読めないことより、面ごと出なくなることのほうが悪い。** だから「倒れない」
  ことをここで固定する。倒れ方を変える改修が入ったら、ここが落ちる。
*/
describe('readMemoBody', () => {
  it('揃っていれば、そのまま読む', () => {
    const body = readMemoBody({ blocks: [{ type: 'paragraph' }], markdown: '# あとで' })
    expect(body.blocks).toHaveLength(1)
    expect(body.markdown).toBe('# あとで')
  })

  it.each([
    ['null', null],
    ['数値', 42],
    ['文字列', 'ただの字'],
    ['配列', [1, 2]],
    ['空の物', {}],
    ['blocks が配列でない', { blocks: 'いいえ', markdown: 'あ' }],
    ['markdown が文字列でない', { blocks: [], markdown: 42 }],
  ])('%s が来ても倒れない', (_名, 入力) => {
    expect(() => readMemoBody(入力)).not.toThrow()
    const body = readMemoBody(入力)
    expect(Array.isArray(body.blocks)).toBe(true)
    expect(typeof body.markdown).toBe('string')
  })

  it('片方だけ読めるなら、読めるほうは活かす', () => {
    // **全部捨てない。** 表示できる字があるなら出す
    expect(readMemoBody({ blocks: 'こわれ', markdown: '読める' }).markdown).toBe('読める')
  })
})

describe('sameMemoBody', () => {
  it('同じなら真', () => {
    const a = { blocks: [{ id: '1' }], markdown: 'あ' }
    const b = { blocks: [{ id: '1' }], markdown: 'あ' }
    expect(sameMemoBody(a, b)).toBe(true)
  })

  it('字が違えば偽', () => {
    expect(
      sameMemoBody({ blocks: [], markdown: 'あ' }, { blocks: [], markdown: 'い' }),
    ).toBe(false)
  })

  /*
    **要素まで検証する**（レビュー対応8）。

    以前は `Array.isArray` しか見ておらず、**要素が不正でも配列でありさえすれば
    通した**。その配列はエディタへそのまま渡り、**描画の最中に投げる**——この web
    にはエラー境界が1つも無いので**面が丸ごと消える**。

    **`readMemoBody` が防ごうとした壊れ方が、鉛筆を押した経路から戻ってくる形**
    だった。
  */
  it('ブロックの形をしていない要素は捨てる。ただし残りは出す', () => {
    const 読んだ = readMemoBody({
      blocks: [
        { type: 'paragraph' },
        null,
        'ただの字',
        42,
        { type: 42 },
        {},
        { type: 'heading' },
      ],
      markdown: 'あ',
    })

    // **倒れない形は保つ。** 1件を捨てて残りを出す
    expect(読んだ.blocks).toEqual([{ type: 'paragraph' }, { type: 'heading' }])
    expect(読んだ.markdown).toBe('あ')
  })

  it('字が同じでもブロックが違えば偽', () => {
    // 見た目が同じでも中身が違えば別物——**確定したときに記録が動くべきかの判定**なので、
    // 見た目だけで同じとみなすと、構造だけ直した編集が保存されない
    expect(
      sameMemoBody(
        { blocks: [{ type: 'paragraph' }], markdown: 'あ' },
        { blocks: [{ type: 'heading' }], markdown: 'あ' },
      ),
    ).toBe(false)
  })
})

/*
  **確定した本文に、画像の幅が書いていない**（利用者の報告・2026-09-14「編集画面で
  画像幅を変えても、確定済みのビューを見ると常に横幅いっぱいに表示されている」）。

  幅を持っているのは `blocks` のほうで、Markdown へ変換するときに落ちる。
  **落ちたものを表示のたびに拾い直す**のがこの関数なので、拾い漏れると
  「常に横幅いっぱい」が戻る。
*/
describe('画像の幅', () => {
  function 画像(url: string, previewWidth?: number): unknown {
    const props: Record<string, unknown> = { url, name: 'image.png' }
    if (previewWidth !== undefined) {
      props.previewWidth = previewWidth
    }
    return { type: 'image', props }
  }

  it('幅を変えた画像は、URL から幅が引ける', () => {
    // **実測した記録に入っていた値**（`/api/memo-blobs/<UUID>` と 197px）
    const 表 = 画像の幅([画像('/api/memo-blobs/48b5d4c5', 197)])
    expect(表.get('/api/memo-blobs/48b5d4c5')).toBe(197)
  })

  it('幅を変えていない画像は、表に載らない', () => {
    /*
      **載せてはいけない。** 幅を変えていない画像には `previewWidth` が無く
      （実測）、そのときは元の大きさで描くのが正しい——勝手に幅を与えると、
      いままで正しく出ていた画像まで別の大きさになる。
    */
    expect(画像の幅([画像('/api/memo-blobs/f082e1e2')]).size).toBe(0)
  })

  it('1枚ずつ別の幅を持てる', () => {
    const 表 = 画像の幅([画像('/a', 197), 画像('/b', 246)])
    expect(表.get('/a')).toBe(197)
    expect(表.get('/b')).toBe(246)
  })

  it('入れ子に置いた画像も拾う', () => {
    /*
      **箇条書きの項目の下などに画像を置ける。** 最上位しか見ないと、そこに
      置いた1枚だけ幅が戻らない——**直った絵と直らない絵が混ざる**ほうが、
      全部直らないより分かりにくい。
    */
    const 表 = 画像の幅([{ type: 'bulletListItem', props: {}, children: [画像('/深い', 163)] }])
    expect(表.get('/深い')).toBe(163)
  })

  it('壊れていても倒れない', () => {
    /*
      **記録から来るものは何の形でもありうる**（この模組の他の関数と同じ約束）。
      幅が引けないだけなら、幅が無かったときと同じに描けばよい。
    */
    expect(() =>
      画像の幅([
        null,
        'ただの字',
        { type: 'image' },
        { type: 'image', props: null },
        { type: 'image', props: { url: '', previewWidth: 100 } },
        { type: 'image', props: { url: '/x', previewWidth: '197' } },
        { type: 'image', props: { url: '/y', previewWidth: 0 } },
        { type: 'image', props: { url: '/z', previewWidth: Number.NaN } },
      ]),
    ).not.toThrow()
    expect(画像の幅([{ type: 'image', props: { url: '/x', previewWidth: '197' } }]).size).toBe(0)
    expect(画像の幅([{ type: 'image', props: { url: '/y', previewWidth: 0 } }]).size).toBe(0)
  })
})
