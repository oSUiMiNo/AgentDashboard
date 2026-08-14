/**
 * 押しっぱなしの連射（設計§8）。
 *
 * 判断を**時間を注入する純関数**として持つ。手本は `lib/touch.ts` の
 * [`createTouchScroller`] で、実時間を待たずにテストから駆動できる。
 *
 * # `setInterval` は使わない
 *
 * 詰まったぶんが一気に発火して**カーソルが吹き飛ぶ**。`setTimeout` の自己再帰にすれば、
 * 前の1発が終わってから次を測るので、遅れても間隔が詰まらない。
 *
 * # 加速しない
 *
 * 物理キーボードのリピートは全 OS で一定間隔である。速くしても「狙いを止められない」に
 * なるだけで、選択肢を1つずつ送る用途には向かない。
 *
 * # 止める契機は多重化する
 *
 * 押しっぱなしは**止め損ねると最悪の壊れ方をする**（指を離したのにカーソルが走り続ける）。
 * だから1つの経路に頼らない。
 *
 * | 契機 | どこが見るか |
 * |---|---|
 * | `pointerup` ／ `pointercancel` ／ `lostpointercapture` | [`bindRepeater`] |
 * | 画面が隠れた | [`createRepeater`] がティックごとに `hidden()` を見る |
 * | 消えた（アンマウント） | [`bindRepeater`] が返す解除 |
 * | 上限（発数・時間） | [`createRepeater`] が自分で止まる |
 *
 * **`pointerleave` は使えない。** タッチは `pointerdown` の時点で暗黙のポインタ
 * キャプチャが効いており、発火しない（調査レポート §4-4）。指がずれても押し続けられる
 * のはこのおかげなので、これは仕様であって不具合ではない。
 */

/** 触り心地を決める値。**実機で触って確定させる**（設計§16-3）。 */
export interface RepeatTuning {
  /** 1発目から2発目まで（ミリ秒） */
  initialDelayMs: number
  /** 以後の間隔（ミリ秒） */
  intervalMs: number
  /** 何発まで。止め損ねたときの最後の砦 */
  maxTicks: number
  /** 何ミリ秒まで。同上 */
  maxDurationMs: number
}

/**
 * 出発点の値。
 *
 * 400ms / 50〜60ms は AOSP の実値（`DEFAULT_KEY_REPEAT_TIMEOUT_MS` /
 * `DEFAULT_KEY_REPEAT_DELAY_MS`）で、**一次情報かつタッチ端末向け**なのでいちばん
 * 根拠が強い。55ms にしてあるのは、線の往復が詰まったときに間隔が縮まないよう
 * 少しだけ緩めた値である（調査レポート §4-3）。
 */
export const DEFAULT_REPEAT: RepeatTuning = {
  initialDelayMs: 400,
  intervalMs: 55,
  maxTicks: 200,
  maxDurationMs: 10_000,
}

export interface Repeater {
  /** 押した。**1発目はその場で出る** */
  start: () => void
  /** 止める。何度呼んでもよい */
  stop: () => void
  running: () => boolean
}

export interface RepeaterOptions {
  fire: () => void
  now: () => number
  setTimer: (callback: () => void, ms: number) => number
  clearTimer: (handle: number) => void
  /** 画面が隠れているか。**ティックごとに見る**——背面タブは減速するだけで止まらない */
  hidden: () => boolean
  tuning?: Partial<RepeatTuning>
}

export function createRepeater({
  fire,
  now,
  setTimer,
  clearTimer,
  hidden,
  tuning,
}: RepeaterOptions): Repeater {
  const conf: RepeatTuning = { ...DEFAULT_REPEAT, ...tuning }

  let handle: number | null = null
  let ticks = 0
  let startedAt = 0

  function stop(): void {
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
    ticks = 0
  }

  function schedule(ms: number): void {
    handle = setTimer(() => {
      handle = null
      tick()
    }, ms)
  }

  function tick(): void {
    // **止める理由を先に全部見る。** 送ってから気づくと1発余分に出る
    if (hidden() || ticks >= conf.maxTicks || now() - startedAt >= conf.maxDurationMs) {
      stop()
      return
    }
    fire()
    ticks += 1
    schedule(conf.intervalMs)
  }

  function start(): void {
    if (handle !== null) {
      // 既に押されている。二重に走らせない
      return
    }
    startedAt = now()
    ticks = 1
    // **1発目は押した瞬間。** WCAG 2.5.2 の Note 1 が「キーボードの押下を模す機能は
    // essential」と明記しており、押した瞬間の発火はここでは正しい
    fire()
    schedule(conf.initialDelayMs)
  }

  return { start, stop, running: () => handle !== null }
}

/**
 * 止める契機を配線する。返るのは解除で、**消えたときに止まる**ぶんを兼ねる。
 *
 * 契機を1つずつ別の行にしてあるのは、**どれか1つを外したときに落ちるテストが分かれる**
 * ようにするため。まとめて1行にすると、1通り壊しただけで全部落ちて、テストが何本ぶんの
 * 働きをしているのか分からなくなる。
 */
export function bindRepeater(target: EventTarget, repeater: Repeater): () => void {
  const stop = () => repeater.stop()
  target.addEventListener('pointerup', stop)
  target.addEventListener('pointercancel', stop)
  target.addEventListener('lostpointercapture', stop)
  return () => {
    target.removeEventListener('pointerup', stop)
    target.removeEventListener('pointercancel', stop)
    target.removeEventListener('lostpointercapture', stop)
    repeater.stop()
  }
}
