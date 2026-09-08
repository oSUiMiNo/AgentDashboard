/**
 * 一定間隔で引き直す（`サイドバーの一覧を、リロードせずに新しくする` 要件）。
 *
 * 判断を**時間を注入する純関数**として持つ。手本は [`lib/repeat.ts`] の
 * [`createRepeater`] で、実時間を待たずにテストから駆動できる。
 *
 * # これは「ポーリングするな」に反しない
 *
 * `README.md` の「フック受信（**ポーリングしない**）」は**セッションの状態**の話で
 * ある。取りこぼしが許されないものは、このプロジェクトでも巡回で担保している——
 * `transcript-parser/src/tail.rs` が「**正しさを担保しているのは 500ms の巡回で
 * あって、見張りは反応を速くするためだけに在る**」と明記している。
 *
 * | 立場 | 中身 |
 * |---|---|
 * | セッションの状態は押し出しで受ける | フックが運ぶ。巡回で代用しない |
 * | 取りこぼせないものは巡回で担保する | 見張りは速さのためだけに足す |
 *
 * フォルダの一覧は後者である。遅れても次の巡回で追いつく。
 *
 * # `setInterval` を使わない
 *
 * 詰まったぶんが一気に発火する。**寝ている PC への問い合わせは最大5秒かかりうる**
 * （`FolderBrowser.tsx` の注記）ので、`setInterval` だと**返る前に次が出る**。
 * `setTimeout` の自己再帰にし、**前の1発が終わってから次を測る**。
 *
 * # 裏にいる間は引かない
 *
 * 開きっぱなしのタブが何枚もあると、その全部が問い合わせる。しかも**ブラウザは
 * 隠れたタブのタイマーを間引く**ので、止めずに放っておくと「戻った瞬間に古いまま」
 * になる。だから**隠れている間は引かず、表へ戻った瞬間に引き直す**
 * （[`Poller.wake`]。`lib/sessions.ts` の `resync` と同じ考え）。
 *
 * **畳んだときに止めるぶんは、ここでは面倒を見ない。** サイドバーは畳むと
 * 木から消える（`useFilesParts.tsx` の `{open && <Sidebar/>}`）ので、
 * [`usePoll`] の後片付けがそのまま効く。
 *
 * # `lib/repeat.ts` と骨格が似ている
 *
 * `handle` / `schedule` / `tick` / `stop` と自己再帰の `setTimeout`、`hidden()` を
 * 見る形は、あちらとほぼ同じである。**それでも芯を共有していない**のは、
 * **待つかどうかが根本的に違う**ため——あちらの `fire` は同期で、こちらの `run` は
 * 待つ。待つ側には「飛行中か」「止めたあとに古い続きが積み直さないか」という
 * 別の問題が生じ、あちらには要らない世代の管理が要る。
 *
 * **芯を1つにするなら、この差を外から与える形にできる。** ただし `repeat.ts` は
 * 別の機能（押しっぱなしの連射）が使っているので、**そちらを巻き込む工事になる**。
 * いまは分けたまま置き、片方だけ直る差が実害になった時点でまとめる。
 */

import { useEffect, useRef } from 'react'

/**
 * 引き直す間隔。
 *
 * **利用者の指定は「10秒おきくらいでいいから」**（2026-09-04）。「くらい」なので
 * 厳密な根拠は無く、**動かせる値として置いてある**。
 *
 * **設定（`stores/settings.ts` の `Intervals`）には出していない。** 出すには
 * Rust 側の `portable.rs`・DB・設定の持ち出しまで揃って動かす必要があり、
 * **利用者が求めたのは「勝手に新しくなること」であって、つまみではない**。
 * 欲しくなったら `Intervals` へ3つ目として足せる（要件 (b)）。
 */
export const 一覧を引き直す間隔 = 10_000

export interface Poller {
  /** 測り始める。**その場では引かない**（初回は呼ぶ側が済ませている） */
  start: () => void
  /** 止める。何度呼んでもよい */
  stop: () => void
  /** 表へ戻った。**間隔を空けていれば**すぐ引いて、そこから測り直す */
  wake: () => void
  /** 生きているか。**引いている最中も生きている**と答える */
  running: () => boolean
}

export interface PollerOptions {
  /** 引く本体。**投げっぱなしにせず待つ**——終わってから次を測るため */
  run: () => Promise<void> | void
  intervalMs: number
  setTimer: (callback: () => void, ms: number) => number
  clearTimer: (handle: number) => void
  /** 隠れているか。**引く直前に見る**——測っている間に裏へ回ることがある */
  hidden: () => boolean
  /** いまの時刻。[`Poller.wake`] の下限を測るために要る */
  now: () => number
}

export function createPoller({
  run,
  intervalMs,
  setTimer,
  clearTimer,
  hidden,
  now,
}: PollerOptions): Poller {
  let handle: number | null = null
  /** いま引いている最中か。**重ねて引かない**——[`wake`] と時報が同時に来うる */
  let 引いている = false
  /** 止めたあとに古い `run` の続きが積み直さないための世代 */
  let 世代 = 0
  /** 最後に引き終わった時刻。[`wake`] の下限に使う */
  let 最後に引いた = Number.NEGATIVE_INFINITY

  function stop(): void {
    世代 += 1
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
    /*
      **飛行中の印も落とす。** 落とさないと、`run` が飛んでいる最中に
      `stop()` → `start()` とした poller が**二度と始まらない**——`start` の
      門で弾かれ、飛行中だった `run` が解けても世代が違うので誰も積み直さない。
      止めた時点でその `run` の結果は捨てる約束なので、印を残す意味も無い。
    */
    引いている = false
  }

  function schedule(この世代: number): void {
    if (この世代 !== 世代) {
      return
    }
    handle = setTimer(() => {
      handle = null
      void tick(この世代)
    }, intervalMs)
  }

  /**
   * 1回引く。**投げても呑む。**
   *
   * 呑まないと、`run` が投げた瞬間に [`tick`] が中断して**次の時報が二度と
   * 積まれない**（巡回が静かに死ぬ）うえ、呼び出しが `void` なので
   * **どこにも捕まらない拒否**になる。巡回は「遅れても次で追いつく」ものなので、
   * 1回の失敗で止めてはいけない。
   */
  async function 引く(): Promise<void> {
    引いている = true
    try {
      await run()
    } catch {
      // 呑む（上記）。理由を出すかどうかは `run` の側の仕事
    } finally {
      引いている = false
      最後に引いた = now()
    }
  }

  async function tick(この世代: number): Promise<void> {
    if (この世代 !== 世代) {
      return
    }
    try {
      // **隠れている間は引かない。** 測るのは続ける——表へ戻ったときに
      // [`wake`] が来ない経路でも、次の時報で追いつけるようにしておく
      if (!hidden() && !引いている) {
        await 引く()
      }
    } finally {
      // **必ず積む。** ここを `try` の外に置くと、途中で投げた回だけ
      // 巡回が止まる
      schedule(この世代)
    }
  }

  async function wake(): Promise<void> {
    if (hidden() || 引いている) {
      return
    }
    /*
      **間隔より短い往復では引かない。** タブを数秒おきに行き来されると、
      戻るたびに問い合わせが飛ぶ——`引いている` は同時実行しか防がないので、
      連続実行は素通りする。寝ている PC 相手は1回に最大5秒かかるので、
      10秒に1回という設計値を素で踏み越える。

      **見送っても困らない。** 3秒しか離れていなければ、中身も3秒しか古くない。
    */
    if (now() - 最後に引いた < intervalMs) {
      return
    }
    // 測り直す。**古い時報を残すと、戻った直後に2回引く**
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
    const この世代 = 世代
    try {
      await 引く()
    } finally {
      schedule(この世代)
    }
  }

  return {
    start: () => {
      // **引いている最中も断る。** そのときは `handle` が空いているので、
      // ここを通すと時報が2本になる（引き終わった1本が、もう1本を積む）
      if (handle !== null || 引いている) {
        return
      }
      schedule(世代)
    },
    stop,
    wake: () => void wake(),
    // **飛行中も「生きている」と答える。** `tick` が入り口で `handle` を
    // 空けるので、`handle` だけを見るといちばん動いている瞬間に「止まっている」
    // と答えることになる
    running: () => handle !== null || 引いている,
  }
}

/**
 * [`createPoller`] を React へ繋ぐ。
 *
 * **`run` は毎描画で作り直されてよい。** 最新のものを `useRef` に写して呼ぶので、
 * 関数が変わってもタイマーは張り直さない——`useFilesParts.tsx` の警告
 * （「渡すたびに新しい関数だと、効果が走る → 状態が変わる → また新しい関数、と
 * **問い合わせが回り続ける**」）が、巡回では10秒おきどころでは済まなくなるため。
 *
 * **写すのは効果の中で行う。** 描画の最中に `ref` へ書くと、**コミットされずに
 * 捨てられた描画の `run` が残りうる**（React が禁じている書き方）。残ると、
 * 画面に出ていない場所を引いて、その結果で画面を書き換えることになる。
 *
 * **消えたら止まる。** サイドバーは畳むと木から消えるので、これが
 * 「畳んでいる間は問い合わせない」を兼ねる。
 */
export function usePoll(
  run: () => Promise<void> | void,
  intervalMs: number,
): void {
  const 最新 = useRef(run)
  // **描画中には書かない**（上記）。効果は下の効果より先に宣言してあるので、
  // 初回の時報が鳴る前に必ず入る
  useEffect(() => {
    最新.current = run
  })

  useEffect(() => {
    const poller = createPoller({
      run: () => 最新.current(),
      intervalMs,
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle),
      hidden: () => document.visibilityState !== 'visible',
      now: () => Date.now(),
    })
    const 起きた = () => {
      if (document.visibilityState === 'visible') {
        poller.wake()
      }
    }
    poller.start()
    document.addEventListener('visibilitychange', 起きた)
    return () => {
      document.removeEventListener('visibilitychange', 起きた)
      poller.stop()
    }
  }, [intervalMs])
}
