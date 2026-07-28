/**
 * 経過時間の表示に使う共有の時計。
 *
 * 小窓は「最終活動 3分前」を1秒刻みで出す。これは**セッションの状態とは無関係に
 * 進み続ける**値なので、セッションのストア（[`@/stores/sessions`]）とは別に持つ。
 *
 * # タイマーは何個購読されても1本
 *
 * 小窓ごとに `setInterval` を持たせると、セッションが増えるほどタイマーが増えて
 * 更新の時刻が散らばる。かといって一覧の親が1つ持って配ると、毎秒親が作り直され、
 * 状態が変わっていない小窓まで巻き込んで再レンダリングされる。
 *
 * そこで **React の外に1本だけ持ち、各コンポーネントが直接購読する**形にした。
 * タイマーは1本のまま、毎秒の再描画は「経過時間を出している要素」だけに閉じる。
 * 購読者が居なくなればタイマーも止まる。
 */

import { useSyncExternalStore } from 'react'

/** 1秒刻み。小窓の経過時間表示の粒度に合わせている。 */
const TICK_MS = 1000

let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    // 購読が途切れている間は時刻が止まる（タイマーを畳んでいるため）。再開の瞬間に
    // 現在時刻へ合わせ直さないと、しばらく古い経過時間が出たままになる
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const each of listeners) {
        each()
      }
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** 1秒ごとに進む現在時刻。 */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )
}
