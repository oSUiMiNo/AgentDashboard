/**
 * ファイルのパネルの幅を決める規則（設計§4）。
 *
 * # 測るのは呼び元、決めるのはここ
 *
 * **これは好みではなく必須である。** テスト環境（jsdom）は要素の幅を常に 800、左端を
 * 常に 0 で返す（`web/src/test/setup.ts`）。測る側と決める側が同じ関数に居ると、
 * テストを書いても**縮退した同じ数字しか通らず、何も確かめていない状態で緑になる**。
 * `web/src/stores/roam.ts` が同じ罠を踏んで「測るのは呼び元」と分離した前例を持つ。
 *
 * したがってここには**画面幅を引数で受け取る純関数だけ**を置く。`window` も `document`
 * も読まない（`lib/touch.ts` ／ `repeat.ts` ／ `flow.ts` と同じ作り）。
 *
 * # 覚える値と、当てる値を分ける
 *
 * [`normalizeWidth`] は**画面幅を見ない**。窓を狭めた状態で画面比まで当てた値を覚えると、
 * **窓を戻したときに元の幅へ戻れない**。画面比は「いま当てる幅」を出す [`resolveWidth`]
 * の側にだけ効かせる。
 */

/** 幅を変えられる区画。 */
export type PanelEdge = 'folder' | 'file'

export interface PanelRange {
  /** 既定の幅（px） */
  default: number
  /** 下限（px）。**画面比では持たない**——狭い画面では守れないため（設計§4） */
  min: number
  /** 上限（px・絶対値） */
  max: number
  /** 上限（画面幅に対する割合）。**絶対値との狭いほう**が効く */
  maxRatio: number
}

/**
 * 区画ごとの範囲（設計§4 の表）。
 *
 * 既定はどちらも**移設前の実装の値をそのまま採る**——フォルダは `md:w-80`（320px）、
 * 中身は横並び1区画ぶんの `w-[42rem]`（672px）。下限と上限は「いまの半分〜倍」を
 * それぞれの既定へ当てたもの。
 *
 * 画面比を足すのは「640px は、狭いノートでは画面の大半になる」ため（要件2）。
 * `DESIGN.md` §25.4 の 18〜26% を使わない理由は設計§4 にある。
 *
 * **直したときは、ここと設計§4 の表と単体テストの期待値の3つを揃えること。**
 */
export const PANEL_RANGE: Record<PanelEdge, PanelRange> = {
  folder: { default: 320, min: 160, max: 640, maxRatio: 0.4 },
  file: { default: 672, min: 336, max: 1344, maxRatio: 0.5 },
}

/**
 * 幅を動かし始めるのに要る移動量（px）。
 *
 * **握るかどうかの判断には使わない**（設計§4）。握るのは1回目の `pointermove` で
 * 決まっているので、しきい値とは役割を分ける。
 */
export const DRAG_THRESHOLD_PX = 3

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * その画面幅で許される範囲。
 *
 * ```text
 * 上限 = min(絶対値の上限, 画面幅 × 割合)
 * 下限 = min(絶対値の下限, 上限)     ← 下限が上限を超えないことを、式で保証する
 * ```
 *
 * 2行目があるのは、極端に狭い窓でも範囲が破綻しないようにするため。
 * **「起きないはず」を式の外に置かない**（設計§4）。
 */
export function panelBounds(
  edge: PanelEdge,
  viewportWidth: number,
): { min: number; max: number } {
  const range = PANEL_RANGE[edge]
  // **画面幅が読めないことと、画面が狭いことを混ぜない。** 0 や NaN を掛けると幅が
  // 消えるので、読めないときは割合の上限を諦めて絶対値だけにする
  const usable =
    Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : Number.POSITIVE_INFINITY
  // 切り捨てる。**割合を1pxでも超えない側へ倒す**
  const max = Math.floor(Math.min(range.max, usable * range.maxRatio))
  const min = Math.min(range.min, max)
  return { min, max }
}

/**
 * 覚えるときの正規化。**画面幅を見ない。**
 *
 * 数値でない・`NaN`・`Infinity` は既定へ。負・範囲外は絶対値の下限／上限へ寄せる。
 * **表を丸ごと捨てないため**に、見るのは項目1件ぶんだけ（設計§5）。
 */
export function normalizeWidth(edge: PanelEdge, value: unknown): number {
  const range = PANEL_RANGE[edge]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return range.default
  }
  return Math.round(clamp(value, range.min, range.max))
}

/**
 * いま当てる幅。**覚えている値は書き換えない**——受け取って返すだけ。
 *
 * 同じ値を別の画面幅で渡せば、その画面幅なりの答えが返る。だから「窓を狭めて戻したら
 * 元の幅に戻る」が、状態を持たずに成立する。
 */
export function resolveWidth(
  edge: PanelEdge,
  wanted: number,
  viewportWidth: number,
): number {
  const range = PANEL_RANGE[edge]
  const { min, max } = panelBounds(edge, viewportWidth)
  if (!Number.isFinite(wanted)) {
    return Math.round(clamp(range.default, min, max))
  }
  return Math.round(clamp(wanted, min, max))
}

/**
 * つまんだ時点の幅と、指の横移動量から、次に当てる幅を出す。
 *
 * **向きは2つとも同じ。** フォルダのオーバーレイも中身の列も左端にあり、縁はその右側に
 * あるので、右へ引けば広がり左へ引けば縮む（設計§4）。
 *
 * **移動量が 0 なら 1px も動かない**——`startWidth` は既に範囲の中に居るので、clamp を
 * 通しても同じ値が返る。掴んだだけで幅が変わると、押し間違いで幅が動く。
 */
export function widthFromDrag(
  edge: PanelEdge,
  startWidth: number,
  deltaX: number,
  viewportWidth: number,
): number {
  return resolveWidth(edge, startWidth + deltaX, viewportWidth)
}

/**
 * その移動量で幅を動かすか。**握るかどうかとは別の判断**（設計§4）。
 */
export function passedThreshold(deltaX: number): boolean {
  return Math.abs(deltaX) >= DRAG_THRESHOLD_PX
}
