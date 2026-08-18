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
 * 値は CLI 側の `KEY_GAP`（`core/src/client/keys.rs`）の **30ms ＋1**。
 *
 * **1 多いのは、丸めのぶんである。** こちらは時計に `Date.now()` を使っており
 * **整数ミリ秒しか返さない**ので、`lastAt` を記録した時点で最大1ms が切り捨てられる。
 * 30 のままだと、実時間では 29.4ms しか空かないことがあった（E2E が実測して落ちた）。
 * CLI 側は `Duration` で測るので丸めが無く、あちらは 30 のままでよい。
 *
 * **狙いは「実時間で 30ms 以上」**であって数字を揃えることではないので、ここは +1 する。
 */
export const KEY_GAP_MS = 31

/** いま選択待ちか。**画面テキストから導いた結論だけ**を持つ（フックの印は混ぜない）。 */
const selecting = new Map<CardId, boolean>()

/** カードごとの見張り。`stores/sessions.ts` の `cardListeners` と同型。 */
const watchers = new Map<CardId, Set<() => void>>()

/** 端末の受け口。キーを**意味のまま**渡す。 */
const terminals = new Map<CardId, (key: TerminalKey) => void>()

/**
 * いまの画面を測り直す手。**見ている人が現れた瞬間に呼ぶ。**
 *
 * # なぜ要るのか（**実機で2度踏んだ**）
 *
 * 判定は `onWriteParsed`（フレームが届いたとき）でしか走らない。ところが
 * **選択待ちの画面は静止している**——`/rewind` のメニューは利用者が選ぶまで
 * 1バイトも動かない。したがって
 *
 * - タブを開き直した直後は、**メニューが出ているのに一度も判定されない**（出ない）
 * - 逆に、何かの拍子にフレームが流れ続けると判定も走り続ける（明滅する）
 *
 * **「出てこない」と「明滅する」は、同じ穴の裏表だった。** フレーム任せにせず、
 * **測る契機を自分で持つ**必要がある。
 */
const probes = new Map<CardId, () => boolean>()

interface Queue {
  keys: TerminalKey[]
  timer: ReturnType<typeof setTimeout> | null
  /** 最後に送った時刻。**空になっても捨てない**——捨てると次の1発が間隔を無視する */
  lastAt: number
}

const queues = new Map<CardId, Queue>()

const noop = () => {}

/**
 * 消すのを待つ長さ（ms）。**出すのは即座、消すのは待つ**という非対称にする。
 *
 * # なぜ非対称にするのか（**実機で輪を踏んだ**）
 *
 * 十字が出ると帯が高くなり、端末が縮み、`ResizeObserver → fit.fit() → resize` が
 * PTY まで飛んでいた（**この経路は桁行を固定した工事で無くなった**。`TerminalPane` の
 * `TERMINAL_GRID`）。**すると TUI が描き直し、その最中の画面は選択待ちに見えない**——
 * だから消える。消えると端末が伸び、また描き直され、メニューが戻り、また出る。
 *
 * ```
 * メニュー → 出す → 端末が縮む → 描き直し → 判定が偽 → 消す
 *                → 端末が伸びる → 描き直し → 判定が真 → 出す → …
 * ```
 *
 * **出す条件が、出したことで変わっている。** 自分の出力が自分の入力に戻る輪で、
 * 実機（`/rewind`）では毎秒何度も明滅して止まらなかった。
 *
 * # なぜ「待つ」で解けるのか
 *
 * 描き直しは**一過性**である。落ち着けば TUI は新しい大きさでメニューを描き直すので、
 * **その間だけ消さなければ、系は「十字が出ていて、メニューも見えている」へ収束する**。
 * 逆に出すほうを遅らせる理由は無い——遅らせると、押したい瞬間に出ていない。
 *
 * 値は「TUI の描き直しが終わるまで」を見込んだもの。**実機で詰めること**（設計§16）。
 *
 * # いまの役目は「ちらつかせないこと」だけ
 *
 * 上の輪は、十字を端末へ重ねる形（レイアウトを動かさない）で一度断ち、**桁行を固定した
 * 工事で経路そのものが消えた**。残しているのは、一過性の描き直しで一瞬消えるのを
 * 抑えるためである。**外しても輪は戻らない**ので、実機で邪魔なら短くしてよい。
 */
export const HIDE_SETTLE_MS = 600

/** 消すのを待っているカード。**出すが来たら取り消す。** */
const hiding = new Map<CardId, ReturnType<typeof setTimeout>>()

/** 待っている取り消しを解く。 */
function cancelHide(cardId: CardId): void {
  const timer = hiding.get(cardId)
  if (timer !== undefined) {
    clearTimeout(timer)
    hiding.delete(cardId)
  }
}

/**
 * 画面から導いた結論を置く。**同じ値なら何もしない。**
 *
 * ここが効かないと、`onWriteParsed` はフレームごとに呼ばれるので毎フレーム
 * 再描画されることになる。
 *
 * **消すときだけ [`HIDE_SETTLE_MS`] だけ待つ。** 理由は上記——待たないと、
 * 出したこと自体が端末を縮めて判定を覆し、明滅が止まらなくなる。
 */
export function setSelecting(cardId: CardId, value: boolean): void {
  if (value) {
    // **出すのは即座。** 待っていた取り消しがあれば、それも解く
    cancelHide(cardId)
    applySelecting(cardId, true)
    return
  }
  if (!(selecting.get(cardId) ?? false)) {
    // もともと出ていない。待つ意味が無い
    return
  }
  if (hiding.has(cardId)) {
    // もう待っている。**待ち直さない**——描き直しのあいだ判定は何度も偽を返すので、
    // そのたびに待ち直すと永久に消えなくなる
    return
  }
  hiding.set(
    cardId,
    setTimeout(() => {
      hiding.delete(cardId)
      applySelecting(cardId, false)
    }, HIDE_SETTLE_MS),
  )
}

/** 実際に置いて配る。 */
function applySelecting(cardId: CardId, value: boolean): void {
  if ((selecting.get(cardId) ?? false) === value) {
    return
  }
  // **既定へ戻るときは行を消す。** 書き込んで残すと、他の3つの表（`watchers` /
  // `terminals` / `queues`）が解除で消えるのに**ここだけ増え続ける**——長く開いた
  // タブでは、開いたカードの数だけ `false` が溜まる。読む側は `?? false` で
  // 既定へ落ちるので、消しても答えは変わらない
  if (value) {
    selecting.set(cardId, true)
  } else {
    selecting.delete(cardId)
  }
  const set = watchers.get(cardId)
  if (!set) {
    return
  }
  for (const listener of set) {
    listener()
  }
}

/**
 * いまの画面を測り直して置く。**測る手が無ければ何もしない。**
 *
 * 呼ぶ契機は**見ている人が現れたとき**の1つだけである。静止した画面では次のフレームが
 * 来ない——つまり「画面は変わっていないのに、まだ一度も測っていない」という継ぎ目を埋める。
 *
 * **かつては「端末の大きさが変わったとき」も呼んでいたが、その経路は無くなった**
 * （桁行を 120×40 に固定したので `term.onResize` が鳴らない。`TerminalPane` の
 * `TERMINAL_GRID`）。**鳴らないものを契機として数えない**ため、呼び出しごと外してある。
 *
 * したがって**判定が動く契機は2つ**——フレームが届いたとき（`onWriteParsed` が
 * [`setSelecting`] を直に呼ぶ）と、ここ。
 */
export function measure(cardId: CardId): void {
  const probe = probes.get(cardId)
  if (!probe) {
    return
  }
  setSelecting(cardId, probe())
}

/** 画面を測る手を登録する。返るのは解除。 */
export function registerProbe(cardId: CardId, probe: () => boolean): () => void {
  probes.set(cardId, probe)
  return () => {
    if (probes.get(cardId) === probe) {
      probes.delete(cardId)
    }
  }
}

/** そのカードを見ている人が居るか。**端末はこれを見てから画面を組み立てる。** */
/**
 * 「いま選択待ちか」の表に残っている行数。
 *
 * **読むだけの口で、製品コードは使わない。** それでも置いているのは、
 * **溜まっていないことを機械で見る手段が他に無い**ため——`useSelecting` は
 * `?? false` で既定へ落ちるので、行が残っていても答えは変わらない。
 * つまり漏れは**答えからは観測できない**（コードレビュー対応10）。
 */
export function selectingRows(): number {
  return selecting.size
}

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
  const 最初の1人 = found.size === 0
  found.add(listener)
  if (最初の1人) {
    // **見ている人が現れた瞬間に測る。** ここが無いと、静止した画面では
    // 次のフレームが来るまで（＝利用者が何か押すまで）永久に判定されない
    measure(cardId)
  }
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
    // **端末が消えるときは待たない。** 待つのは「描き直しの最中に消さない」ためで、
    // 端末そのものが居なくなったなら描き直しも来ない。待たせたままにすると、
    // 消えたカードの取り消しが後から発火する
    cancelHide(cardId)
    applySelecting(cardId, false)
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
