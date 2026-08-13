/**
 * 端末をタッチで遡る（設計§5・§6・§7・§8）。
 *
 * xterm 6 にはタッチの口が無い。同梱されている `Gesture` は呼び出しが0件で公開もされておらず、
 * `scroll` の購読も1件も無いので、`.xterm-viewport` をブラウザがスクロールさせても端末は
 * 1行も動かない。遡りの入口は実質 `wheel` と `scrollLines()` だけなので、**自前で受けて
 * API を呼ぶ**しかない（設計§2。実測済み）。
 *
 * # なぜ端末から切り離してあるのか
 *
 * ここがやるのは「指の動きを行数と勢いへ変える」という、それだけで完結する規則である。
 * xterm のインスタンスから切り離しておくと、しきい値・端・慣性の減衰と停止を**実ブラウザ
 * 無しで固定できる**。`lib/flow.ts` の [`createFlowController`] と同じ作り・同じ理由。
 *
 * **時計と `requestAnimationFrame` を引数で受け取る**のが要点。慣性は時間で減衰するので、
 * 実時間に任せるとテストが「待つ」ものになり、しかも機械の速さで結果が変わる。
 *
 * # 握るのは1回目から。ただし**向きの判断はあとまわし**にする
 *
 * `preventDefault()` が効くのは `event.cancelable` が真のあいだだけで、**1回目で握らないと
 * 2回目から偽になる**（フェーズ1 の実測）。したがって「しきい値を超えてから握る」は成立
 * しない。
 *
 * ここに落とし穴があった。**1回目の1サンプルで向きまで決めてしまうと、実際の指では
 * ほぼ必ず外す。** 指は真っ直ぐ動き出さないので、1回目が横へ2px・縦へ1px といった値に
 * なり、「横へ払う操作だ」と誤って確定する。しかも決定は指が離れるまで戻らないので、
 * **そのなぞりは二度と握れない**。合成タッチ（CDP）は真っ直ぐ動くので一度も踏まず、
 * E2E が緑のまま実機だけが死ぬ、という形で出た（フェーズ7 の実測）。
 *
 * そこで2つに分ける。
 *
 * | いつ | 何をするか |
 * |---|---|
 * | 動きが `directionCertainty` に満たない間 | **暫定で握る**（`preventDefault` を続けて `cancelable` を保つ）。向きは決めない |
 * | 超えた時点 | そこで初めて向きを確定し、横へ払う操作なら手放す |
 *
 * **1ピクセルも動いていない間は握らない。** 動いていなければブラウザもパンを始めようが
 * ないので、握る必要が無い（タップの邪魔をしない）。
 */

/** 指の位置。`Touch` そのものを受け取らないのは、テストから作れるようにするため。 */
export interface TouchPoint {
  x: number
  y: number
}

/**
 * 触り心地を決める値。
 *
 * **フェーズ1 で置いた暫定値で、実機で触って確定させる**（設計§12）。直したときは
 * ここと設計§12 の表と単体テストの期待値を揃えること。
 */
export interface Tuning {
  /** なぞりと見なす累積移動量（px）。これを超えるまで遡らせない */
  threshold: number
  /**
   * 向きを信用してよい移動量（px）。
   *
   * これに満たない間は**暫定で握り、向きを決めない**。指は真っ直ぐ動き出さないので、
   * 1回目の1サンプルで決めると実機ではほぼ必ず外す（フェーズ7 の実測）。
   */
  directionCertainty: number
  /**
   * 「横へ払う操作」と決めるのに要る、縦に対する横の倍率。
   *
   * **1 にしてはいけない。** ブラウザは指が touch slop（実測で 12〜30px の間）を超える
   * まで `touchmove` を配らないので、**こちらへ届く1歩目は既に大きく、しかも斜め**である。
   * 実測した1歩目は「横30・縦15」で、倍率1 だとこれが「横へ払う操作」に化けた。
   *
   * 端末の中は縦に読む場所なので、**迷ったら縦（＝遡り）へ倒す**のが正しい。
   */
  horizontalRatio: number
  /** 勢いを採る時間の幅（ms）。最後の1回だけを見ると止める直前の減速に引きずられる */
  velocityWindowMs: number
  /** 慣性を始める速度（px/ms） */
  flingMin: number
  /** 減衰の係数（16.7ms あたり） */
  friction: number
  /** 慣性を止める速度（px/ms） */
  stopSpeed: number
}

export const DEFAULT_TUNING: Tuning = {
  threshold: 8,
  directionCertainty: 4,
  horizontalRatio: 2,
  velocityWindowMs: 80,
  flingMin: 0.25,
  friction: 0.95,
  stopSpeed: 0.02,
}

/** 減衰を1フレームぶんと数える長さ（ms）。60fps の1コマ。 */
const FRAME_MS = 1000 / 60

export interface TouchScrollerOptions {
  /** 1行の高さ（px）。**0 を返したら何もしない**（隠れている間など） */
  cellHeight: () => number
  /** 行数ぶん動かす。**負が過去（上）へ** */
  scrollLines: (lines: number) => void
  /** その向きへ動かせるか。引数の符号は [`scrollLines`] と揃える */
  canScroll: (direction: number) => boolean
  now: () => number
  raf: (callback: () => void) => number
  cancelRaf: (handle: number) => void
  tuning?: Partial<Tuning>
}

export interface TouchScroller {
  /** 指が触れた。滑っている最中なら**その場で止める** */
  start: (points: TouchPoint[]) => void
  /**
   * 指が動いた。
   *
   * @returns 握ったか。呼び手は**この答えだけ**を見て `preventDefault()` を決める
   */
  move: (points: TouchPoint[]) => boolean
  /** 指が離れた。勢いが残っていれば滑り始める */
  end: () => void
  /** なぞりを取りやめる（`touchcancel`）。滑ってもいない */
  cancel: () => void
  /** 滑っているものを止める（端末を捨てるときなど） */
  stop: () => void
  running: () => boolean
}

/** 指を下へ動かすと過去へ遡る。`scrollLines` へ渡す符号に直す。 */
function directionOf(dy: number): number {
  return dy > 0 ? -1 : 1
}

export function createTouchScroller({
  cellHeight,
  scrollLines,
  canScroll,
  now,
  raf,
  cancelRaf,
  tuning,
}: TouchScrollerOptions): TouchScroller {
  const conf: Tuning = { ...DEFAULT_TUNING, ...tuning }

  /** `null` は「まだ決めていない」。一度決めたら指が離れるまで動かさない */
  let grabbed: boolean | null = null
  let engaged = false
  let startY = 0
  let startX = 0
  let lastY = 0
  /** 行に満たない移動量の持ち越し。丸めるとゆっくりの動きが全部消える */
  let carry = 0
  let samples: { t: number; y: number }[] = []
  let handle: number | null = null
  let velocity = 0

  /** 溜まった移動量を行数へ直して動かす。端数は持ち越す。 */
  function applyDelta(dy: number) {
    const height = cellHeight()
    if (height <= 0) {
      return
    }
    carry += dy
    const lines = Math.trunc(carry / height)
    if (lines === 0) {
      return
    }
    carry -= lines * height
    scrollLines(-lines)
  }

  function stopInertia() {
    if (handle !== null) {
      cancelRaf(handle)
      handle = null
    }
    velocity = 0
  }

  function reset() {
    grabbed = null
    engaged = false
    carry = 0
    samples = []
  }

  function step(previous: number) {
    const t = now()
    const dt = t - previous
    if (dt > 0) {
      applyDelta(velocity * dt)
      velocity *= conf.friction ** (dt / FRAME_MS)
    }
    if (Math.abs(velocity) < conf.stopSpeed || !canScroll(directionOf(velocity))) {
      stopInertia()
      return
    }
    handle = raf(() => step(t))
  }

  return {
    start(points) {
      // **滑っているのを止めたいだけの指**で、なぞりが始まってはいけない。
      // だから握るかどうかの判断より先に止める
      stopInertia()
      reset()
      if (points.length !== 1) {
        grabbed = false
        return
      }
      startX = points[0].x
      startY = points[0].y
      lastY = points[0].y
      samples = [{ t: now(), y: points[0].y }]
    },

    move(points) {
      if (points.length !== 1) {
        // ピンチなどはブラウザへ返す
        grabbed = false
        return false
      }
      const { x, y } = points[0]
      const totalY = y - startY
      const totalX = x - startX

      if (grabbed === null) {
        const reach = Math.max(Math.abs(totalX), Math.abs(totalY))
        if (reach === 0) {
          // 1ピクセルも動いていない。ブラウザもパンを始めようがないので握らない
          // （タップの邪魔をしない）
          return false
        }
        if (reach < conf.directionCertainty) {
          // **まだ向きを信用できない。握るだけ握って、決めるのは先送りする。**
          // ここで手放すと `cancelable` を失い、そのなぞりは二度と握れない。
          // 指は真っ直ぐ動き出さないので、ここを1サンプルで決めると実機で外す
          samples.push({ t: now(), y })
          lastY = y
          return true
        }
        if (Math.abs(totalX) > Math.abs(totalY) * conf.horizontalRatio) {
          // **はっきり横のときだけ手放す。** 斜めは端末側へ倒す——ここが「横のほうが
          // 少しでも大きければ手放す」だと、届く1歩目（実測で横30・縦15）が横に化ける
          grabbed = false
        } else {
          // **その向きへ動かせるときだけ握る。** 途中で端に着いた場合は握ったまま止まる
          grabbed = canScroll(directionOf(totalY))
        }
      }

      const t = now()
      samples.push({ t, y })
      const oldest = t - conf.velocityWindowMs
      while (samples.length > 2 && samples[0].t < oldest) {
        samples.shift()
      }

      if (!grabbed) {
        lastY = y
        return false
      }

      if (!engaged && Math.abs(totalY) >= conf.threshold) {
        engaged = true
      }
      if (engaged) {
        applyDelta(y - lastY)
      }
      lastY = y
      return true
    },

    end() {
      if (!grabbed || !engaged) {
        reset()
        return
      }
      const first = samples[0]
      const last = samples[samples.length - 1]
      const span = last.t - first.t
      velocity = span > 0 ? (last.y - first.y) / span : 0
      reset()
      if (Math.abs(velocity) < conf.flingMin || !canScroll(directionOf(velocity))) {
        velocity = 0
        return
      }
      const started = now()
      handle = raf(() => step(started))
    },

    cancel() {
      stopInertia()
      reset()
    },

    stop() {
      stopInertia()
    },

    running: () => handle !== null,
  }
}
