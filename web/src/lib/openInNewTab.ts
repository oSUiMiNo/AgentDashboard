/**
 * 「新しいタブで開く」の押し方を、1箇所で決める。
 *
 * # 規則（**別のイシューもここへ揃える**）
 *
 * **新しいタブに割り当てるのは3つだけ。**
 *
 * | 押し方 | 合図 |
 * |---|---|
 * | **中クリック** | `auxclick` の `button === 1` |
 * | **Ctrl＋左クリック** | `click` の `button === 0` ＋ `ctrlKey` |
 * | **Cmd＋左クリック**（Mac） | `click` の `button === 0` ＋ `metaKey` |
 *
 * **中ボタンと修飾キーの両方を取るのは、端末によって道が違うから。** 中ボタンの無い
 * ノート PC のタッチパッドでは Ctrl／Cmd しか道が無く、Mac の作法は Cmd である。
 * 片方だけにすると、届かない人が残る。
 *
 * **Shift は取らない。** 取らなければ既存の押し分けがそのまま効く。
 *
 * # `<a href>` にできるものは、ここを使わない
 *
 * **素のリンクなら、中クリックも修飾キーも右クリックのメニューも、ブラウザが最初から
 * 持っている。** 自分で書けば書くほど、Shift で新しい窓・Cmd で背面タブといった作法を
 * 壊す。**だから `<a>` にできるものは `<a>` に任せる。**
 *
 * ここが要るのは、**リンクにできない2つ**だけである。
 *
 * | 何 | なぜリンクにできないか |
 * |---|---|
 * | **一覧のカード** | 選択状態を `aria-pressed` だけで伝えている（印の点を外したので、**色以外の道はこれ1本**）。`aria-pressed` は `button` の役割にしか意味が無く、リンクへ移すと支援技術へ伝わらなくなる。加えて `usePress` の Enter は `HTMLButtonElement` かどうかで分かれており、リンクにすると**自分で開いたうえに既定の動作でも開く** |
 * | **PJT の枠** | `<section>` の中にカード・＋・× という**押せるものが入っている**。押せるものを入れ子にしたリンクは成り立たず、支援技術から中身が消える |
 *
 * # 決める側と、DOM を触る側を分ける
 *
 * `press.ts` ↔ `usePress.ts`、`reorder.ts` ↔ `useReorder.ts` と同じ形。**上半分は
 * `window` も `document` も読まない純関数**なので、jsdom が何を返すかに左右されない。
 *
 * # 受けたら、後ろの押し分けを走らせない
 *
 * `onClick` は**既存の押し分けと同じ合図**を見る。素朴に重ねると、Ctrl＋クリックで
 * **新しいタブが開いたうえにカードが選ばれる**——同じ要素に付いた兄弟のハンドラは
 * `stopPropagation()` では止まらないためである。だから `onClick` は
 * **受けたかどうかを返し**、呼び元は [`受けたら止める`] で重ねる。
 */

import { useMemo } from 'react'
import { NO_GRAB_ATTR } from './useGrip'

/** 判定に要るぶんだけ。**素の `MouseEvent` でも React の合成イベントでも通る形にする** */
export interface PressLike {
  type: string
  button: number
  ctrlKey: boolean
  metaKey: boolean
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
 * その `mousedown` で、ブラウザの自動スクロールを止めるか。
 *
 * **中ボタンを押すと丸いアイコンが出て勝手にスクロールする**のが既定の動き。止める道は
 * `mousedown` の `preventDefault()` しか無い。
 *
 * **主ボタンでは呼ばない。** 呼ぶと焦点が動かなくなり、キーボードで辿れなくなる。
 *
 * **器の中の押せるものでも止める。** あそこで開かないことと、丸いアイコンを出さないことは
 * 別の話——ゴミ箱を中クリックしたときだけ画面が勝手に流れるほうが、よほど驚く。
 */
export function suppressesAutoscroll(event: PressLike): boolean {
  return event.type === 'mousedown' && event.button === 1
}

/**
 * **先の手が受けたら、後ろを走らせない。**
 *
 * `handlers.ts` の `重ねる` は全部呼ぶ道具で、こちらは**止まる道具**。同じ要素に付いた
 * 兄弟のハンドラは `stopPropagation()` では止まらないので、返り値で伝える。
 */
export function 受けたら止める<E>(
  受け手: (event: E) => boolean,
  ...残り: (((event: E) => void) | undefined)[]
): (event: E) => void {
  return (event: E) => {
    if (受け手(event)) {
      return
    }
    for (const 手 of 残り) {
      手?.(event)
    }
  }
}

interface Handler {
  type: string
  button: number
  ctrlKey: boolean
  metaKey: boolean
  target: EventTarget | null
  preventDefault: () => void
  stopPropagation: () => void
}

export interface NewTabBinding {
  /** 中クリック。**受けたら真**（返り値は React が捨てるので、そのまま渡してよい） */
  onAuxClick: (event: Handler) => boolean
  /** Ctrl／Cmd＋左クリック。**[`受けたら止める`] で押し分けと重ねる** */
  onClick: (event: Handler) => boolean
  /** ブラウザの自動スクロール止め */
  onMouseDown: (event: Handler) => void
}

/**
 * 押し方を DOM の合図へ配線する。
 *
 * @param path 行き先。**既にある組み立て（`lib/routes.ts`）を渡す**——ここで文字列を組まない
 */
export function useOpenInNewTab(path: string): NewTabBinding {
  return useMemo(() => {
    const 開く = (event: Handler): boolean => {
      if (fromInnerControl(event.target)) {
        // 器の中の押せるもの。**あれは別の意味を持つ**
        return false
      }
      if (!wantsNewTab(event)) {
        // **受けていない。** 後ろの押し分けへそのまま渡す
        return false
      }
      /*
        **`noopener` を必ず付ける。** 付けないと開いた先から `window.opener` で
        こちらのタブを触れる。
      */
      window.open(path, '_blank', 'noopener')
      /*
        **受けたときだけ止める。** 枠の中のカードを中クリックしたとき、枠まで泡立つと
        **カードと PJT の2枚が開く**。既定の動作も止める——中クリックには
        ブラウザ側の意味（貼り付け）が残っている。
      */
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    return {
      onAuxClick: 開く,
      onClick: 開く,
      onMouseDown: (event: Handler) => {
        if (!suppressesAutoscroll(event)) {
          return
        }
        // **丸いアイコンを出させない。** 止める道はここしか無い
        event.preventDefault()
      },
    }
  }, [path])
}
