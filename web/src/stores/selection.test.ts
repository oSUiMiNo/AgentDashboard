import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSelection,
  clearSelectionStore,
  getSelection,
  isSelected,
  isSelecting,
  restoreSelection,
  select,
  toggleSelect,
} from './selection'

/**
 * 選んでいるものの持ち方（並べ替え設計§5-1・§5-6）。
 */

beforeEach(() => {
  clearSelectionStore()
})

describe('押すたびに増え、もう一度押すと外れる', () => {
  it('修飾キー無しで足せる', () => {
    toggleSelect('card', 'a')
    toggleSelect('card', 'b')
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a', 'b'] })
  })

  it('同じものをもう一度押すと外れる', () => {
    toggleSelect('card', 'a')
    toggleSelect('card', 'b')
    toggleSelect('card', 'a')
    expect(getSelection()).toEqual({ kind: 'card', ids: ['b'] })
  })

  it('1つも無くなったら種類ごと捨てる', () => {
    // 残すと、次に別の種類を押したときに「選び直し」なのか「足す」なのかが
    // 選択の中身で変わる
    toggleSelect('card', 'a')
    toggleSelect('card', 'a')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(isSelecting()).toBe(false)
  })
})

describe('枠とカードを混ぜない', () => {
  it('違う種類を押すと、そちらへ選び直す', () => {
    /*
      **ここは policy を持たない。** 一覧の押し方としては「別の種類なら解くだけ」が
      正だが、それを決めるのは `lib/press.ts` の `pressMapping` で、**ここまで来る前に
      振り分けられている**。

      いったんこの関数を「違う種類なら解く」へ書き換えたが、戻した——**押し方を通らない
      呼び出し元まで巻き添えになる**（`GroupView` の掴み手のタップが、選ぶのをやめて
      解くようになっていた）。

      混ぜない、という決まりそのものは変わらない。電源マークはカードにしか意味を
      持たないので、帯が選択の中身で出たり消えたりしてはいけない。
    */
    toggleSelect('card', 'a')
    toggleSelect('card', 'b')
    toggleSelect('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
    expect(isSelected('card', 'a')).toBe(false)
  })
})

describe('押す前へ戻す', () => {
  it('中身が同じなら、何も起きない', () => {
    toggleSelect('card', 'a')
    const 前 = getSelection()
    restoreSelection({ kind: 'card', ids: ['a'] })
    // 同じ中身なら作り直さない（描き直しを増やさない）
    expect(getSelection()).toBe(前)
  })

  it('別の種類の選択へも戻せる', () => {
    toggleSelect('card', 'a')
    restoreSelection({ kind: 'project', ids: ['p1', 'p2'] })
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1', 'p2'] })
  })

  it('空へ戻すと、種類ごと捨てる', () => {
    toggleSelect('card', 'a')
    restoreSelection({ kind: null, ids: [] })
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(isSelecting()).toBe(false)
  })
})

describe('選択モードから出る道', () => {
  it('全部外せる', () => {
    toggleSelect('card', 'a')
    clearSelection()
    expect(isSelecting()).toBe(false)
  })
})

describe('必ず選ぶ', () => {
  it('選んでいないものは足す', () => {
    select('card', 'a')
    select('card', 'b')
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a', 'b'] })
  })

  it('既に選んでいるものは外さない', () => {
    // `toggleSelect` なら外れる。**長押しで掴むときは外れてはいけない**（並べ替え設計§15-5）
    toggleSelect('card', 'a')
    select('card', 'a')
    expect(isSelected('card', 'a')).toBe(true)
  })

  it('違う種類なら選び直す', () => {
    /*
      長押しは「これを選ぶ」と名指しする操作なので、押し間違いの話が当てはまらない
      ——**触る画面では、これが1動作で種類を選び直す道**である（タップは「解くだけ」
      なので2回要る）。
    */
    toggleSelect('card', 'a')
    select('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
  })
})
