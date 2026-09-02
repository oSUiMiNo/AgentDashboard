/**
 * 押し方の割り当て（並べ替え設計§4-1）。
 *
 * # PC と触る画面で入れ替わる
 *
 * | 押し方 | PC | 触る画面 |
 * |---|---|---|
 * | シングル | **選ぶ** | **開く** |
 * | ダブル | **開く** | —（端末の拡大と取り合う） |
 * | 長押し | — | **選ぶ**（1枚目。以後は選択モードでシングルが「選ぶ」になる） |
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
 * @param selecting いま選択モードか（触る画面で1枚以上選んでいる状態）
 */
export function pressMapping(coarse: boolean, selecting: boolean): PressMapping {
  if (!coarse) {
    // PC。**選択モードという概念を持たない**——修飾キー無しでシングルが「選ぶ」なので、
    // 入る・出るの区別が要らない
    return { single: 'select', doubleOpens: true, longPressSelects: false }
  }
  return {
    // **1枚目を選ぶまではシングルが「開く」。** 選択モードへ入ったら「選ぶ」に変わる
    single: selecting ? 'select' : 'open',
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
