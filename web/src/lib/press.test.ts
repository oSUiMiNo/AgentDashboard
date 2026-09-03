import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, movedTooFar, pressMapping } from './press'

/**
 * 押し方の割り当て（並べ替え設計§4-1・§15-5）。
 *
 * **判定を1箇所に集めたことの担保。** ここが正しければ、コンポーネント側は
 * `if (coarse)` を1つも書かずに済む。
 */

describe('PC', () => {
  it('シングルで選び、ダブルで開く', () => {
    expect(pressMapping(false, null, 'card')).toEqual({
      single: 'select',
      doubleOpens: true,
      longPressSelects: false,
    })
  })

  it('選択の有無でも種類でも変わらない', () => {
    // **PC に選択モードという概念は無い**——修飾キー無しでシングルが「選ぶ」
    for (const selecting of ['card', 'project', null] as const) {
      expect(pressMapping(false, selecting, 'card')).toEqual(pressMapping(false, null, 'card'))
      expect(pressMapping(false, selecting, 'project')).toEqual(pressMapping(false, null, 'card'))
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
    /*
      **選択モードの単位は「同格の集合」**（設計§15-5）。カードを選んでいても枠は
      「開く」のまま——種類を問わずに変えると、カードを選んだ状態で枠をタップした
      瞬間に**カードの選択が消え、枠が選ばれ、帯の電源が消える**。
    */
    expect(pressMapping(true, 'card', 'card').single).toBe('select')
    expect(pressMapping(true, 'project', 'project').single).toBe('select')
    expect(pressMapping(true, 'card', 'project').single).toBe('open')
    expect(pressMapping(true, 'project', 'card').single).toBe('open')
  })

  it('ダブルは使わない（端末の拡大と取り合う）', () => {
    expect(pressMapping(true, null, 'card').doubleOpens).toBe(false)
    expect(pressMapping(true, 'card', 'card').doubleOpens).toBe(false)
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
