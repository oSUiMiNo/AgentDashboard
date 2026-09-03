/**
 * 押し方の割り当て（並べ替え設計§4-1）。
 *
 * # PC と触る画面で入れ替わる
 *
 * | 押し方 | PC | 触る画面 |
 * |---|---|---|
 * | シングル | **選ぶ** | **開く**。**同じ種類を1つ以上選んでいるときだけ「選ぶ」** |
 * | ダブル | **開く** | —（端末の拡大と取り合う） |
 * | 長押し | — | **選ぶ**（1枚目。以後は同じ種類の集合の中でシングルが「選ぶ」になる） |
 *
 * # 選択モードの単位は「同格の集合」（並べ替え設計§15-5）
 *
 * カードを選んでも枠の押し方は変わらない（逆も）。種類を問わずに「何か選んでいれば
 * 選ぶ」にすると、カードを選んだ状態で枠の余白をタップした瞬間に**カードの選択が消え・
 * 枠が選ばれ・帯の電源が消え・PJT 専用画面も開かない**——押そうとしたボタンが消える
 * （§5-1 が禁じた事象そのもの）。定石は「同じ操作が効く、ひとつの同格の集合」
 * （Material「display checkboxes for all remaining items in that set」）。
 *
 * 入れ替える理由は、**触る画面のダブルタップが端末の拡大と取り合う**こと。開く操作は
 * いちばん頻度が高いので、そこを端末と取り合わせられない。
 *
 * # 判定は1箇所に集める
 *
 * **コンポーネントごとに `if (coarse)` を書かない**（設計§4-1）。2箇所に散った瞬間、
 * 片方だけ直されて画面が食い違う。ここは `window` も `document` も読まない純関数で、
 * 「触る画面か」「いま選択モードか」を受け取って割り当てを返すだけ。
 */

import type { SelectionKind } from '@/stores/selection'

export interface PressMapping {
  /** シングルで何をするか */
  single: 'select' | 'open'
  /** ダブルで開くか */
  doubleOpens: boolean
  /** 長押しで選べるか */
  longPressSelects: boolean
}

/**
 * その画面での押し方の割り当て。
 *
 * @param coarse 指で触る端末か（`useCoarsePointer()` の結果）
 * @param selecting いま選ばれているものの種類。1つも選んでいなければ `null`
 * @param kind 押されたものの種類
 */
export function pressMapping(
  coarse: boolean,
  selecting: SelectionKind | null,
  kind: SelectionKind,
): PressMapping {
  if (!coarse) {
    // PC。**選択モードという概念を持たない**——修飾キー無しでシングルが「選ぶ」なので、
    // 入る・出るの区別が要らない
    return { single: 'select', doubleOpens: true, longPressSelects: false }
  }
  // **同格の集合だけが選択モードを作る。** カードを選んでいても、枠のシングルは「開く」
  const 同格を選んでいる = selecting !== null && selecting === kind
  return {
    // **1枚目を選ぶまではシングルが「開く」。** 同じ種類を選んだら「選ぶ」に変わる
    single: 同格を選んでいる ? 'select' : 'open',
    // 触る画面ではダブルを使わない
    doubleOpens: false,
    longPressSelects: true,
  }
}

/**
 * 長押しと認める時間（ms）。
 *
 * **Android Chrome 自身の長押し判定が 500ms** なので、同着を避けて手前に置く。
 * iOS Safari は 750ms なので先着する。**実機で決め直す**（設計§13・フェーズ6）。
 */
export const LONG_PRESS_MS = 400

/**
 * 長押しの計測中に動いてよい距離（px）。
 *
 * Android の `TOUCH_SLOP` が 8dip、iOS の `allowableMovement` が 10pt。
 * 超えたら**スクロールと見なして計測をやめる**。**実機で決め直す**（設計§13）。
 */
export const LONG_PRESS_SLOP_PX = 8

/** その移動量で、長押しの計測をやめるか。 */
export function movedTooFar(deltaX: number, deltaY: number): boolean {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    // 測れないものは「動いた」に倒す。**押しっぱなしと読み違えるより、
    // スクロールと読み違えるほうが害が小さい**——選ばれないだけで済む
    return true
  }
  return Math.hypot(deltaX, deltaY) > LONG_PRESS_SLOP_PX
}
