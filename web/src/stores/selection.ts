/**
 * 一覧で選んでいるもの（並べ替え設計§5-1・§5-6）。
 *
 * # 覚えない
 *
 * **一時的な画面の状態**なので、リロードで消える（設計§5-6）。覚えると「前に開いた
 * ときに選んだままのもの」が残り、次に押した操作がどこへ効くのか分からなくなる。
 *
 * # 枠とカードを混ぜない
 *
 * 先に選んだ種類で決まり、違う種類を押すと**そちらへ選び直す**（設計§5-1）。
 * 混ぜられると、まとめて操作の帯に出すボタンが選択の中身で出たり消えたりする
 * ——電源マークはカードにしか意味を持たない。
 */

import { useSyncExternalStore } from 'react'

export type SelectionKind = 'project' | 'card'

export interface Selection {
  /** 何を選んでいるか。1つも選んでいなければ `null` */
  kind: SelectionKind | null
  /** 選んでいるものの ID。並びは押した順 */
  ids: readonly string[]
}

const 空: Selection = { kind: null, ids: [] }

let selection: Selection = 空
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSelection(): Selection {
  return selection
}

/** いま何か選んでいるか（＝触る画面の選択モードに入っているか）。 */
export function isSelecting(): boolean {
  return selection.ids.length > 0
}

/**
 * 1つ選ぶ／外す。
 *
 * **押すたびに増え、もう一度押すと外れる**（修飾キーは要らない。設計§4-1）。
 * **違う種類を押したら、そちらへ選び直す**——混ぜない（§5-1）。
 */
export function toggleSelect(kind: SelectionKind, id: string): void {
  if (selection.kind !== kind) {
    selection = { kind, ids: [id] }
    notify()
    return
  }
  const ids = selection.ids.includes(id)
    ? selection.ids.filter((each) => each !== id)
    : [...selection.ids, id]
  // **1つも無くなったら種類ごと捨てる。** 残すと、次に別の種類を押したときに
  // 「選び直し」なのか「足す」なのかが選択の中身で変わる
  selection = ids.length === 0 ? 空 : { kind, ids }
  notify()
}

/**
 * **必ず選ぶ**（並べ替え設計§15-5）。長押しで掴むときに使う。
 *
 * `toggleSelect` だと、**既に選ばれているものを長押しして掴んだ瞬間に選択が外れる**
 * （「色が消えた的を運ぶ」）。違う種類なら選び直し（§5-1）、既に選んでいれば何もしない
 * （通知もしない）。
 */
export function select(kind: SelectionKind, id: string): void {
  if (selection.kind !== kind) {
    selection = { kind, ids: [id] }
    notify()
    return
  }
  if (selection.ids.includes(id)) {
    return
  }
  selection = { kind, ids: [...selection.ids, id] }
  notify()
}

/** 全部外す。**選択モードから抜ける道**（設計§4-2）。 */
export function clearSelection(): void {
  if (selection.ids.length === 0) {
    // 同じ中身なら通知しない（`useSyncExternalStore` が無駄に回らないように）
    return
  }
  selection = 空
  notify()
}

/** そのものが選ばれているか。 */
export function isSelected(kind: SelectionKind, id: string): boolean {
  return selection.kind === kind && selection.ids.includes(id)
}

export function useSelection(): Selection {
  return useSyncExternalStore(subscribe, getSelection, getSelection)
}

/** テストのための巻き戻し。 */
export function clearSelectionStore(): void {
  selection = 空
  listeners.clear()
}
