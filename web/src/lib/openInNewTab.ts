/**
 * 「新しいタブで開く」かどうかを決める規則（**別のイシューもここへ揃える**）。
 *
 * # 規則
 *
 * **新しいタブに割り当てるのは3つだけ。**
 *
 * | 押し方 | 合図 |
 * |---|---|
 * | **中クリック** | `auxclick` の `button === 1` |
 * | **Ctrl＋左クリック** | `click` の `button === 0` ＋ `ctrlKey` |
 * | **Cmd＋左クリック**（Mac） | `click` の `button === 0` ＋ `metaKey` |
 *
 * キーボードからは **Ctrl／Cmd＋Enter** が同じ意味を持つ（ブラウザがリンクに対して
 * そうしているのに揃える）。
 *
 * **中ボタンと修飾キーの両方を取るのは、端末によって道が違うから。** 中ボタンの無い
 * ノート PC のタッチパッドでは Ctrl／Cmd しか道が無く、Mac の作法は Cmd である。
 *
 * **Shift と Alt は自分では見ない。** Shift を足すと「新しいウィンドウ」を自前で
 * 実装することになり、Alt はブラウザでは保存（ダウンロード）である。**どちらも
 * リンクにしか無い作法なので、リンクにできないものが真似をしない。**
 * ただし **Ctrl＋Shift＋クリックは弾かない**——ブラウザではあれも「新しいタブ（前面）」
 * なので、Shift が付いているだけで選択に落ちるほうが驚く。
 *
 * # `<a href>` にできるものは、ここを使わない
 *
 * **素のリンクなら、中クリックも修飾キーも右クリックのメニューも、ブラウザが最初から
 * 持っている。** ここが要るのは、**リンクにできない2つ**だけである。
 *
 * | 何 | なぜリンクにできないか |
 * |---|---|
 * | **一覧のカード** | 選択状態を `aria-pressed` だけで伝えている（印の点を外したので、**色以外の道はこれ1本**）。`aria-pressed` は `button` の役割にしか意味が無く、リンクへ移すと支援技術へ伝わらなくなる。加えて `usePress` の Enter は `HTMLButtonElement` かどうかで分かれており、リンクにすると**自分で開いたうえに既定の動作でも開く** |
 * | **PJT の枠** | `<section>` の中にカード・＋・× という**押せるものが入っている**。押せるものを入れ子にしたリンクは成り立たず、支援技術から中身が消える |
 *
 * **サイドバーのファイル（`FolderBrowser`）とは、判定の向きが逆である。** あちらは
 * 本物のリンクなので「**素の左クリックか**（＝自分で捌く）」を見る。こちらはリンクで
 * ないので「**新しいタブの合図か**（＝ブラウザの代わりをする）」を見る。**同じ述語の
 * 重複ではなく補集合**なので、片方を他方から呼ぶと意味が捻れる。
 *
 * # 決める側と、DOM を触る側を分ける
 *
 * ここは `window` も `document` も読まない純関数だけを置く（`press.ts` ↔ `usePress.ts`、
 * `reorder.ts` ↔ `useReorder.ts` と同じ形）。**配線するのは `usePress` の仕事**——
 * 押し分けを2つのフックに割ると、`dblclick` と `keydown` が手作業の穴になる
 * （設計§4-1「押し分けは1箇所で決める」。実際に3つ穴が空いた）。
 */

import { NO_GRAB_ATTR } from './useGrip'

/** 判定に要るぶんだけ。**素の `MouseEvent` でも React の合成イベントでも通る形にする** */
export interface PressLike {
  type: string
  button: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * その押し方は「新しいタブで開く」か。
 *
 * **中ボタンは `auxclick` でしか受けない。** `click` 側でも `button === 1` を拾うと、
 * ブラウザによっては両方飛んできて**2枚開く**。入口を1つに決めておく。
 */
export function wantsNewTab(event: PressLike): boolean {
  if (event.type === 'auxclick') {
    return event.button === 1
  }
  if (event.type === 'click') {
    // **Mac は Cmd（`metaKey`）。** `ctrlKey` だけ見ると Mac ではまず効かない
    return event.button === 0 && (event.ctrlKey || event.metaKey)
  }
  return false
}

/**
 * キーボードからの「新しいタブで開く」か。
 *
 * **`<button>` は Ctrl＋Enter でも `click`（`ctrlKey` 付き・`detail === 0`）を出す**ので、
 * カードだけならこの関数は要らない。**枠（`<section>`）は `click` を出さない**ので、
 * ここが無いと**同じキーを押して、カードは新しいタブ・枠はいまのタブ**という食い違いが残る。
 */
export function wantsNewTabByKey(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey)
}

/**
 * その合図は、器の中の**押せるもの**から出たか。
 *
 * 鉛筆・ゴミ箱・電源・＋・×・知らせのベル・名前の編集欄には、既に
 * [`NO_GRAB_ATTR`] が付いている——**「押せるものなので、器の操作を発火させない」**
 * という意味がそのまま当てはまるので、印を増やさずに使い回す。
 */
export function fromInnerControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${NO_GRAB_ATTR}]`) !== null
}

/**
 * 字を打ち込むところか。
 *
 * **Linux（X11）では、中クリックは「選んだ文字を貼り付ける」という OS の作法**である。
 * 入力欄の上でそれを止めると、**このアプリの中でだけ貼り付けが効かない**という形になる
 * ——自動スクロールを止めるより、そちらのほうが害が大きい。
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') !== null
}

/**
 * その `mousedown` で、ブラウザの自動スクロールを止めるか。
 *
 * **中ボタンを押すと丸いアイコンが出て勝手にスクロールする**のが既定の動き。止める道は
 * `mousedown` の `preventDefault()` しか無い。
 *
 * **主ボタンでは呼ばない。** 呼ぶと焦点が動かなくなり、キーボードで辿れなくなる。
 */
export function suppressesAutoscroll(event: PressLike): boolean {
  return event.type === 'mousedown' && event.button === 1
}

/**
 * 新しいタブで開く。
 *
 * **返り値は見ない。** `noopener` を付けた `window.open` は**成功しても `null` を返す**
 * （開いた先から `window.opener` を辿らせないための仕様）ので、`null` を失敗として
 * 扱うと**必ず失敗と判定される**。開けたかどうかをここで知る道は無い。
 *
 * `noopener` 自体は外せない——外すと、開いた先のページからこちらのタブを触れる。
 */
export function openNewTab(path: string): void {
  window.open(path, '_blank', 'noopener')
}
