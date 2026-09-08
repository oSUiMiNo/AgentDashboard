/**
 * 巡回の土台（`サイドバーの一覧を、リロードせずに新しくする`）。
 *
 * **実時間を待たない。** 時計もタイマーも注入する形にしてあるので、
 * `lib/repeat.ts` のテストと同じく手で駆動する。10秒おきの仕組みを
 * 実時間で確かめようとすると、1本ごとに10秒かかる。
 */

import { describe, expect, it } from 'vitest'
import { createPoller } from '@/lib/poll'

const 間隔 = 10_000

/** 手で進める駒。時計もタイマーも、こちらが動かす。 */
function 駒(options: { 返さない?: boolean } = {}) {
  const 待ち行列 = new Map<number, () => void>()
  let 次の番号 = 1
  let 隠れている = false
  let 時刻 = 1_000_000
  const 引いた: number[] = []
  let 投げる = false

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
      now: () => 時刻,
      intervalMs: 間隔,
      run: async () => {
        引いた.push(引いた.length + 1)
        if (投げる) {
          throw new Error('引けなかった')
        }
        if (options.返さない === true) {
          // **返らない**。飛行中の振る舞いを見るためだけのもの
          await new Promise<void>(() => {})
        }
      },
    },
    隠す: (v: boolean) => void (隠れている = v),
    投げさせる: (v: boolean) => void (投げる = v),
    進める: (ms: number) => void (時刻 += ms),
    /** 積まれている時報を全部撃つ */
    時報: async () => {
      const 積まれたもの = [...待ち行列.values()]
      待ち行列.clear()
      for (const each of 積まれたもの) {
        each()
      }
      await 流す()
    },
    積まれた数: () => 待ち行列.size,
  }
}

async function 流す() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
  }
}

describe('createPoller', () => {
  it('start しただけでは引かない（初回は呼ぶ側が済ませている）', () => {
    const c = 駒()
    createPoller(c.設定).start()

    expect(c.引いた).toEqual([])
    expect(c.積まれた数()).toBe(1)
  })

  it('時報のたびに引き、引き終わってから次を測る', async () => {
    const c = 駒()
    const poller = createPoller(c.設定)
    poller.start()

    await c.時報()
    expect(c.引いた).toEqual([1])
    // **引き終わってから積む。** 先に積むと、遅い問い合わせが返る前に次が出る
    expect(c.積まれた数()).toBe(1)

    c.進める(間隔)
    await c.時報()
    expect(c.引いた).toEqual([1, 2])
  })

  it('隠れている間は引かない。表へ戻ったら引く', async () => {
    const c = 駒()
    createPoller(c.設定).start()

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
    const poller = createPoller(c.設定)
    poller.start()

    poller.wake()
    await 流す()

    expect(c.引いた).toEqual([1])
    // **古い時報を残さない。** 残すと戻った直後に2回引く
    expect(c.積まれた数()).toBe(1)
  })

  it('隠れているときの wake は引かない', async () => {
    const c = 駒()
    const poller = createPoller(c.設定)
    poller.start()
    c.隠す(true)

    poller.wake()
    await 流す()

    expect(c.引いた).toEqual([])
  })

  it('**間隔より短い往復では、wake で引かない**（タブを行き来しても飛ばない）', async () => {
    const c = 駒()
    const poller = createPoller(c.設定)
    poller.start()

    c.進める(間隔)
    await c.時報()
    expect(c.引いた).toEqual([1])

    // 3秒だけ離れて戻った
    c.進める(3_000)
    poller.wake()
    await 流す()
    expect(c.引いた).toEqual([1])

    // 十分に離れたら引く
    c.進める(間隔)
    poller.wake()
    await 流す()
    expect(c.引いた).toEqual([1, 2])
  })

  it('stop すると、それ以降は引かない', async () => {
    const c = 駒()
    const poller = createPoller(c.設定)
    poller.start()

    poller.stop()
    await c.時報()

    expect(c.引いた).toEqual([])
    expect(poller.running()).toBe(false)
  })

  it('**引いている最中に stop すると、解けても積み直さない**（世代の役目）', async () => {
    const c = 駒({ 返さない: true })
    const poller = createPoller(c.設定)
    poller.start()

    await c.時報()
    expect(c.引いた).toEqual([1])
    // 飛行中。**ここで止める**
    poller.stop()
    await 流す()

    // 解けても誰も積み直さない
    expect(c.積まれた数()).toBe(0)
    expect(poller.running()).toBe(false)
  })

  it('**引いている最中に stop → start しても、また始まる**', async () => {
    const c = 駒({ 返さない: true })
    const poller = createPoller(c.設定)
    poller.start()

    await c.時報()
    poller.stop()
    poller.start()

    // 止めた印が残っていると、ここが 0 になって巡回が静かに死ぬ
    expect(c.積まれた数()).toBe(1)
    expect(poller.running()).toBe(true)
  })

  it('**引きが投げても、巡回は止まらない**', async () => {
    const c = 駒()
    const poller = createPoller(c.設定)
    poller.start()
    c.投げさせる(true)

    await c.時報()
    expect(c.引いた).toEqual([1])
    // **次が積まれている。** ここが 0 だと、1回の失敗で永久に止まる
    expect(c.積まれた数()).toBe(1)

    c.投げさせる(false)
    c.進める(間隔)
    await c.時報()
    expect(c.引いた).toEqual([1, 2])
  })

  it('**引いている最中も「生きている」と答える**', async () => {
    const c = 駒({ 返さない: true })
    const poller = createPoller(c.設定)
    poller.start()

    await c.時報()

    // `handle` は空いているが、いちばん動いている瞬間である
    expect(poller.running()).toBe(true)
  })

  it('引いている最中の wake は重ねて引かない', async () => {
    const c = 駒({ 返さない: true })
    const poller = createPoller(c.設定)
    poller.start()

    await c.時報()
    expect(c.引いた).toEqual([1])

    poller.wake()
    await 流す()

    expect(c.引いた).toEqual([1])
  })

  it('start を二度呼んでも、時報は1本しか積まれない', () => {
    const c = 駒()
    const poller = createPoller(c.設定)

    poller.start()
    poller.start()

    expect(c.積まれた数()).toBe(1)
  })
})
