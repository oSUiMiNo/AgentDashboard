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
 * # 落とし先は「行 → 矩形 → 1歩 → 封印」で決める（設計§15-3）
 *
 * 並べ替える場所は3つあり、並び方はそれぞれ違う——一覧のカードは**折り返して2次元**、
 * 枠は**縦1列**、PJT 専用画面の区画は**横1列**。規則は1つで、次元で分岐しない：
 * **y の重なりで行を作り、行を帯までの距離で選び、同じ行なら矩形までの距離で選ぶ。
 * 目標へ直接飛ばず1歩だけ動き、直前に居た添字へは封印が解けるまで戻さない。**
 *
 * 前の規則「いちばん近い中心」（[`nearestIndex`]）には、実寸で確定した帰結が3つあった
 * ——境界が箱の 6px 外に出る・折り返しで列数ぶん飛ぶ・境界上で毎フレーム往復する。
 * **`nearestIndex` は判定に使わない。** 対照（旧規則ならこうなる）としてテストが呼ぶ。
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
 * **判定には使わない**（設計§15-3）。旧規則の帰結——境界が箱の 6px 外・折り返しで
 * 列数ぶん飛ぶ・境界上で往復——を示す対照として残してある。消すときはテストごと。
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

/**
 * 直前に居た添字へ戻さないための封印（設計§15-3 段5）。
 *
 * **呼び元が持ち回り、中身は書き換えない。** [`dropTarget`] は動かなかったとき
 * 渡された封印をそのまま返す（同じ参照）。動いたときだけ新しい封印を作る。
 */
export interface Seal {
  /** 戻さない添字（直前に居たスロット） */
  readonly index: number
  /** 封印した瞬間の指（スクロール補正済み） */
  readonly at: Point
  /** 封印した瞬間の進行方向（単位ベクトル）。測れなければ null（角度の条件は見ない） */
  readonly heading: Point | null
}

/**
 * 封印を解く距離（px）。dnd-kit の `hysteresis = 10`（`fix/collision-notifier-oscillation`）。
 * 指の接触重心は常時 1〜3px 揺れるので、それより十分大きく取る。
 */
export const SEAL_RELEASE_PX = 10

/** 封印を解く方向の変化（rad）。Muuri の `dragSortHeuristics`（1 rad ≒ 57°）。 */
export const SEAL_RELEASE_RAD = 1

export interface DropInput {
  /** 凍結した矩形。**添字＝スロット**（掴んだ瞬間の DOM の並び） */
  rects: readonly Rect[]
  /** 指の位置。**スクロール補正済み**（凍結した座標系へ写した点） */
  point: Point
  /** 掴んでいるものが、いま居る仮想のスロット */
  current: number
  seal: Seal | null
  /** いまの進行方向（単位ベクトル）。[`headingOf`] の値。測れなければ null */
  heading: Point | null
}

export interface DropResult {
  /** 次のスロット。動かなければ `current` */
  index: number
  /** 新しい封印。動かなければ渡されたものと同じ参照 */
  seal: Seal | null
}

interface Row {
  top: number
  bottom: number
  /** スロット添字。左から順 */
  members: number[]
}

/** y の重なりで行を作る。**測れない矩形は行に入れない** */
function rowsOf(rects: readonly Rect[]): Row[] {
  const order: number[] = []
  for (let index = 0; index < rects.length; index += 1) {
    if (usable(rects[index])) {
      order.push(index)
    }
  }
  order.sort((a, b) => rects[a].top - rects[b].top || rects[a].left - rects[b].left || a - b)
  const rows: Row[] = []
  for (const index of order) {
    const rect = rects[index]
    const bottom = rect.top + rect.height
    const last = rows[rows.length - 1]
    if (last !== undefined && rect.top < last.bottom && bottom > last.top) {
      last.members.push(index)
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, bottom)
    } else {
      rows.push({ top: rect.top, bottom, members: [index] })
    }
  }
  for (const row of rows) {
    row.members.sort((a, b) => rects[a].left - rects[b].left || a - b)
  }
  return rows
}

/** 帯までの距離。内側なら 0 */
function distanceToBand(y: number, row: Row): number {
  if (y < row.top) {
    return row.top - y
  }
  if (y > row.bottom) {
    return y - row.bottom
  }
  return 0
}

/** 矩形までの距離の二乗。内側なら 0 */
function distanceToRect(point: Point, rect: Rect): number {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  const dx = point.x < rect.left ? rect.left - point.x : point.x > right ? point.x - right : 0
  const dy = point.y < rect.top ? rect.top - point.y : point.y > bottom ? point.y - bottom : 0
  return dx * dx + dy * dy
}

/** 2つの単位ベクトルのなす角（rad） */
function angleBetween(a: Point, b: Point): number {
  const dot = a.x * b.x + a.y * b.y
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}

/**
 * 落とし先。**1回の呼び出しで動くのは高々1歩。**
 *
 * 1. y の重なりで行を作る（測れない矩形は入れない）
 * 2. 指の y から帯までの距離が最小の行を選ぶ（同点は先の行）
 * 3. 選んだ行に `current` が居れば、矩形までの距離が最小のもの（内側は 0。同点は
 *    `current` を優先——指を止めても震えない）。居なければ中心 x が最も近いもの
 * 4. `Math.sign(目標 − current)` で1歩
 * 5. その1歩が封印した添字なら、封印が解けているときだけ動く（10px か 1 rad）。
 *    **外す方向（封印から離れる歩）は常に通る**
 *
 * 決められなければ `current` と渡された封印をそのまま返す。**0 に倒さない。**
 */
export function dropTarget(input: DropInput): DropResult {
  const { rects, point, current, seal, heading } = input
  const stay: DropResult = { index: current, seal }
  if (!finite(point.x) || !finite(point.y)) {
    return stay
  }
  const rows = rowsOf(rects)
  if (rows.length === 0) {
    return stay
  }

  let row = rows[0]
  let rowDistance = distanceToBand(point.y, row)
  for (let at = 1; at < rows.length; at += 1) {
    const distance = distanceToBand(point.y, rows[at])
    if (distance < rowDistance) {
      row = rows[at]
      rowDistance = distance
    }
  }

  let target = current
  if (row.members.includes(current)) {
    let best = Number.POSITIVE_INFINITY
    for (const member of row.members) {
      const distance = distanceToRect(point, rects[member])
      if (distance < best) {
        best = distance
        target = member
      }
    }
    // **同点は current を優先。** 隙間の真ん中で震えない
    if (distanceToRect(point, rects[current]) <= best) {
      target = current
    }
  } else {
    let best = Number.POSITIVE_INFINITY
    for (const member of row.members) {
      const distance = Math.abs(centerOf(rects[member]).x - point.x)
      if (distance < best) {
        best = distance
        target = member
      }
    }
  }

  const step = current + Math.sign(target - current)
  if (step === current) {
    return stay
  }
  if (seal !== null && step === seal.index) {
    const moved = Math.hypot(point.x - seal.at.x, point.y - seal.at.y) >= SEAL_RELEASE_PX
    const turned =
      heading !== null && seal.heading !== null && angleBetween(heading, seal.heading) >= SEAL_RELEASE_RAD
    if (!moved && !turned) {
      return stay
    }
  }
  return { index: step, seal: { index: current, at: point, heading } }
}

/** 指の位置の標本（`performance.now()` の時刻つき）。 */
export interface Sample {
  t: number
  x: number
  y: number
}

/** 速度と進行方向を読む窓（ms）。直近だけを見る */
export const VELOCITY_WINDOW_MS = 100

/**
 * 進行方向が立つ最小の変位（px）。
 *
 * ±2px の揺れ（幅 4px）では方向が立たないための下限。**封印を「方向が変わった」で
 * 解くのは、指が本当に向きを変えたときだけ**。実機で決め直す定数（設計§15-10）。
 */
export const HEADING_MIN_PX = 6

/**
 * 直近の窓の中で、最古→最新の変位から速度（px/s）を出す（設計§15-7）。
 *
 * 離した瞬間の速度をそのまま次のバネの初速に渡す——切り替わった瞬間を作らないため。
 * 標本が窓に2つ無い（指を止めて離した）なら `{0,0}`。
 */
export function velocityOf(samples: readonly Sample[], now: number): Point {
  const since = now - VELOCITY_WINDOW_MS
  let first: Sample | null = null
  let last: Sample | null = null
  for (const sample of samples) {
    if (sample.t < since) {
      continue
    }
    if (first === null) {
      first = sample
    }
    last = sample
  }
  if (first === null || last === null || first === last) {
    return { x: 0, y: 0 }
  }
  const dt = (last.t - first.t) / 1000
  if (!finite(dt) || dt < 0.001) {
    return { x: 0, y: 0 }
  }
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt }
}

/**
 * 直近の窓の中で、最古→最新の変位から進行方向（単位ベクトル）を出す。
 * 標本が2つ無い、または変位が [`HEADING_MIN_PX`] 未満なら null。
 */
export function headingOf(samples: readonly Sample[], now: number): Point | null {
  const since = now - VELOCITY_WINDOW_MS
  let first: Sample | null = null
  let last: Sample | null = null
  for (const sample of samples) {
    if (sample.t < since) {
      continue
    }
    if (first === null) {
      first = sample
    }
    last = sample
  }
  if (first === null || last === null || first === last) {
    return null
  }
  const dx = last.x - first.x
  const dy = last.y - first.y
  const length = Math.hypot(dx, dy)
  if (!finite(length) || length < HEADING_MIN_PX) {
    return null
  }
  return { x: dx / length, y: dy / length }
}

/**
 * 並びの形（設計§15-11）。**運んでいる間は DOM を並べ替えない**ので、見た目の並びは
 * 凍結した矩形と仮想の並びから `translate` で作る。作り方が2通りある。
 *
 * - `grid`：矩形を入れ替える（仮想スロット j の要素は、凍結した j 番目の矩形へ）
 * - `column`／`row`：寸法を積む（先頭から「前の要素の寸法＋隙間」を足して位置を出す）
 */
export type Layout =
  | { kind: 'grid' }
  | { kind: 'column'; gap: number }
  | { kind: 'row'; gap: number }

/** 「揃っている」と見なす誤差（px）。サブピクセルの丸めを吸う */
const ALIGN_TOLERANCE_PX = 1

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 凍結した矩形から並びの形を読む。**掴んだ瞬間に1回だけ呼ぶ。**
 *
 * 設計§15-11 の「同寸でなければ1列へ倒す」を、**軸で測る**形にしたもの——全部の
 * 左端が揃えば縦1列、上端が揃えば横1列、どちらでもなければ格子。寸法で見ないのは、
 * 一覧のカードが行の高さまで伸びて行ごとに高さが違いうるため。カードが1列になる
 * 狭い画面では自動的に縦1列になり、高さ違いも正しく積まれる。
 *
 * 隙間は隣り合う矩形の間隔の**中央値**（1つ狂った間隔に引きずられない）。
 */
export function layoutOf(rects: readonly Rect[]): Layout {
  const used = rects.filter(usable)
  if (used.length < 2) {
    return { kind: 'grid' }
  }
  const lefts = used.map((r) => r.left)
  const tops = used.map((r) => r.top)
  const aligned = (values: number[]) =>
    Math.max(...values) - Math.min(...values) <= ALIGN_TOLERANCE_PX
  if (aligned(lefts)) {
    const byTop = used.slice().sort((a, b) => a.top - b.top)
    const gaps: number[] = []
    for (let i = 1; i < byTop.length; i += 1) {
      gaps.push(Math.max(0, byTop[i].top - (byTop[i - 1].top + byTop[i - 1].height)))
    }
    return { kind: 'column', gap: median(gaps) }
  }
  if (aligned(tops)) {
    const byLeft = used.slice().sort((a, b) => a.left - b.left)
    const gaps: number[] = []
    for (let i = 1; i < byLeft.length; i += 1) {
      gaps.push(Math.max(0, byLeft[i].left - (byLeft[i - 1].left + byLeft[i - 1].width)))
    }
    return { kind: 'row', gap: median(gaps) }
  }
  return { kind: 'grid' }
}

/**
 * 各要素の `translate`（設計§15-11）。
 *
 * `placement[j]` は**仮想スロット j に居る要素の元の添字**。戻り値は元の添字で引く
 * （`offsets[元の添字]`）。測れなかった矩形は `{0,0}`（勝手に位置を決めない）で、
 * 積むときの寸法は 0 として扱う。長さが合わない・範囲外なら `{0,0}` で埋める——
 * 毎フレーム呼ばれうる関数なので、例外を投げない。
 */
export function virtualOffsets(
  rects: readonly Rect[],
  placement: readonly number[],
  layout: Layout,
): Point[] {
  const offsets: Point[] = rects.map(() => ({ x: 0, y: 0 }))
  if (placement.length !== rects.length) {
    return offsets
  }
  const valid = (index: number) => index >= 0 && index < rects.length && usable(rects[index])
  if (layout.kind === 'grid') {
    for (let slot = 0; slot < placement.length; slot += 1) {
      const from = placement[slot]
      if (!valid(from) || !usable(rects[slot])) {
        continue
      }
      offsets[from] = {
        x: rects[slot].left - rects[from].left,
        y: rects[slot].top - rects[from].top,
      }
    }
    return offsets
  }
  const along = layout.kind === 'column' ? 'top' : 'left'
  const size = layout.kind === 'column' ? 'height' : 'width'
  let cursor = Number.POSITIVE_INFINITY
  for (const rect of rects) {
    if (usable(rect)) {
      cursor = Math.min(cursor, rect[along])
    }
  }
  if (!finite(cursor)) {
    return offsets
  }
  for (const from of placement) {
    if (!valid(from)) {
      continue
    }
    const delta = cursor - rects[from][along]
    offsets[from] = layout.kind === 'column' ? { x: 0, y: delta } : { x: delta, y: 0 }
    cursor += rects[from][size] + layout.gap
  }
  return offsets
}

/**
 * 両方に在るものだけを見て、並びが同じか（楽観の照合。設計§15-4）。
 *
 * サーバの返事に新しいものが混ざっていても、共通部分の並びが一致すれば「確定した」と読む。
 */
export function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
  const inB = new Set(b)
  const inA = new Set(a)
  const left = a.filter((each) => inB.has(each))
  const right = b.filter((each) => inA.has(each))
  return left.length === right.length && left.every((each, at) => each === right[at])
}
