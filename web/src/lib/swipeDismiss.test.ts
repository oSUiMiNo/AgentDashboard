/**
 * 払って消す動きの、決める側（スワイプで消す テスト計画フェーズ1）。
 *
 * **ここは数字だけを見る。** DOM もポインタも出てこないので、jsdom が矩形を
 * 固定で返しても結論が変わらない——「何も確かめないまま緑になる」形を避けるため、
 * 判断を純関数へ寄せてある。
 */
import { describe, expect, it } from 'vitest'
import {
  SWIPE_DISMISS_PX,
  SWIPE_SLOP_PX,
  followOffset,
  followOpacity,
  lockAxis,
  shouldDismiss,
} from './swipeDismiss'

describe('lockAxis', () => {
  it('遊びの中では決めない', () => {
    // **押した指は必ず少し動く。** ここで決めると、触っただけで向きが付く
    expect(lockAxis('none', SWIPE_SLOP_PX - 1, SWIPE_SLOP_PX - 1)).toBe('none')
  })

  it('大きく動いたほうの向きに決まる', () => {
    expect(lockAxis('none', 20, 3)).toBe('x')
    expect(lockAxis('none', 3, -20)).toBe('y')
  })

  it('一度決まったら変わらない', () => {
    // 決め直すと、斜めに払ったときに横と縦を行き来してちらつく
    expect(lockAxis('x', 1, 100)).toBe('x')
    expect(lockAxis('y', 100, 1)).toBe('y')
  })
})

describe('followOffset', () => {
  it('決まっていない向きへは動かさない', () => {
    expect(followOffset('none', 30, 30)).toEqual({ x: 0, y: 0 })
  })

  it('横は左右とも指について動く', () => {
    expect(followOffset('x', 40, 5)).toEqual({ x: 40, y: 0 })
    expect(followOffset('x', -40, 5)).toEqual({ x: -40, y: 0 })
  })

  it('縦は上へだけ動く', () => {
    expect(followOffset('y', 3, -40)).toEqual({ x: 0, y: -40 })
  })

  it('**下へは動かさない**', () => {
    // 追従だけさせて消えないのが、いちばん分かりにくい壊れ方。
    // 動かないほうが「ここは効かない」と伝わる
    expect(followOffset('y', 3, 40)).toEqual({ x: 0, y: 0 })
  })
})

describe('shouldDismiss', () => {
  it('境目に届かなければ消さない', () => {
    expect(shouldDismiss('x', SWIPE_DISMISS_PX - 1, 0)).toBe(false)
    expect(shouldDismiss('y', 0, -(SWIPE_DISMISS_PX - 1))).toBe(false)
  })

  it('左右どちらも、境目を越えたら消す', () => {
    expect(shouldDismiss('x', SWIPE_DISMISS_PX, 0)).toBe(true)
    expect(shouldDismiss('x', -SWIPE_DISMISS_PX, 0)).toBe(true)
  })

  it('上へ越えたら消す', () => {
    expect(shouldDismiss('y', 0, -SWIPE_DISMISS_PX)).toBe(true)
  })

  it('**下へはどれだけ運んでも消さない**', () => {
    // トーストは画面のいちばん上に出る。下へ払う動きは
    // Chrome for Android の引き下げ更新が持っている
    expect(shouldDismiss('y', 0, SWIPE_DISMISS_PX * 10)).toBe(false)
  })

  it('向きが決まっていなければ消さない', () => {
    expect(shouldDismiss('none', 999, -999)).toBe(false)
  })
})

describe('followOpacity', () => {
  it('動いていなければそのまま', () => {
    expect(followOpacity({ x: 0, y: 0 })).toBe(1)
  })

  it('運ぶほど薄くなる', () => {
    const 半分 = followOpacity({ x: SWIPE_DISMISS_PX / 2, y: 0 })
    const 全部 = followOpacity({ x: SWIPE_DISMISS_PX, y: 0 })
    expect(半分).toBeLessThan(1)
    expect(全部).toBeLessThan(半分)
  })

  it('**消えると決まる距離でも 0 にはしない**', () => {
    // 離す前に消えたように見えると、戻ったときに「壊れた」と読める
    expect(followOpacity({ x: SWIPE_DISMISS_PX * 3, y: 0 })).toBeGreaterThan(0.3)
  })
})
