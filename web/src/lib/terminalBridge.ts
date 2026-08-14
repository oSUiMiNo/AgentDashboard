/**
 * 端末と、その外側の画面をつなぐ橋（設計§2）。
 *
 * # なぜ要るのか
 *
 * 「いま選択待ちか」は端末の画面テキストからしか分からないが、その画面は
 * `TerminalPane` の `useEffect` のクロージャの中にしかない。入力欄（`Composer`）は
 * その**兄弟**なので、判定の結果を受け取れない。逆向きも同じで、外から端末へキーを
 * 送る手段が無い。
 *
 * **この工事の骨格は、その道を1本通すことである。** 十字ボタンは、その道の上に載る
 * 最初の利用者にすぎない。
 *
 * # 2車線を1つのモジュールに置く
 *
 * 向きは逆だが、**寿命も鍵も同じ**である。どちらも `TerminalPane` の
 * `useEffect(…, [cardId])` の中で登録し、同じ `return` で解除する。分けて置くと
 * 「片方だけ解除されて、消えた端末へキーを送り続ける」という壊れ方を自分で作る。
 *
 * # 12枚並べても壊れない根拠
 *
 * `GroupView` はカードを横並びにするので、性能の議論から逃げられない。
 *
 * 1. **同値なら通知しない。** [`setSelecting`] はフレームごとに呼ばれるが、実際に
 *    listener が走るのは**選択待ちの出入りの2回だけ**
 * 2. **見ている人が居なければ、端末は画面を組み立てない**（[`hasWatcher`]）。PC では
 *    購読者が0なので、解析コストが丸ごとゼロになる
 * 3. **通知の粒度がカード単位**（`stores/sessions.ts` の `notifyCard` と同型）
 * 4. **`getSnapshot` は boolean を返す。** オブジェクトだと参照が毎回変わり、
 *    `useSyncExternalStore` が無限に回る
 *
 * # `useWsStore.subscribeTerminal` には触らない
 *
 * あれは `terminals.set(cardId, …)` の**後勝ちで単一購読**なので、ここが第2の購読を
 * 張ると `TerminalPane` への配信が黙って止まる。橋が見るのは xterm のパース済み
 * イベントだけで、WebSocket の購読には関与しない。
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { TerminalKey } from '@/lib/keys'
import type { CardId } from '@/lib/protocol'

/**
 * 続けてキーを送るときに空ける間隔（ミリ秒）。
 *
 * **サーバ側は1フレーム＝1 write** になっているが、それでも**カーネルが結合しうる**
 * ——`ESC` と次のバイトを 0ms 間隔で別々に書いても1チャンクにまとまり、Alt+その文字と
 * して食われることを実測してある（調査レポート §2-2）。
 *
 * 値は CLI 側の `KEY_GAP`（`core/src/client/keys.rs`）に揃えてある。**同じ地雷を
 * 2箇所で別々の値で踏まない。**
 */
export const KEY_GAP_MS = 30

/** いま選択待ちか。**画面テキストから導いた結論だけ**を持つ（フックの印は混ぜない）。 */
const selecting = new Map<CardId, boolean>()

/** カードごとの見張り。`stores/sessions.ts` の `cardListeners` と同型。 */
const watchers = new Map<CardId, Set<() => void>>()

/** 端末の受け口。キーを**意味のまま**渡す。 */
const terminals = new Map<CardId, (key: TerminalKey) => void>()

interface Queue {
  keys: TerminalKey[]
  timer: ReturnType<typeof setTimeout> | null
  /** 最後に送った時刻。**空になっても捨てない**——捨てると次の1発が間隔を無視する */
  lastAt: number
}

const queues = new Map<CardId, Queue>()

const noop = () => {}

/**
 * 画面から導いた結論を置く。**同じ値なら何もしない。**
 *
 * ここが効かないと、`onWriteParsed` はフレームごとに呼ばれるので毎フレーム
 * 再描画されることになる。
 */
export function setSelecting(cardId: CardId, value: boolean): void {
  if ((selecting.get(cardId) ?? false) === value) {
    return
  }
  selecting.set(cardId, value)
  const set = watchers.get(cardId)
  if (!set) {
    return
  }
  for (const listener of set) {
    listener()
  }
}

/** そのカードを見ている人が居るか。**端末はこれを見てから画面を組み立てる。** */
export function hasWatcher(cardId: CardId): boolean {
  return (watchers.get(cardId)?.size ?? 0) > 0
}

function subscribeSelecting(cardId: CardId, listener: () => void): () => void {
  let set = watchers.get(cardId)
  if (!set) {
    set = new Set()
    watchers.set(cardId, set)
  }
  const found = set
  found.add(listener)
  return () => {
    found.delete(listener)
    if (found.size === 0) {
      watchers.delete(cardId)
    }
  }
}

/**
 * そのカードが選択待ちかを購読する。
 *
 * # `enabled` を引数に持つ理由
 *
 * フックは条件付きで呼べない（順序が変わる）。かといって PC でも購読すると、
 * 「見ている人が居なければ組み立てない」が成立しなくなる。そこで**引数で購読そのものを
 * 止める**——偽なら何も登録せず、常に偽を返す。
 */
export function useSelecting(cardId: CardId, enabled = true): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeSelecting(cardId, listener) : noop,
    [cardId, enabled],
  )
  const read = useCallback(
    () => (enabled ? (selecting.get(cardId) ?? false) : false),
    [cardId, enabled],
  )
  return useSyncExternalStore(subscribe, read, () => false)
}

/**
 * 端末の受け口を登録する。返るのは解除で、**3つとも片付ける**。
 *
 * | 片付けるもの | 忘れるとどうなるか |
 * |---|---|
 * | 受け口 | 消えた端末へキーを送ろうとする |
 * | 送信待ちの列 | 待っていたキーが、消えたあとに遅れて届く |
 * | 選択待ちの値 | カードが消えたあとも「選択待ちだった」が残る |
 *
 * **登録し直された相手は消さない**（`===` で確かめてから消す）。同じカードで端末が
 * 作り直されたとき、古い解除が新しい受け口を巻き添えにしないため。
 */
export function registerTerminal(
  cardId: CardId,
  send: (key: TerminalKey) => void,
): () => void {
  terminals.set(cardId, send)
  return () => {
    if (terminals.get(cardId) === send) {
      terminals.delete(cardId)
    }
    dropQueue(cardId)
    setSelecting(cardId, false)
  }
}

/**
 * キーを1つ頼む。**前回から [`KEY_GAP_MS`] 空くまで待ってから送る。**
 *
 * 受け口が無いカードへの依頼は黙って捨てる（閉じた直後に届いたぶんで壊さない）。
 */
export function sendTerminalKey(cardId: CardId, key: TerminalKey): void {
  if (!terminals.has(cardId)) {
    return
  }
  let queue = queues.get(cardId)
  if (!queue) {
    queue = { keys: [], timer: null, lastAt: 0 }
    queues.set(cardId, queue)
  }
  queue.keys.push(key)
  pump(cardId)
}

function pump(cardId: CardId): void {
  const queue = queues.get(cardId)
  if (!queue || queue.timer !== null || queue.keys.length === 0) {
    return
  }
  const wait = queue.lastAt + KEY_GAP_MS - Date.now()
  if (wait > 0) {
    queue.timer = setTimeout(() => {
      queue.timer = null
      pump(cardId)
    }, wait)
    return
  }
  const key = queue.keys.shift()
  if (key === undefined) {
    return
  }
  queue.lastAt = Date.now()
  terminals.get(cardId)?.(key)
  // 残りがあれば、次は必ず待ちに入る（上の `wait` が正になるため）
  pump(cardId)
}

function dropQueue(cardId: CardId): void {
  const queue = queues.get(cardId)
  if (!queue) {
    return
  }
  if (queue.timer !== null) {
    clearTimeout(queue.timer)
  }
  queues.delete(cardId)
}
