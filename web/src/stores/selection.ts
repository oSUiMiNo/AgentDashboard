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
 * 先に選んだ種類で決まる（設計§5-1）。混ぜられると、まとめて操作の帯に出すボタンが
 * 選択の中身で出たり消えたりする——電源マークはカードにしか意味を持たない。
 *
 * # ここは policy を持たない（**入れかけて戻した**・2026-09-08）
 *
 * 「何か選んでいる間に別の種類を押したら**解くだけ**」という規則が入ったとき、いったん
 * この `toggleSelect` を「違う種類なら解く」へ書き換えた。**戻した。**
 *
 * **判定の正は `lib/press.ts` の `pressMapping` ただ1つ**（設計§4-1「判定は1箇所に集める」）。
 * ここへ同じ規則を置くと、**押し方を通らない呼び出し元まで巻き添えになる**——実際、
 * `GroupView` の掴み手のタップ（`onTap`。掴まずに離したら選ぶ、という §4-4 の保険）が
 * **選ぶのをやめて解くようになっていた**。あちらは名指しで「これを選ぶ」と言う操作なので、
 * 押し間違いの話が当てはまらない。
 *
 * したがってここは**素直な入れ物**のままにする。「解くだけ」を実行するのは、
 * `pressMapping` の答えを受け取る `usePress` である。
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
 *
 * **「解くだけ」はここではやらない**（上の段）。一覧の押し方としては解くのが正だが、
 * それを決めるのは `pressMapping` で、ここまで来る前に振り分けられている。
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
 * （「色が消えた的を運ぶ」）。既に選んでいれば何もしない（通知もしない）。
 *
 * **違う種類なら選び直す**（§5-1）。長押しは「**これを選ぶ**」と名指しする操作なので、
 * 押し間違いの話が当てはまらない——**触る画面では、これが1動作で種類を選び直す道**である
 * （タップは「解くだけ」なので2回要る）。
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
  if (selection === 空) {
    // 同じ中身なら通知しない（`useSyncExternalStore` が無駄に回らないように）
    return
  }
  /*
    **種類も必ず捨てる。** 以前は「`ids` が空なら何もしない」で早く戻っていたが、
    **`kind` が残って `ids` だけ空**という形になったとき、そこから二度と出られない
    ——`pressMapping` は `kind` を見て「選択中」と判断するので**全部の押しが
    「解くだけ」へ倒れ、その解くが早い戻りで何もしない**。いまはそういう形を作って
    いないが、作った瞬間に画面が読み込み直すまで固まる。
  */
  selection = 空
  notify()
}

/**
 * 押す前の選択へ戻す。**ダブルクリックのためだけにある。**
 *
 * ブラウザは `click` → `click` → `dblclick` の順に出すので、**ダブルクリックの間に
 * シングルの処理が2回走る**。以前は「選ぶ」が2回で打ち消し合って元へ戻っていたが、
 * **「解くだけ」が入って打ち消し合わなくなった**——1打目で解け、2打目で押した相手が
 * 選ばれる。開いた先へ**頼んでいない選択を持ち込む**ことになるので、ここで戻す。
 *
 * **中身が同じなら通知しない**（開くたびに画面が余計に描き直らないように）。
 */
export function restoreSelection(snapshot: Selection): void {
  if (
    selection.kind === snapshot.kind &&
    selection.ids.length === snapshot.ids.length &&
    selection.ids.every((id, i) => id === snapshot.ids[i])
  ) {
    return
  }
  selection = snapshot.ids.length === 0 ? 空 : { kind: snapshot.kind, ids: [...snapshot.ids] }
  notify()
}

/** そのものが選ばれているか。 */
export function isSelected(kind: SelectionKind, id: string): boolean {
  return selection.kind === kind && selection.ids.includes(id)
}

export function useSelection(): Selection {
  return useSyncExternalStore(subscribe, getSelection, getSelection)
}

/**
 * テストのための巻き戻し。
 *
 * **購読者は落とさない**（2026-09-08）。落とすと、**まだ画面に居る部品が黙って更新を
 * 受け取らなくなる**——`useSyncExternalStore` は外されたことを知らないので、
 * 「選んだのに色が変わらない」という**別の症状**でテストが落ちて、本当の原因が隠れる。
 * 部品は外れるときに自分で購読を外すので、ここで畳む必要は無い。
 */
export function clearSelectionStore(): void {
  selection = 空
}
