import { describe, expect, it } from 'vitest'
import {
  clearMatches,
  findMatches,
  findTextMatches,
  paintMatches,
  scrollOffsetFor,
  supportsHighlight,
} from '@/lib/fileSearch'

/**
 * 開いているファイルの中を探す（`ファイルビュアの中を Ctrl+F で探せるようにする` 要件）。
 *
 * **機械で確かめられるのは「どこを当たりと数えたか」までである。** 印が実際に描かれるか
 * は `CSS.highlights` が jsdom に無いので確かめられない——**そこは実機で見る**
 * （テスト計画フェーズ5-1）。
 */
function 箱(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

/** 当たりが指している字を取り出す。**位置が合っているかは、これで初めて言える** */
function 当たりの字(ranges: Range[]): string[] {
  return ranges.map((r) => r.toString())
}

describe('lib/fileSearch', () => {
  describe('探す', () => {
    it('当たりを位置ごと返す', () => {
      const el = 箱('<p>計画を立てる</p>')
      expect(当たりの字(findMatches(el, '計画'))).toEqual(['計画'])
    })

    it('同じ語が何度出ても、その数だけ返る', () => {
      const el = 箱('<p>あか あか あか</p>')
      expect(findMatches(el, 'あか')).toHaveLength(3)
    })

    it('大文字小文字を区別しない', () => {
      const el = 箱('<p>Hello WORLD hello</p>')
      expect(findMatches(el, 'hello')).toHaveLength(2)
      expect(findMatches(el, 'WoRlD')).toHaveLength(1)
    })

    it('要素をまたいだ語にも当たる', () => {
      /*
        **ここがテキストノードを1つずつ探す作りとの分かれ目。** 整形すると
        `**太**字` のように語が割れるので、1つずつでは当たらない。
      */
      const el = 箱('<p><b>太</b>字である</p>')
      const 当たり = findMatches(el, '太字')
      expect(当たり).toHaveLength(1)
      expect(当たり[0]!.toString()).toBe('太字')
    })

    it('空の語では1つも返らない', () => {
      // 全文が当たりになると、打っている途中で画面じゅうへ印が付く
      const el = 箱('<p>なにか</p>')
      expect(findMatches(el, '')).toEqual([])
    })

    it('当たりが無ければ空', () => {
      expect(findMatches(箱('<p>あ</p>'), 'ん')).toEqual([])
    })

    it('DOM を1つも書き換えない', () => {
      // **`<mark>` を差し込む形にしない。** 整形と取り合いになる
      const el = 箱('<p>計画を立てる</p><ul><li>あ</li></ul>')
      const 前 = el.innerHTML
      findMatches(el, '計画')
      expect(el.innerHTML).toBe(前)
    })

    it('重なった当たりを二重に数えない', () => {
      // `ああ` を `あああ` から探すと1つ。**進める幅が語の長さ**であることの担保
      expect(findMatches(箱('<p>あああ</p>'), 'ああ')).toHaveLength(1)
    })
  })

  describe('印', () => {
    it('描けない環境では、何もせずに黙る', () => {
      /*
        jsdom に `CSS.highlights` は無い。**ここが投げると、この画面の単体テストが
        1本残らず落ちる。**
      */
      expect(supportsHighlight()).toBe(false)
      expect(() => paintMatches(findMatches(箱('<p>あ</p>'), 'あ'), 0)).not.toThrow()
      expect(() => clearMatches()).not.toThrow()
    })
  })

  describe('送り先の位置', () => {
    /*
      **矩形の数値だけを受け取る純関数。** `getBoundingClientRect` をこの中で呼ぶと、
      jsdom が固定値を返すので**何も確かめないまま緑になる**。
    */
    const 箱の矩形 = { top: 100, height: 400 }

    it('当たりが下にあると、送りが増える', () => {
      const 先 = scrollOffsetFor(箱の矩形, { top: 600, height: 20 }, 0)
      expect(先).toBeGreaterThan(0)
    })

    it('当たりが上にあると、送りが減る', () => {
      const 先 = scrollOffsetFor(箱の矩形, { top: -50, height: 20 }, 300)
      expect(先).toBeLessThan(300)
    })

    it('既に見えていれば動かさない', () => {
      // 隣り合った当たりを行き来しただけで文章が上下に跳ねないこと
      expect(scrollOffsetFor(箱の矩形, { top: 200, height: 20 }, 42)).toBe(42)
    })

    it('負の位置へは送らない', () => {
      expect(
        scrollOffsetFor(箱の矩形, { top: -1000, height: 20 }, 0),
      ).toBeGreaterThanOrEqual(0)
    })
  })
})

/**
 * 打つ層（`<textarea>`）のための道（`ファイルビュアにエディタ機能を追加` 設計§5-4）。
 *
 * **値の中の位置で持つ。** `Range` を張れないし、下に敷いた色の層は色付けのたびに
 * 作り直されるので、張っても残らない。
 */
describe('lib/fileSearch の findTextMatches', () => {
  it('当たった位置の対を、前から順に返す', () => {
    expect(findTextMatches('あかあおあか', 'あか')).toEqual([
      [0, 2],
      [4, 6],
    ])
  })

  it('空の語では1つも返さない', () => {
    expect(findTextMatches('あかあお', '')).toEqual([])
  })

  it('重なる当たりは、進めた先から数える', () => {
    // `aaaa` の中の `aa` は 0-2 と 2-4 の2つ（1-3 は数えない）
    expect(findTextMatches('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('大文字小文字を区別しない', () => {
    expect(findTextMatches('Hello hello', 'HELLO')).toEqual([
      [0, 5],
      [6, 11],
    ])
  })

  /**
   * **どちらの道でも同じ数が当たる**ことを、同じ字で確かめる。
   *
   * 畳み方がずれると、**見る姿とエディタで件数が食い違う**——利用者からは
   * 「同じファイルなのに数が違う」としか見えず、原因に辿り着けない。
   */
  it('DOM を遡る道と、同じ字に同じ数だけ当たる', () => {
    const 字 = 'Foo foo FOO'
    const 箱 = document.createElement('div')
    箱.textContent = 字
    expect(findTextMatches(字, 'foo')).toHaveLength(findMatches(箱, 'foo').length)
  })

  it('改行をまたいでも位置がずれない', () => {
    expect(findTextMatches('one\ntwo\nthree', 'two')).toEqual([[4, 7]])
  })
})
