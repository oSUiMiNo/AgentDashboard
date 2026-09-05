/**
 * 払って消す動きの、決める側（スワイプで消す 設計§3）。
 *
 * # 決める側と測る側を分ける
 *
 * `lib/reorder.ts` と同じ作法で、**ここには `window` も `document` も出さない**。
 * 触るのは数字だけなので、jsdom が矩形を固定で返しても意味のある検査ができる——
 * 測る側と混ぜると「何も確かめないまま緑になる」（並べ替えで実際に踏んだ形）。
 *
 * # 下へは払えない
 *
 * トーストは**画面のいちばん上**に出る（狭い窓では全幅）。そこを下へ払う動きは、
 * Chrome for Android の**引き下げ更新**が持っている。取り合うと、消すつもりが
 * ページごと読み直される——**利用者の指定（上・左右）に下が無いのは正しい。**
 *
 * 左右の端から始まる払いは **Android の「戻る」**が先に取る。あれは OS が
 * 拾うので、こちらのコードには最初から届かない——**奪い返す道は無いし、
 * 奪い返すべきでもない。** 帯の途中から払えば普通に効く。
 *
 * 上は誰とも取り合わない（ホームは**下端**から上への動きで、トーストは上端に居る）。
 */

/**
 * 向きが決まるまでの遊び（px）。
 *
 * **押した指は必ず少し動く。** ここを 0 にすると、ただ触っただけで向きが決まってしまう。
 */
export const SWIPE_SLOP_PX = 8

/**
 * 消えると決める距離（px）。
 *
 * **帯の幅に対する割合にしない。** 狭い窓では全幅（100vw）になるので、割合にすると
 * 画面が広いほど遠くまで運ばされる——**指の動きの量は画面の広さで変わらない。**
 */
export const SWIPE_DISMISS_PX = 48

/** 動きの向き。`'none'` はまだ決まっていない。 */
export type SwipeAxis = 'none' | 'x' | 'y'

/**
 * 向きを決める。**一度決まったら変えない。**
 *
 * 決め直すと、斜めに払ったときに追従が横と縦を行き来してちらつく。
 */
export function lockAxis(axis: SwipeAxis, dx: number, dy: number): SwipeAxis {
  if (axis !== 'none') {
    return axis
  }
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < SWIPE_SLOP_PX && ay < SWIPE_SLOP_PX) {
    return 'none'
  }
  return ax >= ay ? 'x' : 'y'
}

/**
 * 指について動く量。
 *
 * **決まっていない向きへは動かさない**（斜めに引っぱられて見えるのを防ぐ）。
 * **下へも動かさない**——追従だけさせて消えないと、「動いたのに消えない」という
 * いちばん分かりにくい壊れ方になる。動かないほうが「ここは効かない」と伝わる。
 */
export function followOffset(
  axis: SwipeAxis,
  dx: number,
  dy: number,
): { x: number; y: number } {
  if (axis === 'x') {
    return { x: dx, y: 0 }
  }
  if (axis === 'y') {
    return { x: 0, y: Math.min(0, dy) }
  }
  return { x: 0, y: 0 }
}

/**
 * 指を離したとき、消すかどうか。
 *
 * **上・左・右の3方向だけ。** 下は上記のとおり採らない。
 */
export function shouldDismiss(
  axis: SwipeAxis,
  dx: number,
  dy: number,
): boolean {
  if (axis === 'x') {
    return Math.abs(dx) >= SWIPE_DISMISS_PX
  }
  if (axis === 'y') {
    return -dy >= SWIPE_DISMISS_PX
  }
  return false
}

/**
 * 追従している間の薄さ。
 *
 * **消えると決まる距離で 0 にはしない**（0.35 まで）。指を離す前に消えたように
 * 見えると、離しても戻ったときに「壊れた」と読める。
 */
export function followOpacity(offset: { x: number; y: number }): number {
  const 進み = Math.max(Math.abs(offset.x), Math.abs(offset.y))
  if (進み <= 0) {
    return 1
  }
  const 割合 = Math.min(1, 進み / SWIPE_DISMISS_PX)
  return 1 - 割合 * 0.65
}
