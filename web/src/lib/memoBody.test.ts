import { describe, expect, it } from 'vitest'

import { readMemoBody, sameMemoBody } from '@/lib/memoBody'

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
