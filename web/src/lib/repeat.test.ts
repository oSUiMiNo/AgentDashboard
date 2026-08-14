import { describe, expect, it } from 'vitest'
import { bindRepeater, createRepeater, type RepeatTuning } from './repeat'

/**
 * 連射の判断（テスト計画フェーズ3「部品」）。
 *
 * # 実時間を待たない
 *
 * 時計とタイマーを差し替えているので、**進めたいぶんだけ進める**だけで固定できる。
 * ここが待つテストになっていたら、設計§8 の切り出しが効いていないという合図になる。
 *
 * # 境界は別々に見る
 *
 * 「初期遅延の手前では増えない」と「超えたら増える」を1回の `advance` でまとめて
 * 進めると、**初期遅延があること自体を確かめていない**（1発目からいきなり間隔で
 * 回る実装でも通る）。手前と超えたあとを別の断言にしてある。
 */

interface Harness {
  start: () => void
  stop: () => void
  running: () => boolean
  /** 発火した時刻の並び */
  fired: number[]
  advance: (ms: number) => void
  hide: () => void
}

function harness(tuning?: Partial<RepeatTuning>): Harness {
  const clock = { value: 0 }
  const timers = new Map<number, { at: number; callback: () => void }>()
  const fired: number[] = []
  const state = { hidden: false }
  let next = 1

  const repeater = createRepeater({
    fire: () => fired.push(clock.value),
    now: () => clock.value,
    setTimer: (callback, ms) => {
      const handle = next
      next += 1
      timers.set(handle, { at: clock.value + ms, callback })
      return handle
    },
    clearTimer: (handle) => {
      timers.delete(handle)
    },
    hidden: () => state.hidden,
    tuning,
  })

  const advance = (ms: number) => {
    const target = clock.value + ms
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null
      for (const entry of timers) {
        if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) {
          due = entry
        }
      }
      if (due === null) {
        break
      }
      timers.delete(due[0])
      clock.value = due[1].at
      due[1].callback()
    }
    clock.value = target
  }

  return {
    start: () => repeater.start(),
    stop: () => repeater.stop(),
    running: () => repeater.running(),
    fired,
    advance,
    hide: () => {
      state.hidden = true
    },
  }
}

const FAST: Partial<RepeatTuning> = { initialDelayMs: 400, intervalMs: 55 }

describe('createRepeater', () => {
  it('押した瞬間に1発出る', () => {
    const h = harness(FAST)
    h.start()
    expect(h.fired).toEqual([0])
  })

  it('初期遅延の手前では増えない', () => {
    const h = harness(FAST)
    h.start()
    h.advance(399)
    expect(h.fired).toHaveLength(1)
  })

  it('初期遅延を超えたら増える', () => {
    const h = harness(FAST)
    h.start()
    h.advance(399)
    h.advance(1)
    expect(h.fired).toEqual([0, 400])
  })

  it('以後は一定の間隔で出る', () => {
    const h = harness(FAST)
    h.start()
    h.advance(400)
    h.advance(55)
    h.advance(55)
    // 間隔が広がる（毎回倍にする等）実装なら、ここが 510 と 565 にならない
    expect(h.fired).toEqual([0, 400, 455, 510])
  })

  it('止めたら増えない', () => {
    const h = harness(FAST)
    h.start()
    h.stop()
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
    expect(h.running()).toBe(false)
  })

  it('画面が隠れたら止まる', () => {
    const h = harness(FAST)
    h.start()
    h.hide()
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
    expect(h.running()).toBe(false)
  })

  it('発数の上限で自分から止まる', () => {
    const h = harness({ initialDelayMs: 50, intervalMs: 50, maxTicks: 3 })
    h.start()
    h.advance(10_000)
    expect(h.fired).toEqual([0, 50, 100])
    expect(h.running()).toBe(false)
  })

  it('時間の上限で自分から止まる', () => {
    const h = harness({
      initialDelayMs: 50,
      intervalMs: 50,
      maxTicks: 1_000,
      maxDurationMs: 200,
    })
    h.start()
    h.advance(10_000)
    expect(h.fired).toEqual([0, 50, 100, 150])
    expect(h.running()).toBe(false)
  })

  it('押している間にもう一度押しても二重に走らない', () => {
    const h = harness(FAST)
    h.start()
    h.start()
    expect(h.fired).toHaveLength(1)
    h.advance(400)
    expect(h.fired).toHaveLength(2)
  })
})

/**
 * 止める契機の配線。
 *
 * **契機ごとに別のテストにしてある。** まとめると、1通り壊しただけで全部落ちて、
 * テストが何本ぶんの働きをしているのか分からなくなる。
 */
describe('bindRepeater', () => {
  function bound() {
    const h = harness(FAST)
    const target = document.createElement('div')
    const release = bindRepeater(
      target,
      { start: h.start, stop: h.stop, running: h.running },
    )
    h.start()
    return { h, target, release }
  }

  it('pointerup で止まる', () => {
    const { h, target } = bound()
    target.dispatchEvent(new Event('pointerup'))
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
  })

  it('pointercancel で止まる', () => {
    const { h, target } = bound()
    target.dispatchEvent(new Event('pointercancel'))
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
  })

  it('lostpointercapture で止まる', () => {
    const { h, target } = bound()
    target.dispatchEvent(new Event('lostpointercapture'))
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
  })

  it('消えたら止まる', () => {
    const { h, release } = bound()
    release()
    h.advance(1_000)
    expect(h.fired).toHaveLength(1)
  })

  it('解除したあとは、契機を撃っても何も起きない', () => {
    const { h, target, release } = bound()
    release()
    h.start()
    target.dispatchEvent(new Event('pointerup'))
    // 解除で購読が外れているので、この `pointerup` は止めに来ない
    h.advance(400)
    expect(h.fired).toHaveLength(3)
  })
})
