/**
 * 末尾の錨を、押している間だけ黙らせるための決め（細かい修正 項目10）。
 *
 * # 何を止めているのか
 *
 * 仮想化（`@tanstack/virtual-core`）は、行の高さが変わったとき `resizeItem` の中で
 * **末尾に居たかどうか**を見て、居たなら**総高が増えたぶんだけスクロール位置を下へ動かす**。
 * その判定はこの3つの `&&` である。
 *
 * | # | 条件 | 消費側から動かせるか |
 * |---|---|---|
 * | 1 | `anchorTo === 'end'` | 動かせるが、**追記の追従ごと殺す**ので触らない |
 * | 2 | `scrollState?.behavior !== 'smooth'` | 内部状態。動かせない |
 * | 3 | **`getVirtualDistanceFromEnd() <= scrollEndThreshold`** | **オプション。動かせる** |
 *
 * `getVirtualDistanceFromEnd()` は `max(総高 − 窓 − 位置, 0)` なので**必ず 0 以上**。
 * したがって **閾値を負にすれば条件3は必ず偽**になり、位置を動かす枝へ入らない。
 *
 * # なぜ「あとから戻す」ではなく「止める」なのか
 *
 * 先に「押す直前の位置を控えて、伸びたあとに戻す」を試して**効かなかった**。
 * `resizeItem` は `ResizeObserver` から**何度も**呼ばれ、そのつど**その瞬間の位置で**
 * 判定して書き換える。戻す側と書き換える側が同じ土俵で殴り合うので、
 * **戻す回数を増やしても結末は変わらない**（12フレーム戻し続けても残った）。
 *
 * # なぜ状態から算出するのか
 *
 * `anchorTo` を書き換える案は「**戻し忘れると追従が静かに死ぬ**」ため退けられていた。
 * こちらは React の状態から算出するので、**状態が戻れば値も自動的に戻る**。
 * 命令的な「戻す」処理が存在しないので、**戻し忘れという失敗の形そのものが作れない**。
 *
 * # ここに DOM を持ち込まないこと
 *
 * `jsdom` は矩形を固定で返すので、**測る側と混ぜると何も確かめないまま緑になる**
 * （`lib/reorder.ts` と `lib/useReorder.ts` が同じ理由で分けてある）。
 * この module は `window` も `document` も読まない。
 */

/**
 * 抑制中に渡す閾値。
 *
 * **負であることに意味がある。** 比べる相手（末尾からの距離）は必ず 0 以上なので、
 * 負にすれば条件は必ず偽になる。`0` では「ちょうど末尾」のとき真のままになる。
 */
export const SUPPRESSED_THRESHOLD = -1

/** 抑制中かどうかから、仮想化へ渡す閾値を決める。 */
export function resolveEndThreshold(suppressed: boolean, normal: number): number {
  return suppressed ? SUPPRESSED_THRESHOLD : normal
}

/**
 * 抑制を下ろしてよいか。
 *
 * **上限は保険ではなく必須である。** 「落ち着くまで」だけで下ろすと、
 * 総高が落ち着かない本文で**下りない道**ができ、そこから先の追従が死ぬ。
 * 上限で必ず下ろすので、最悪でも「抑制が短すぎて跳ねが残る」＝**いまと同じ**にしかならない。
 */
export function settled(prev: number, next: number, frames: number, limit: number): boolean {
  return (prev === next && prev >= 0) || frames >= limit
}

/** 総高が落ち着いたとみなすまでに待つフレーム数の上限。 */
export const SETTLE_FRAME_LIMIT = 20
