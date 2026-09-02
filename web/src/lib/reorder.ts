/**
 * 掴んで運んでいるものを、どこへ落とすか決める規則（並べ替え設計§3-4）。
 *
 * # 測るのは呼び元、決めるのはここ
 *
 * **これは好みではなく必須である。** テスト環境（jsdom）は要素の幅を常に 800、左端を
 * 常に 0 で返す（`web/src/test/setup.ts`）。測る側と決める側が同じ関数に居ると、
 * テストを書いても**縮退した同じ数字しか通らず、何も確かめていない状態で緑になる**。
 * `web/src/stores/roam.ts` が同じ罠を踏んだ前例を持つ。
 *
 * したがってここには**矩形の配列と点を引数で受け取る純関数だけ**を置く。`window` も
 * `document` も読まない（`lib/panelWidth.ts` ／ `touch.ts` ／ `repeat.ts` と同じ作り）。
 *
 * # 次元で場合分けしない
 *
 * 並べ替える場所は3つあり、並び方はそれぞれ違う——一覧のカードは**折り返して2次元**、
 * 枠は**縦1列**、PJT 専用画面の区画は**横1列**。それでも規則は1つでよい：
 * **いちばん近い中心を選ぶ**。中心からの距離で選ぶなら、縦か横か2次元かを意識する
 * 必要が無い。次元ごとに分岐を書くと、**折り返しの端でだけ挙動が変わる**ような
 * 直しにくい食い違いが生まれる。
 *
 * # 矩形は掴んだ瞬間の1回だけ測る
 *
 * 運んでいる最中に測り直さない。場所取りが動くたびに周りの位置は変わるが、**判断の
 * 土台が動くと、指を止めていても落とし先が揺れる**。掴んだ瞬間の配置を土台に
 * 置いておけば、指の位置だけが答えを決める。
 */

/** 画面上の矩形。`DOMRect` のうち、ここで要る4つだけ。 */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 画面上の点（指やマウスの位置）。 */
export interface Point {
  x: number
  y: number
}

/**
 * 運び始めたと認めるのに要る移動量（px）。
 *
 * **握るかどうかの判断には使わない**（設計§3-3）。握るのは1回目の `pointermove` で
 * 決まっているので、しきい値とは役割を分ける。押し間違いで並びが動かないための線。
 */
export const REORDER_THRESHOLD_PX = 3

/** どこへも決められなかったことを表す添字。 */
export const NO_TARGET = -1

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function usable(rect: Rect): boolean {
  return finite(rect.left) && finite(rect.top) && finite(rect.width) && finite(rect.height)
}

/** 矩形の中心。 */
export function centerOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * いちばん近い中心の添字。決められなければ [`NO_TARGET`]。
 *
 * **決められない場合を 0 に倒さない。** 0 は「先頭へ落とす」という立派な答えなので、
 * 混ぜると**測れなかったときに黙って先頭へ飛ぶ**。呼び元が「いまの添字のまま」を
 * 選べるように、決められなかったことをそのまま返す。
 *
 * 同じ距離のものが複数あるときは**先に出てきたほう**を採る。並びが決まらないと、
 * 指を止めていても落とし先が2つの間で震える。
 */
export function nearestIndex(rects: readonly Rect[], point: Point): number {
  if (!finite(point.x) || !finite(point.y)) {
    return NO_TARGET
  }
  let best = NO_TARGET
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]
    if (!usable(rect)) {
      continue
    }
    const center = centerOf(rect)
    // 平方根を取らない。**比べるだけなので要らない**（同じ順序になる）
    const dx = center.x - point.x
    const dy = center.y - point.y
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return best
}

/**
 * 1つを `from` から `to` へ動かした新しい並び。
 *
 * **動かないときは同じ配列をそのまま返す。** 呼び元は毎フレームこれを呼ぶので、
 * 中身が同じでも新しい配列を返すと、React が描き直しを繰り返す（`useSyncExternalStore`
 * が無限に回る形と同じ）。
 *
 * 範囲の外・[`NO_TARGET`]・同じ場所は、どれも「動かない」。**呼び元に判定を書かせない**
 * ——書かせると、3箇所の呼び元で少しずつ違う判定が生まれる。
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) {
    return items
  }
  if (from < 0 || from >= items.length) {
    return items
  }
  if (to < 0 || to >= items.length) {
    return items
  }
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * その移動量で運び始めるか。**握るかどうかとは別の判断**（設計§3-3）。
 *
 * 縦横をまとめて見る。並べ替えは2次元に運ぶ操作なので、**どちらか一方だけで
 * 数えると、斜めに引いたときだけ始まらない**。
 */
export function passedThreshold(deltaX: number, deltaY: number): boolean {
  if (!finite(deltaX) || !finite(deltaY)) {
    return false
  }
  return Math.hypot(deltaX, deltaY) >= REORDER_THRESHOLD_PX
}
