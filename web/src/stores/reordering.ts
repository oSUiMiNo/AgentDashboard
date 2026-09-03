/**
 * いま並べ替えの最中か（並べ替え設計§15-1）。
 *
 * # なぜ1箇所で持つのか
 *
 * 効果線の引き直し（`RoamLayer`）と発射（`stores/roam.ts` の `scheduleRoam`）は、
 * **並べ替えの最中と滑り終わるまで止める**。印を DOM の属性（`data-reordering`）で
 * 見る形にすると**降りた瞬間を知れない**——属性の変化は `MutationObserver` の
 * `childList` に出ないので、「降りたら1回だけ引き直す」が作れない。並びは3箇所
 * （一覧の枠・枠ごとのカード・PJT 専用画面の区画）にあるので、DOM を探し回るより
 * **立てる側が1つのストアへ書く**ほうが素直である。
 *
 * # 主ごとに持つ
 *
 * `useReorder` は**同時に複数マウントされる**（枠の並びが1つ、枠ごとのカードの並びが
 * 枠の数だけ、区画の並びが1つ）。真偽値で持つと、ある主が降ろした瞬間に**別の主の印
 * まで消える**。数える形だと、同じ主が二度立てた（離した直後に掴み直した）ときに
 * 帳尻が狂う。**主を覚える `Set`** なら同じ主の重複は冪等で、降りるのは最後の主が
 * 降ろしたときになる。
 *
 * # 通知は 0 と 1 を跨ぐときだけ
 *
 * 2つ目の主が立っても「並べ替え中」であることは変わらない。`stores/selection.ts` の
 * 「同じ中身なら通知しない」と同じ作法で、`useSyncExternalStore` を無駄に回さない。
 */

import { useSyncExternalStore } from 'react'

const 立てている = new Set<object>()
const listeners = new Set<() => void>()

function notify(): void {
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

/** React の外から購読する口（`RoamLayer` の effect が使う）。 */
export const subscribeReordering = subscribe

/** いま誰かが並べ替えているか。 */
export function isReordering(): boolean {
  return 立てている.size > 0
}

/**
 * 印を立てる。**同じ主が二度立てても1つ**。
 *
 * `主` は `useReorder` のインスタンスごとに安定した札（`useRef({})` の中身）。
 */
export function raiseReordering(主: object): void {
  if (立てている.has(主)) {
    return
  }
  立てている.add(主)
  if (立てている.size === 1) {
    notify()
  }
}

/** 印を降ろす。**知らない主が降ろしても何も起きない**（通知もしない）。 */
export function lowerReordering(主: object): void {
  if (!立てている.delete(主)) {
    return
  }
  if (立てている.size === 0) {
    notify()
  }
}

export function useReordering(): boolean {
  return useSyncExternalStore(subscribe, isReordering, isReordering)
}

/** テストのための巻き戻し。 */
export function clearReorderingStore(): void {
  立てている.clear()
  listeners.clear()
}
