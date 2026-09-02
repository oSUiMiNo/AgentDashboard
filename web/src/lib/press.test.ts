import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, movedTooFar, pressMapping } from './press'

/**
 * 押し方の割り当て（並べ替え設計§4-1・テスト計画フェーズ4「選ぶ・開く」）。
 *
 * **判定を1箇所に集めたことの担保。** ここが正しければ、コンポーネント側は
 * `if (coarse)` を1つも書かずに済む。
 */

describe('PC と触る画面で入れ替わる', () => {
  it('PC はシングルで選び、ダブルで開く', () => {
    expect(pressMapping(false, false)).toEqual({
      single: 'select',
      doubleOpens: true,
      longPressSelects: false,
    })
  })

  it('PC は選択の有無で変わらない', () => {
    // **PC に選択モードという概念は無い。** 修飾キー無しでシングルが「選ぶ」なので、
    // 入る・出るの区別が要らない
    expect(pressMapping(false, true)).toEqual(pressMapping(false, false))
  })

  it('触る画面は、1枚も選んでいなければシングルで開く', () => {
    expect(pressMapping(true, false)).toEqual({
      single: 'open',
      doubleOpens: false,
      longPressSelects: true,
    })
  })

  it('触る画面は、選択モードに入るとシングルが「選ぶ」に変わる', () => {
    expect(pressMapping(true, true).single).toBe('select')
  })

  it('触る画面ではダブルを使わない', () => {
    // **端末の拡大と取り合う。** 開く操作はいちばん頻度が高いので、そこを
    // 端末と取り合わせられない
    expect(pressMapping(true, false).doubleOpens).toBe(false)
    expect(pressMapping(true, true).doubleOpens).toBe(false)
  })
})

describe('長押しとスクロールの見分け', () => {
  it('数を字で書く', () => {
    // 定数から期待値を組み立てると、一緒に動いて通ってしまう。
    // **実機で決め直す出発点**（設計§13）
    expect(LONG_PRESS_MS).toBe(400)
    expect(LONG_PRESS_SLOP_PX).toBe(8)
  })

  it('8px を超えたらスクロールと見なす', () => {
    expect(movedTooFar(8, 0)).toBe(false)
    expect(movedTooFar(9, 0)).toBe(true)
    // 斜めも斜辺で数える（縦横のどちらか一方だけだと、斜めに滑らせたときだけ残る）
    expect(movedTooFar(6, 6)).toBe(true) // 約 8.49
  })

  it('測れないものは「動いた」に倒す', () => {
    // **押しっぱなしと読み違えるより、スクロールと読み違えるほうが害が小さい**
    // ——選ばれないだけで済む
    expect(movedTooFar(Number.NaN, 0)).toBe(true)
  })
})
