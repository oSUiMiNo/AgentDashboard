/**
 * ホイールと中ドラッグを、レールの横の送り量へ畳む規則（設計「部品をどこへ置くか」）。
 *
 * # 測るのは呼び元、決めるのはここ
 *
 * **これは好みではなく必須である。** テスト環境（jsdom）は要素の幅を常に 800、左端を
 * 常に 0 で返す（`web/src/test/setup.ts`）。測る側と決める側が同じ関数に居ると、
 * テストを書いても**縮退した同じ数字しか通らず、何も確かめていない状態で緑になる**。
 * `web/src/stores/roam.ts` が同じ罠を踏んで「測るのは呼び元」と分離した前例を持つ。
 *
 * したがってここには**ホイールの移動量と2点の座標を引数で受け取る純関数だけ**を置く。
 * `window` も `document` も読まない（`lib/panelWidth.ts` ／ `reorder.ts` と同じ作り）。
 * レール要素の取得・`scrollLeft` の読み書き・購読と後始末・ポインタの捕捉は、測る側の
 * `lib/useRailPan.ts` が引き受ける。
 *
 * # Shift ＋ 縦を、横として扱う
 *
 * ブラウザは Shift ＋ ホイールを **`deltaY` のまま届け、既定動作だけを横にする**。
 * つまり `deltaX` しか見ないと、Shift 経路では送り量が 0 のままになり、手渡しが
 * 発火しない。**修飾なしの縦だけは触らない**——あれは端末の遡りに残す。
 */

/**
 * `WheelEvent.deltaMode` の値。
 *
 * **`WheelEvent.DOM_DELTA_LINE` を参照しない。** あれは DOM のグローバルを読むことに
 * なり、このファイルの「`window` も `document` も読まない」という宣言と矛盾する。
 */
export const DELTA_PIXEL = 0
/** 1 が「行」単位。 */
export const DELTA_LINE = 1
/** 2 が「ページ」単位。 */
export const DELTA_PAGE = 2

/** 掴みが始まったとみなすまでの距離（px）。 */
export const RAIL_PAN_THRESHOLD_PX = 3

/** ホイールから読み取る値。**イベントそのものは渡さない**（DOM に触れないため）。 */
export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  shiftKey: boolean
}

/**
 * 単位を px へ畳むための実測値。**フックが測って渡す。**
 *
 * ここで測らないのは、jsdom が矩形を固定値で返すためである（冒頭を参照）。
 */
export interface WheelScale {
  /** 1行ぶんの px */
  lineHeight: number
  /** 1ページぶんの px（＝レールの見え幅） */
  pageWidth: number
}

/**
 * 届いた移動量を px へ畳む。
 *
 * **未知の単位は px とみなす。** 握りつぶすと、新しい単位が増えたときに
 * 「何も動かない」という分かりにくい形で出る。
 */
function toPixels(raw: number, mode: number, scale: WheelScale): number {
  if (mode === DELTA_LINE) {
    return raw * scale.lineHeight
  }
  if (mode === DELTA_PAGE) {
    return raw * scale.pageWidth
  }
  return raw
}

/**
 * ホイールを「横の送り量」へ畳む。**送らないなら 0 を返す。**
 *
 * 判定の順序は次のとおりで、**①が②より先に効く**。
 *
 * 1. `deltaX` が 0 でない … 純粋な横回し。`shiftKey` が真でもこちらが勝つ
 * 2. `deltaY` が 0 でなく、かつ Shift … Shift ＋ 縦回し。横として送る
 * 3. それ以外（修飾なしの縦だけ） … **0**。端末の遡りに残す
 */
export function wheelPanDelta(input: WheelInput, scale: WheelScale): number {
  if (input.deltaX !== 0) {
    return toPixels(input.deltaX, input.deltaMode, scale)
  }
  if (input.deltaY !== 0 && input.shiftKey) {
    return toPixels(input.deltaY, input.deltaMode, scale)
  }
  return 0
}

/**
 * 掴みが始まったか。**届いたら始まる**（`>=`）。
 *
 * `lib/panelWidth.ts` ／ `reorder.ts` と同じ比較にしてある。押した瞬間に掴むと、
 * **押して離すだけのつもり（中クリック）まで横へ動く。**
 */
export function passedPanThreshold(deltaX: number): boolean {
  return Math.abs(deltaX) >= RAIL_PAN_THRESHOLD_PX
}

/**
 * 掴んでいる間の送り量（`scrollLeft` へ足す px）。
 *
 * **向きは「中身を掴んで動かす」**（設計「見せ方と速さ」）。ポインタを左へ動かすと
 * `scrollLeft` が増え、中身は右へ流れる。**1 対 1・慣性なし。**
 *
 * **掴んだ瞬間の `scrollLeft` に対して当てること。** 毎回の差分を足し込むと、
 * 端で止まったぶんがずれとして溜まる。
 */
export function panScrollDelta(originX: number, currentX: number): number {
  return originX - currentX
}
