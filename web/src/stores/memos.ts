/**
 * メモの手元の写し（メモ設計§7-1）。
 *
 * # 並べ直さない
 *
 * **並びはサーバが決めている。** `ServerMessage::memos` は宛先ぶんを**丸ごと**運び、
 * **受け取った順がそのまま画面の順**である。ここで並べ直してはいけない——
 * **並びを決める場所が2つに割れる**と、端末ごとに時計が違うぶんだけ順が食い違う。
 *
 * 画面がやってよいのは**2段に割ること**だけで（上＝チェック済み／下＝未チェック）、
 * **段の中の順はサーバの順のまま**である（[`splitMemos`]）。
 *
 * # 宛先ごとに箱を分ける
 *
 * 鍵は [`targetKey`] から取る。**綴りを直接書かない**——書きかけの予約鍵と綴りが
 * 割れると、同じ宛先が2つの箱に入る。
 *
 * # `checked_at` は空だと欄ごと消える
 *
 * Rust 側が `skip_serializing_if` を付けているので、**未チェックのメモには欄そのものが
 * 無い**。`=== null` で見ると**未チェックを取り落とす**ので、`undefined` で判定する。
 */

import { useSyncExternalStore } from 'react'

import { targetKey } from '@/lib/annotationTarget'
import type { AnnotationTarget, MemoView } from '@/lib/protocol'

/** 宛先の鍵 → その宛先のメモ（サーバが決めた順のまま）。 */
let 箱: Record<string, readonly MemoView[]> = {}

const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** まだ届いていない宛先に返す不変の配列。**毎回新しい配列を返すと購読が無限に鳴る。** */
const 空: readonly MemoView[] = []

/**
 * サーバから届いた宛先ぶんを置き換える。
 *
 * **足すのではなく置き換える。** 配信が丸ごとなので、差分を当てる必要が無い——
 * 1件の編集でその1件が段をまたいで動くため、差分にすると受け手が並べ直すことになる。
 */
export function replaceMemos(target: AnnotationTarget, memos: readonly MemoView[]) {
  箱 = { ...箱, [targetKey(target)]: memos }
  notify()
}

/** その宛先のメモ。まだ届いていなければ空。 */
export function memosFor(target: AnnotationTarget): readonly MemoView[] {
  return 箱[targetKey(target)] ?? 空
}

/** その宛先のメモを購読する。 */
export function useMemos(target: AnnotationTarget): readonly MemoView[] {
  const key = targetKey(target)
  return useSyncExternalStore(
    subscribe,
    () => 箱[key] ?? 空,
    () => 空,
  )
}

/**
 * 2段に割る（メモ設計§7-1）。
 *
 * | 段 | 中身 |
 * |---|---|
 * | 上 | チェック済み（`checked_at` が入っている） |
 * | 下 | 未チェック（`checked_at` が空） |
 *
 * **どちらも順はサーバのまま。** ここでするのは仕分けだけである。
 */
export function splitMemos(memos: readonly MemoView[]): {
  checked: readonly MemoView[]
  unchecked: readonly MemoView[]
} {
  const checked: MemoView[] = []
  const unchecked: MemoView[] = []
  for (const memo of memos) {
    // **`=== null` で見ない。** 欄ごと消えて届くので `undefined` になる
    if (memo.checked_at === undefined) {
      unchecked.push(memo)
    } else {
      checked.push(memo)
    }
  }
  return { checked, unchecked }
}

/** テスト用の巻き戻し。**製品コードから呼ばない。** */
export function clearMemos() {
  箱 = {}
  notify()
}
