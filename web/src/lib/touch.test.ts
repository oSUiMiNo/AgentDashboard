import { createTouchScroller, DEFAULT_TUNING } from './touch'
import type { TouchPoint, TouchScroller } from './touch'

/**
 * タッチで遡る判断（テスト計画フェーズ2「単体」）。
 *
 * # 実時間を待たない
 *
 * 時計と `requestAnimationFrame` を差し替えているので、慣性の減衰も停止も**進めたい
 * ぶんだけ時計を進めるだけ**で固定できる。ここが待つテストになっていたら、設計§8 の
 * 切り出しが効いていないという合図になる。
 */

const CELL = 15

interface Harness {
  scroller: TouchScroller
  /** `scrollLines` に渡された行数の並び */
  lines: number[]
  /** 合計で何行動いたか */
  total: () => number
  /** 時計を進める。溜まっているフレームがあれば動かす */
  advance: (ms: number) => void
  clock: { value: number }
  frames: number
}

function harness(
  options: {
    cellHeight?: number
    canScroll?: (direction: number) => boolean
    tuning?: Partial<typeof DEFAULT_TUNING>
  } = {},
): Harness {
  const clock = { value: 0 }
  const lines: number[] = []
  let pending: (() => void) | null = null
  let next = 1

  const scroller = createTouchScroller({
    cellHeight: () => options.cellHeight ?? CELL,
    scrollLines: (value) => lines.push(value),
    canScroll: options.canScroll ?? (() => true),
    now: () => clock.value,
    raf: (callback) => {
      pending = callback
      return next++
    },
    cancelRaf: () => {
      pending = null
    },
    tuning: options.tuning,
  })

  const result: Harness = {
    scroller,
    lines,
    total: () => lines.reduce((sum, value) => sum + value, 0),
    clock,
    frames: 0,
    advance(ms: number) {
      // 1コマ 16ms として進める。刻みを変えても結果が変わらないことを見るテストがある
      const stepMs = 16
      let left = ms
      while (left > 0 && pending) {
        const slice = Math.min(stepMs, left)
        clock.value += slice
        left -= slice
        const callback = pending
        pending = null
        result.frames += 1
        callback()
      }
      clock.value += Math.max(0, left)
    },
  }
  return result
}

/** 指1本を `dy` だけ動かす（`steps` 回に分けて）。 */
function swipe(
  h: Harness,
  dy: number,
  steps = 4,
  { perStepMs = 16, x = 0 }: { perStepMs?: number; x?: number } = {},
): boolean[] {
  const grabs: boolean[] = []
  h.scroller.start([{ x, y: 0 }])
  for (let i = 1; i <= steps; i += 1) {
    h.clock.value += perStepMs
    grabs.push(h.scroller.move([{ x, y: (dy * i) / steps }]))
  }
  return grabs
}

const point = (x: number, y: number): TouchPoint => ({ x, y })

describe('距離を行数へ', () => {
  it('セルの高さで割った行数ぶんだけ動かすこと', () => {
    const h = harness()
    swipe(h, CELL * 4, 4)
    // 指を下へ動かすので過去（負の向き）へ
    expect(h.total()).toBe(-4)
  })

  it('割った余りが持ち越されること', () => {
    // しきい値より小さい動きを繰り返しても取りこぼさない。
    // 丸めるだけだと「ゆっくり動かしているのに1行も動かない」になる。
    //
    // **余りが効く形で測る。** 100px（6行と余り10px）動かしてから 5px 足すと、
    // 余りを持ち越していれば 15px＝ちょうど1行ぶんが増える。捨てていれば増えない
    const h = harness()
    h.scroller.start([point(0, 0)])
    h.scroller.move([point(0, 100)])
    expect(h.total()).toBe(-6)

    h.scroller.move([point(0, 105)])
    expect(h.total()).toBe(-7)
  })

  it('セルの高さが 0 のときは何もしないこと', () => {
    // 隠れている間など。割れない値で計算に進まない
    const h = harness({ cellHeight: 0 })
    swipe(h, CELL * 10, 10)
    expect(h.lines).toEqual([])
  })

  it('指を下へ動かすと過去へ遡ること', () => {
    const down = harness()
    swipe(down, CELL * 3, 3)
    expect(down.total()).toBeLessThan(0)

    const up = harness()
    swipe(up, -CELL * 3, 3)
    expect(up.total()).toBeGreaterThan(0)
  })
})

describe('なぞりと触れるの見分け', () => {
  it('1回目の touchmove から握ること', () => {
    // **しきい値を待ってはいけない。** 1回目で握らないと2回目から cancelable が
    // 落ちて、以後どう頑張っても握れない（フェーズ1 の実測）
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 1)])).toBe(true)
  })

  it('1回目が横へブレても、そのなぞりが死なないこと', () => {
    // **実機はこれで死んでいた（フェーズ7 の実測）。** 指は真っ直ぐ動き出さないので、
    // 1回目は「横へ2px・縦へ1px」のような値になる。そこで「横へ払う操作」と確定すると、
    // 決定は指が離れるまで戻らないので**そのなぞりは二度と握れない**。
    //
    // 合成タッチ（CDP）は真っ直ぐ動くので、この道を一度も通らなかった。**E2E が7本とも
    // 緑なのに実機だけが死ぬ**という形で出た
    const h = harness()
    h.scroller.start([point(100, 100)])
    expect(h.scroller.move([point(102, 101)])).toBe(true)
    const rest = [20, 60, 120].map((d) => h.scroller.move([point(102, 100 + d)]))
    expect(rest).toEqual([true, true, true])
    expect(h.total()).toBeLessThan(0)
  })

  it('下端で1回目だけ逆へブレても、そのあと遡れること', () => {
    // 同じ壊れ方の別の入口。**下端は普段いる場所**なので、こちらのほうが踏みやすい
    const h = harness({ canScroll: (direction) => direction < 0 })
    h.scroller.start([point(100, 100)])
    expect(h.scroller.move([point(100, 98)])).toBe(true)
    const rest = [20, 80, 160].map((d) => h.scroller.move([point(100, 100 + d)]))
    expect(rest).toEqual([true, true, true])
    expect(h.total()).toBeLessThan(0)
  })

  it('斜めの1歩目は、端末側へ倒すこと', () => {
    // **ブラウザは touch slop を超えるまで `touchmove` を配らない**（実測：2px と 12px は
    // 1つも届かず、30px で届いた）。したがって**こちらへ届く1歩目は既に大きく、斜め**で
    // ある。実測した1歩目は「横30・縦15」だった。
    //
    // ここを「横が少しでも大きければ手放す」にすると、その斜めが横に化けて**実機の
    // なぞりが丸ごと死ぬ**。端末の中は縦に読む場所なので、迷ったら縦へ倒す
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(30, 15)])).toBe(true)
    expect(h.scroller.move([point(30, 200)])).toBe(true)
    expect(h.total()).toBeLessThan(0)
  })

  it('1ピクセルも動いていない間は握らないこと', () => {
    // 動いていなければブラウザもパンを始めようがない。タップの邪魔をしない
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 0)])).toBe(false)
  })

  it('向きが信用できる距離まで来たら、そこで横へ払う操作を手放すこと', () => {
    // 暫定で握るのは**まだ分からない間だけ**。分かったら返す（上の2本と対になる肯定側）
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(2, 1)])).toBe(true)
    expect(h.scroller.move([point(60, 4)])).toBe(false)
    expect(h.lines).toEqual([])
  })

  it('しきい値を超えるまでは遡らせないこと', () => {
    // 握りはするが、動かすのはしきい値を超えてから。
    //
    // **しきい値をセルの高さより大きくして測る。** 既定（8px）はセル（15px）より
    // 小さいので、しきい値を無視する実装でも「1行に満たないから動かない」だけで
    // 通ってしまい、**何も確かめていないテスト**になる
    const h = harness({ tuning: { threshold: CELL * 3 } })
    h.scroller.start([point(0, 0)])
    h.scroller.move([point(0, CELL * 3 - 1)])
    expect(h.lines).toEqual([])

    // 超えたあとは、**そこから先の移動ぶん**を動かす（超えるまでに溜めたぶんは
    // 動かさない。溜めたぶんを一度に吐くと、しきい値のぶんだけ画面が飛ぶ）
    h.scroller.move([point(0, CELL * 4)])
    expect(h.total()).toBe(-1)
  })

  it('一度なぞりと決めたら、その指が離れるまで戻らないこと', () => {
    // ゆっくり往復させてもタップに化けない
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 40)])).toBe(true)
    expect(h.scroller.move([point(0, 0)])).toBe(true)
    // 横へ大きく動かしても、もう見送りへは戻らない
    expect(h.scroller.move([point(500, 0)])).toBe(true)
  })

  it('縦より横の動きが大きければ、その指を最後まで扱わないこと', () => {
    // 横へ払う操作を奪わない
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(50, 5)])).toBe(false)
    // そのあと縦へ大きく動かしても、この指では握らない
    expect(h.scroller.move([point(50, 200)])).toBe(false)
    expect(h.lines).toEqual([])
  })

  it('指が2本以上になったら取りやめること', () => {
    const h = harness()
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 40)])).toBe(true)
    expect(h.scroller.move([point(0, 60), point(30, 60)])).toBe(false)
  })
})

describe('慣性', () => {
  it('指を離した速度がしきい値以上なら滑り続けること', () => {
    const h = harness()
    // 16ms ごとに 20px＝1.25 px/ms。しきい値 0.25 を超える
    swipe(h, 80, 4)
    const beforeEnd = h.total()
    h.scroller.end()
    expect(h.scroller.running()).toBe(true)

    h.advance(200)
    expect(h.total()).toBeLessThan(beforeEnd)
  })

  it('速度は直近の複数回から採ること', () => {
    // 最後の1回だけを見ると、止める直前の減速に引きずられて勢いを取りこぼす。
    // **最後の1回をわざと遅くしても滑る**ことで見る
    const h = harness()
    h.scroller.start([point(0, 0)])
    h.clock.value += 16
    h.scroller.move([point(0, 30)])
    h.clock.value += 16
    h.scroller.move([point(0, 60)])
    // 最後の1回は、ほとんど動かない
    h.clock.value += 16
    h.scroller.move([point(0, 61)])
    h.scroller.end()

    expect(h.scroller.running()).toBe(true)
  })

  it('経過時間で減衰すること', () => {
    // フレームの刻みが違っても、同じ時間なら滑る距離は変わらない。
    // フレーム数で減らすと機械の速さで結果が変わる
    const coarse = harness()
    swipe(coarse, 80, 4)
    coarse.scroller.end()
    coarse.advance(320)

    const fine = harness()
    swipe(fine, 80, 4)
    fine.scroller.end()
    // 同じ 320ms を、細かい刻みで進める
    for (let i = 0; i < 40; i += 1) {
      fine.advance(8)
    }

    expect(fine.frames).toBeGreaterThan(coarse.frames)
    expect(Math.abs(fine.total() - coarse.total())).toBeLessThanOrEqual(2)
  })

  it('速度がしきい値を下回ったら止まること', () => {
    const h = harness()
    swipe(h, 80, 4)
    h.scroller.end()
    h.advance(5_000)
    expect(h.scroller.running()).toBe(false)
  })

  it('次の指が触れたら即座に止まること', () => {
    // 滑っているのを止めたいだけの指で、なぞりが始まってはいけない
    const h = harness()
    swipe(h, 80, 4)
    h.scroller.end()
    expect(h.scroller.running()).toBe(true)

    h.scroller.start([point(0, 0)])
    expect(h.scroller.running()).toBe(false)
  })

  it('端に着いたら止まること', () => {
    let atEdge = false
    const h = harness({ canScroll: (direction) => !(atEdge && direction < 0) })
    swipe(h, 80, 4)
    h.scroller.end()
    expect(h.scroller.running()).toBe(true)

    atEdge = true
    h.advance(64)
    expect(h.scroller.running()).toBe(false)
  })

  it('端末が捨てられたら止まること', () => {
    const h = harness()
    swipe(h, 80, 4)
    h.scroller.end()
    h.scroller.stop()
    expect(h.scroller.running()).toBe(false)
  })

  it('取りやめ（touchcancel）でも滑らないこと', () => {
    const h = harness()
    swipe(h, 80, 4)
    h.scroller.cancel()
    expect(h.scroller.running()).toBe(false)
  })
})

describe('端の判定', () => {
  it('上端で、さらに過去へなぞっても握らないこと', () => {
    // 過去（負の向き）へは行けない
    const h = harness({ canScroll: (direction) => direction > 0 })
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 40)])).toBe(false)
    expect(h.lines).toEqual([])
  })

  it('下端で、さらに未来へなぞっても握らないこと', () => {
    const h = harness({ canScroll: (direction) => direction < 0 })
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, -40)])).toBe(false)
    expect(h.lines).toEqual([])
  })

  it('端でない側へのなぞりは握ること', () => {
    // 否定側と対で肯定側を置く。否定だけを見ると、判定が丸ごと動いていなくても通る
    const h = harness({ canScroll: (direction) => direction > 0 })
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, -40)])).toBe(true)
    expect(h.total()).toBeGreaterThan(0)
  })

  it('途中で端に着いても、そのなぞりは握ったままであること', () => {
    // 握るのをやめると、その瞬間からブラウザ側がパンを始めて二度と握れなくなる
    let atEdge = false
    const h = harness({ canScroll: (direction) => !(atEdge && direction < 0) })
    h.scroller.start([point(0, 0)])
    expect(h.scroller.move([point(0, 40)])).toBe(true)

    atEdge = true
    expect(h.scroller.move([point(0, 80)])).toBe(true)
  })
})
