import { describe, expect, it } from 'vitest'
import { SETTLE_FRAME_LIMIT, SUPPRESSED_THRESHOLD, resolveEndThreshold, settled } from './tailAnchor'

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
