import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, movedTooFar, pressMapping } from './press'

/**
 * 押し方の割り当て（並べ替え設計§4-1・§15-5）。
 *
 * **判定を1箇所に集めたことの担保。** ここが正しければ、コンポーネント側は
 * `if (coarse)` を1つも書かずに済む。
 *
 * 答えは**3通り**——同格なら `'select'`、何か選んでいて同格でなければ `'clear'`
 * （選択を解くだけ）、1つも選んでいなければ触る画面は `'open'`・PC は `'select'`。
 * **「解くだけ」の条件は PC と触る画面で同じ**（2026-09-08 に揃えた）。
 * **組み合わせを潰すのはここ**で、DOM を通す側（`usePress.test.tsx`）は配線だけを見る。
 */

describe('PC', () => {
  it('シングルで選び、ダブルで開く', () => {
    expect(pressMapping(false, null, 'card')).toEqual({
      single: 'select',
      doubleOpens: true,
      longPressSelects: false,
    })
  })

  it('同じ種類を選んでいる間も、いままでどおり「選ぶ」', () => {
    expect(pressMapping(false, 'card', 'card').single).toBe('select')
    expect(pressMapping(false, 'project', 'project').single).toBe('select')
  })

  it('別の種類を選んでいる間は、解くだけ', () => {
    /*
      **2026-09-08 に、前の決定を覆した。** それまでは PC を変えないと決めていた
      ——「PC は遷移しないので事故が起きない」というのが理由だった。**遷移だけが
      事故ではない**：押した瞬間に帯の中身が入れ替わり、**押そうとしていたボタンが
      別のボタンになる**（§5-1 が禁じた事象そのもの）。

      **1回で2つのことが起きるほうが損**——解除と選択が同時に走ると、どちらを
      頼んだのか画面から読めない。
    */
    expect(pressMapping(false, 'card', 'project').single).toBe('clear')
    expect(pressMapping(false, 'project', 'card').single).toBe('clear')
  })

  it('選べない箱も、選択中は解くだけ', () => {
    expect(pressMapping(false, 'card', 'card', false).single).toBe('clear')
    expect(pressMapping(false, 'project', 'project', false).single).toBe('clear')
  })

  it('1つも選んでいなければ、選べない箱でも「選ぶ」', () => {
    /*
      実際に選ぶのは `usePress` 側が止めるので、**PC のシングルでは何も起きない**。
      **これは死んだ領域ではない**——PC で開くのはダブルなので、押す道は残っている。
      触る画面が「解くだけ」まで用意しているのは、あちらはシングルが唯一の押し方で、
      何も起きないと**壊れているのと見分けが付かない**ためである。
    */
    expect(pressMapping(false, null, 'project', false).single).toBe('select')
  })

  it('ダブルで開く道と、長押しを使わないことは、どの状態でも変わらない', () => {
    // **直したのはシングルだけ。** ここが動くと「ダブルで開く」が崩れる
    for (const selecting of ['card', 'project', null] as const) {
      for (const selectable of [true, false]) {
        const mapping = pressMapping(false, selecting, 'card', selectable)
        expect(mapping.doubleOpens).toBe(true)
        expect(mapping.longPressSelects).toBe(false)
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

  it('「解くだけ」の状態でも、長押しは選べる（これが1動作の選び直し）', () => {
    /*
      **タップは「解くだけ」でも、長押しは選び直す。** 素通りしているのではなく、
      **別の操作として意図してそうしている**——長押しは「これを選ぶ」と名指しする
      操作なので、押し間違いの話が当てはまらない。**触る画面で1動作の選び直しが
      できるのはこの道だけ**で、掴んで運ぶ道もここに乗っている。
    */
    for (const selecting of ['card', 'project', null] as const) {
      expect(pressMapping(true, selecting, 'card').longPressSelects).toBe(true)
    }
    // 「解くだけ」を返す組み合わせでも生きている
    expect(pressMapping(true, 'project', 'card').single).toBe('clear')
    expect(pressMapping(true, 'project', 'card').longPressSelects).toBe(true)
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
