import { describe, expect, it } from 'vitest'
import {
  centerOf,
  moveItem,
  nearestIndex,
  NO_TARGET,
  passedThreshold,
  type Rect,
} from './reorder'

/**
 * 落とし先を決める規則（並べ替え設計§3-4・テスト計画フェーズ4）。
 *
 * **DOM を1つも読まない。** jsdom は要素の幅を常に 800・左端を常に 0 で返すので、
 * 測る側と混ざると**何も確かめていない状態で緑になる**。ここは矩形を字で書く。
 *
 * **期待値も字で書く。** 実装と同じ定数から組み立てると、定数が動いたときに
 * 期待値も一緒に動いて、通ったままになる。
 */

/** 左上と大きさから矩形を作るだけの助け（**実装の関数は使わない**）。 */
function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height }
}

describe('矩形の中心', () => {
  it('左上と大きさから出す', () => {
    expect(centerOf(rect(10, 20, 100, 40))).toEqual({ x: 60, y: 40 })
  })
})

describe('落とし先は、いちばん近い中心で決まる', () => {
  // 3つの並び方を**同じ関数**へ通す。次元ごとの分岐が無いことの担保

  it('縦1列（枠の並び）', () => {
    const rects = [rect(0, 0, 200, 100), rect(0, 100, 200, 100), rect(0, 200, 200, 100)]
    // 中心は y = 50 / 150 / 250
    expect(nearestIndex(rects, { x: 100, y: 10 })).toBe(0)
    expect(nearestIndex(rects, { x: 100, y: 140 })).toBe(1)
    expect(nearestIndex(rects, { x: 100, y: 999 })).toBe(2)
  })

  it('横1列（PJT 専用画面の区画）', () => {
    const rects = [rect(0, 0, 100, 300), rect(100, 0, 100, 300), rect(200, 0, 100, 300)]
    // 中心は x = 50 / 150 / 250
    expect(nearestIndex(rects, { x: 20, y: 150 })).toBe(0)
    expect(nearestIndex(rects, { x: 160, y: 150 })).toBe(1)
    expect(nearestIndex(rects, { x: 280, y: 150 })).toBe(2)
  })

  it('折り返しの2次元（一覧のカード）', () => {
    // 2列×2行。中心は (50,50) (150,50) (50,150) (150,150)
    const rects = [
      rect(0, 0, 100, 100),
      rect(100, 0, 100, 100),
      rect(0, 100, 100, 100),
      rect(100, 100, 100, 100),
    ]
    expect(nearestIndex(rects, { x: 10, y: 10 })).toBe(0)
    expect(nearestIndex(rects, { x: 190, y: 10 })).toBe(1)
    expect(nearestIndex(rects, { x: 10, y: 190 })).toBe(2)
    expect(nearestIndex(rects, { x: 190, y: 190 })).toBe(3)
    // **折り返しの端**。行をまたいで近いほうへ寄る（横だけを見ていると 1 になる）
    expect(nearestIndex(rects, { x: 130, y: 140 })).toBe(3)
  })

  it('同じ距離なら、先に出てきたほうを採る', () => {
    // 中心が x = 50 と x = 150、指はちょうど真ん中の 100
    const rects = [rect(0, 0, 100, 100), rect(100, 0, 100, 100)]
    expect(nearestIndex(rects, { x: 100, y: 50 })).toBe(0)
  })
})

describe('決められないときは、先頭へ倒さない', () => {
  // 0 は「先頭へ落とす」という立派な答えなので、混ぜると**測れなかったときに
  // 黙って先頭へ飛ぶ**

  it('矩形が1つも無ければ NO_TARGET', () => {
    expect(nearestIndex([], { x: 10, y: 10 })).toBe(-1)
    expect(NO_TARGET).toBe(-1)
  })

  it('指の座標が数でなければ NO_TARGET', () => {
    const rects = [rect(0, 0, 100, 100)]
    expect(nearestIndex(rects, { x: Number.NaN, y: 10 })).toBe(-1)
    expect(nearestIndex(rects, { x: 10, y: Number.POSITIVE_INFINITY })).toBe(-1)
  })

  it('測れなかった矩形は飛ばし、測れたものから選ぶ', () => {
    const rects = [
      { left: Number.NaN, top: 0, width: 100, height: 100 },
      rect(100, 0, 100, 100),
    ]
    expect(nearestIndex(rects, { x: 0, y: 0 })).toBe(1)
  })
})

describe('並びを入れ替える', () => {
  it('前から後ろへ', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('後ろから前へ', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('動かないときは同じ配列を返す', () => {
    // 毎フレーム呼ぶので、中身が同じでも新しい配列を返すと描き直しが止まらない
    const items = ['a', 'b', 'c']
    expect(moveItem(items, 1, 1)).toBe(items)
    expect(moveItem(items, -1, 0)).toBe(items)
    expect(moveItem(items, 0, 9)).toBe(items)
    expect(moveItem(items, 0, NO_TARGET)).toBe(items)
  })
})

describe('運び始めるしきい値', () => {
  it('斜めでも同じ距離で始まる', () => {
    // 3px。**縦横のどちらか一方だけで数えると、斜めに引いたときだけ始まらない**
    expect(passedThreshold(3, 0)).toBe(true)
    expect(passedThreshold(0, -3)).toBe(true)
    // **斜めは斜辺で数える。** 縦横それぞれが 3px に届いていなくても、
    // 実際に指が動いた長さが 3px を超えていれば始まる
    expect(passedThreshold(2.2, 2.2)).toBe(true) // 斜辺は約 3.11
    expect(passedThreshold(2, 2)).toBe(false) // 約 2.83。**まだ始まらない**
    expect(passedThreshold(1, 1)).toBe(false) // 約 1.41
  })

  it('数でなければ始まらない', () => {
    expect(passedThreshold(Number.NaN, 0)).toBe(false)
  })
})
