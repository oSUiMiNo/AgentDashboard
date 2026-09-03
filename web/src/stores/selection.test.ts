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
  it('違う種類を押すと、そちらへ選び直す', () => {
    // 混ぜられると、まとめて操作の帯に出すボタンが選択の中身で出たり消えたりする
    // ——電源マークはカードにしか意味を持たない
    toggleSelect('card', 'a')
    toggleSelect('card', 'b')
    toggleSelect('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
    expect(isSelected('card', 'a')).toBe(false)
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
    toggleSelect('card', 'a')
    select('project', 'p1')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
  })
})
