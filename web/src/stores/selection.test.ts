import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSelection,
  clearSelectionStore,
  getSelection,
  isSelected,
  isSelecting,
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
  it('違う種類を押すと、乗り換えずに解けるだけ', () => {
    /*
      **2026-09-08 に、乗り換えをやめた**（それまでは「そちらへ選び直す」だった）。
      1回の押しで**もとの選択が消えるのと、押した相手が選ばれるのが同時に走る**ので、
      どちらを頼んだのか画面から読めない。しかも帯の中身が入れ替わって、
      **押そうとしていたボタンが別のボタンになる**。

      混ぜない、という決まりそのものは変わっていない——電源マークはカードにしか
      意味を持たないので、帯が選択の中身で出たり消えたりしてはいけない。
    */
    toggleSelect('card', 'a')
    toggleSelect('card', 'b')
    toggleSelect('project', 'p1')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(isSelected('project', 'p1')).toBe(false)
  })

  it('解けたあと、もう一度押せば選べる', () => {
    // **選び直したい人は2回押す。** 近道は作らない
    toggleSelect('card', 'a')
    toggleSelect('project', 'p1')
    toggleSelect('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
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
      **こちらは乗り換えたまま**（`toggleSelect` は 2026-09-08 に乗り換えをやめた）。
      長押しは「これを選ぶ」と名指しする操作なので押し間違いの話が当てはまらず、
      **触る画面では、これが1動作で種類を選び直す唯一の道**である。
    */
    toggleSelect('card', 'a')
    select('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
  })
})
