import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, movedTooFar, pressMapping } from './press'

/**
 * 押し方の割り当て（並べ替え設計§4-1・§15-5）。
 *
 * **判定を1箇所に集めたことの担保。** ここが正しければ、コンポーネント側は
 * `if (coarse)` を1つも書かずに済む。
 *
 * 触る画面の答えは**3通り**——何も選んでいなければ `'open'`、同格なら `'select'`、
 * それ以外は `'clear'`（選択を解くだけ。遷移しない）。**組み合わせを潰すのはここ**で、
 * DOM を通す側（`usePress.test.tsx`）は配線だけを見る。
 */

describe('PC', () => {
  it('シングルで選び、ダブルで開く', () => {
    expect(pressMapping(false, null, 'card')).toEqual({
      single: 'select',
      doubleOpens: true,
      longPressSelects: false,
    })
  })

  it('選択の有無でも種類でも、選べるかどうかでも変わらない', () => {
    // **PC に選択モードという概念は無い**——修飾キー無しでシングルが「選ぶ」。
    // 触る画面だけを直したので、**ここが動いていないことが完了条件4**
    for (const selecting of ['card', 'project', null] as const) {
      for (const selectable of [true, false]) {
        expect(pressMapping(false, selecting, 'card', selectable)).toEqual({
          single: 'select',
          doubleOpens: true,
          longPressSelects: false,
        })
        expect(pressMapping(false, selecting, 'project', selectable)).toEqual({
          single: 'select',
          doubleOpens: true,
          longPressSelects: false,
        })
      }
    }
  })
})

describe('触る画面', () => {
  it('1つも選んでいなければ、シングルで開く', () => {
    expect(pressMapping(true, null, 'card')).toEqual({
      single: 'open',
      doubleOpens: false,
      longPressSelects: true,
    })
  })

  it('同じ種類を選んでいるときだけ、シングルが「選ぶ」に変わる', () => {
    expect(pressMapping(true, 'card', 'card').single).toBe('select')
    expect(pressMapping(true, 'project', 'project').single).toBe('select')
  })

  it('別の種類を押したら、選択を解くだけ（開かない）', () => {
    /*
      **直す前は `'open'` を返していた**——カードを選んだ状態で枠の余白をタップすると
      PJT 専用画面へ飛び、選んでいたものも見ていた場所も失われた。選択を解こうとする
      操作は「やめる」側なので、**外したときに何も起きないほうへ倒す**
      （2026-09-07・利用者の指定）。

      **却下された「別の種類も選ぶ」案とは別物。** あちらは押した相手が選ばれるので、
      押そうとしたボタンが消えたうえ別のボタンへ入れ替わる。こちらは何も選ばれない。
    */
    expect(pressMapping(true, 'card', 'project').single).toBe('clear')
    expect(pressMapping(true, 'project', 'card').single).toBe('clear')
  })

  it('選べない箱も、選択中は解くだけ', () => {
    /*
      **選べる箱と選べない箱は、画面上で見分けが付かない。** 選べないほうだけ遷移すると
      「同じに見えるものが、あるときは飛び、あるときは飛ばない」——直す前より悪い。
      死んだ領域にはならない（押せば帯が消え、もう一度押せば開く）。
    */
    expect(pressMapping(true, 'card', 'card', false).single).toBe('clear')
    expect(pressMapping(true, 'project', 'project', false).single).toBe('clear')
  })

  it('1つも選んでいなければ、選べない箱でも開く', () => {
    // 遷移が消えるのは**選択中だけ**。選んでいなければ、いままでどおり
    expect(pressMapping(true, null, 'project', false).single).toBe('open')
    expect(pressMapping(true, null, 'card', false).single).toBe('open')
  })

  it('ダブルは使わない（端末の拡大と取り合う）', () => {
    // **「解くだけ」の状態も含めて、どの組み合わせでも使わない。** ここが緩むと
    // 端末の拡大と取り合いが復活する
    expect(pressMapping(true, null, 'card').doubleOpens).toBe(false)
    expect(pressMapping(true, 'card', 'card').doubleOpens).toBe(false)
    expect(pressMapping(true, 'card', 'project').doubleOpens).toBe(false)
    expect(pressMapping(true, 'project', 'project', false).doubleOpens).toBe(false)
  })

  it('選べる箱なら、どの状態でも長押しで選べる', () => {
    // **種類をまたいでも長押しは死なない**——掴んで運ぶ道がここに乗っている
    for (const selecting of ['card', 'project', null] as const) {
      expect(pressMapping(true, selecting, 'card').longPressSelects).toBe(true)
    }
  })

  it('選べない箱は、長押しでも選べない', () => {
    // **規則をここ1箇所に持たせた**（以前は `usePress` 側の分岐だけが持っていた）
    for (const selecting of ['card', 'project', null] as const) {
      expect(pressMapping(true, selecting, 'project', false).longPressSelects).toBe(false)
    }
  })
})

describe('長押しの実値', () => {
  it('400ms・8px（実機で決め直す）', () => {
    expect(LONG_PRESS_MS).toBe(400)
    expect(LONG_PRESS_SLOP_PX).toBe(8)
    expect(movedTooFar(8, 0)).toBe(false)
    expect(movedTooFar(9, 0)).toBe(true)
    expect(movedTooFar(6, 6)).toBe(true)
  })
})
