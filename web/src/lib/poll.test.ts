/**
 * 巡回の土台（`サイドバーの一覧を、リロードせずに新しくする`）。
 *
 * **実時間を待たない。** 時計もタイマーも注入する形にしてあるので、
 * `lib/repeat.ts` のテストと同じく手で駆動する。10秒おきの仕組みを
 * 実時間で確かめようとすると、1本ごとに10秒かかる。
 */

import { describe, expect, it } from 'vitest'
import { createPoller } from '@/lib/poll'

/** 手で進める時計。`setTimer` に積まれたものを、呼びたいときに呼ぶ。 */
function 駒() {
  const 待ち行列 = new Map<number, () => void>()
  let 次の番号 = 1
  let 隠れている = false
  const 引いた: number[] = []
  let 引く回数 = 0
  /** `run` を止めておくための鍵。解くまで返らない */
  let 解く: (() => void) | null = null

  return {
    引いた,
    設定: {
      // 間隔そのものは見ない。**積まれたかどうか**だけを見る形にしてある
      setTimer: (callback: () => void) => {
        const 番号 = 次の番号++
        待ち行列.set(番号, callback)
        return 番号
      },
      clearTimer: (handle: number) => void 待ち行列.delete(handle),
      hidden: () => 隠れている,
      run: async () => {
        引く回数 += 1
        引いた.push(引く回数)
        if (解く !== null) {
          await new Promise<void>((resolve) => {
            const 前 = 解く
            解く = () => {
              resolve()
              前?.()
            }
          })
        }
      },
    },
    隠す: (v: boolean) => void (隠れている = v),
    /** 積まれている時報を全部撃つ */
    時報: async () => {
      const 積まれたもの = [...待ち行列.values()]
      待ち行列.clear()
      for (const each of 積まれたもの) {
        each()
      }
      await Promise.resolve()
      await Promise.resolve()
    },
    積まれた数: () => 待ち行列.size,
    引きを止める: () => void (解く = () => {}),
  }
}

describe('createPoller', () => {
  it('start しただけでは引かない（初回は呼ぶ側が済ませている）', () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })

    poller.start()

    expect(c.引いた).toEqual([])
    expect(c.積まれた数()).toBe(1)
  })

  it('時報のたびに引き、引き終わってから次を測る', async () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()

    await c.時報()
    expect(c.引いた).toEqual([1])
    // **引き終わってから積む。** 先に積むと、遅い問い合わせが返る前に次が出る
    expect(c.積まれた数()).toBe(1)

    await c.時報()
    expect(c.引いた).toEqual([1, 2])
  })

  it('隠れている間は引かない。表へ戻ったら引く', async () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()

    c.隠す(true)
    await c.時報()
    expect(c.引いた).toEqual([])
    // 測るのは続ける——`visibilitychange` を取り逃がしても次の時報で追いつく
    expect(c.積まれた数()).toBe(1)

    c.隠す(false)
    await c.時報()
    expect(c.引いた).toEqual([1])
  })

  it('wake は、その場で引いて測り直す', async () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()

    poller.wake()
    await Promise.resolve()
    await Promise.resolve()

    expect(c.引いた).toEqual([1])
    // **古い時報を残さない。** 残すと戻った直後に2回引く
    expect(c.積まれた数()).toBe(1)
  })

  it('隠れているときの wake は引かない', async () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()
    c.隠す(true)

    poller.wake()
    await Promise.resolve()

    expect(c.引いた).toEqual([])
  })

  it('stop すると、それ以降は引かない', async () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()

    poller.stop()
    await c.時報()

    expect(c.引いた).toEqual([])
    expect(poller.running()).toBe(false)
  })

  it('引いている最中の wake は重ねて引かない', async () => {
    const c = 駒()
    c.引きを止める()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })
    poller.start()

    await c.時報()
    expect(c.引いた).toEqual([1])

    // 1本目がまだ返っていない
    poller.wake()
    await Promise.resolve()

    expect(c.引いた).toEqual([1])
  })

  it('start を二度呼んでも、時報は1本しか積まれない', () => {
    const c = 駒()
    const poller = createPoller({ ...c.設定, intervalMs: 10_000 })

    poller.start()
    poller.start()

    expect(c.積まれた数()).toBe(1)
  })
})
