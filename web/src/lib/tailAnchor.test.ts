import { describe, expect, it } from 'vitest'
import {
  SETTLE_FRAME_LIMIT,
  SUPPRESSED_THRESHOLD,
  planBodyToggle,
  resolveEndThreshold,
  settled,
} from './tailAnchor'

describe('末尾の錨の抑制', () => {
  it('抑制していないときは、渡された値をそのまま返す', () => {
    expect(resolveEndThreshold(false, 80)).toBe(80)
  })

  it('抑制中は負の値になる（比べる相手は必ず0以上なので、条件が必ず偽になる）', () => {
    expect(resolveEndThreshold(true, 80)).toBeLessThan(0)
    expect(SUPPRESSED_THRESHOLD).toBeLessThan(0)
  })

  it('抑制が下りれば必ず元の値へ戻る（戻し忘れが作れない）', () => {
    // 状態から算出するので、命令的な「戻す」処理が存在しない。
    // ここが真であるかぎり、抑制が下りた描画で自動的に元へ戻る
    for (const 元 of [0, 1, 80, 1_000]) {
      expect(resolveEndThreshold(false, 元)).toBe(元)
    }
  })
})

describe('抑制を下ろす判定', () => {
  it('総高が2フレーム続けて同じなら落ち着いたとみなす', () => {
    expect(settled(7489, 7489, 3, SETTLE_FRAME_LIMIT)).toBe(true)
  })

  it('伸びている間は下ろさない', () => {
    expect(settled(7489, 10_438, 3, SETTLE_FRAME_LIMIT)).toBe(false)
  })

  it('測れないまま同じ値が続いても、落ち着いたとみなさない', () => {
    // 箱がまだ無いときは -1 が続く。ここを落ち着いたと読むと、
    // 伸びる前に抑制が下りて跳ねが残る
    expect(settled(-1, -1, 3, SETTLE_FRAME_LIMIT)).toBe(false)
  })

  it('上限フレームに達したら、落ち着いていなくても必ず下ろす', () => {
    // **上限は保険ではなく必須。** 下りない道があると、そこから先の追記を追わなくなる
    expect(settled(7489, 10_438, SETTLE_FRAME_LIMIT, SETTLE_FRAME_LIMIT)).toBe(true)
    expect(settled(-1, -1, SETTLE_FRAME_LIMIT, SETTLE_FRAME_LIMIT)).toBe(true)
  })

  it('上限は下りない道を作らない大きさである', () => {
    expect(SETTLE_FRAME_LIMIT).toBeGreaterThan(0)
    expect(Number.isFinite(SETTLE_FRAME_LIMIT)).toBe(true)
  })
})

/**
 * 畳んだら、開く前の位置へ戻す（項目10の追補・利用者の指摘 2026-09-08）。
 *
 * **開くときに跳ねなくなったので、畳んだときの迷子が見えるようになった。**
 * 本文が消えたぶん下の行が迫り上がるので、位置が同じでも読んでいた行が消える。
 */
describe('開け閉めしたときの位置の控え', () => {
  it('開くときは、いまの位置を控える。戻し先は作らない', () => {
    expect(planBodyToggle(false, 4_200, undefined)).toEqual({ 覚える: 4_200, 戻す: null })
  })

  it('畳むときは、控えた位置へ戻す', () => {
    expect(planBodyToggle(true, 9_100, 4_200)).toEqual({ 覚える: null, 戻す: 4_200 })
  })

  it('戻すのは「畳んだ瞬間の位置」ではなく「開く前の位置」である', () => {
    // 畳んだ瞬間の位置は**開いた本文の中のどこか**なので、
    // 畳んだ後の文書には対応する場所が無い
    const 手 = planBodyToggle(true, 9_100, 4_200)
    expect(手.戻す).not.toBe(9_100)
    expect(手.戻す).toBe(4_200)
  })

  it('控えが無いまま畳んだら、どこへも動かさない', () => {
    // 開いた状態で描き直された（別のカードから戻ってきた等）ときに、
    // 適当な位置へ飛ばさない
    expect(planBodyToggle(true, 9_100, undefined)).toEqual({ 覚える: null, 戻す: null })
  })

  it('戻したら控えは消える——同じ行をもう一度開けば、そのときの位置を控え直す', () => {
    expect(planBodyToggle(true, 9_100, 4_200).覚える).toBeNull()
    expect(planBodyToggle(false, 600, 4_200)).toEqual({ 覚える: 600, 戻す: null })
  })

  it('先頭（0）を控えても、控えていないことにならない', () => {
    // `?? null` や `||` の書き方を誤ると、0 が「無い」に落ちて先頭へ戻れなくなる
    expect(planBodyToggle(false, 0, undefined).覚える).toBe(0)
    expect(planBodyToggle(true, 5_000, 0).戻す).toBe(0)
  })
})
