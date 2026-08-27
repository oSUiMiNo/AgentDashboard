/**
 * 画面を回遊する効果線の在庫（カード設計§9-7）。
 *
 * # なぜ zustand なのか
 *
 * 更新は**最悪でも 12枚 × 1/4.8秒 ≒ 2.5回/秒**で、購読者は層1つ（葉）しかない。
 * `stores/sessions.ts` が `useSyncExternalStore` を選んでいるのは「毎秒何度も来る更新で
 * 一覧全体が作り直されるのを避ける」ためで、**ここはその条件に当たらない**。
 *
 * # 門が2枚あるのはなぜか
 *
 * ここ（JavaScript）で止めるのは**仕事を作らないため**——止まっていれば DOM も
 * タイマも1つも生えない。`roam.css` にも同じ止め方を書いてあるのは、**こちらが
 * 壊れても見えないため**である。E2E は本数（＝この門）を、CSS の台帳は打ち消し
 * （＝あちらの門）を、それぞれ別に見ている。
 */

import { create } from 'zustand'
import type { MotionQuiet } from '@/stores/settings'
import { type RoamField, type RoamStop, planRoute } from '@/lib/roam'

/**
 * 画面に同時に居てよい線の数。
 *
 * **寿命と噛み合っていないと、書いた寿命どおりに生きない。** 上限が小さいと
 * **古いものから捨てられて、実際の寿命は上限で決まる**（前の版は 10本上限で、
 * 50秒と書いても 16秒しか生きなかった）。
 *
 * **発火は平均 9.6秒に1回**（跳ねは 4.8秒に1回だが、[`ROAM_SKIP`] で半分見送る）で
 * 1回 [`ROAM_LINES`] 本なので、[`ROAM_LIFE_MS`] のあいだに出る線は
 * **90 ÷ 9.6 × 3 ≒ 28本**。そこへ**乱数の揺れぶんの余裕を足して 32** である。
 *
 * **29 へ下げてはいけない**（2026-08-28）。**乱数で撃つ以上、画面の本数は平均28本の
 * 前後に揺れる**ので、上限を切り詰めると**揺れの山で毎回押し出され、寿命90秒が
 * 実現しない**——上に書いた「16秒しか生きなかった」と同じ壊れ方になる。決め打ちで
 * 2回に1回撃つ形なら 29 で足りたが、**乱数にした時点で余裕が要る**。
 *
 * 待っているカードが2枚以上なら、やはり上限が先に効く——そこは直さない
 * （最古から捨てる作法は据え置き）。
 */
export const ROAM_MAX = 32

/**
 * 1本が飛んでいる時間。`roam.css` へは層が渡すので、秒数の出どころはここだけ。
 *
 * **50秒 → 90秒**（2026-08-28・利用者の回答）。発火を半分に間引いたぶん画面の本数が
 * 減るので、**1本を長く生かして密度を保つ**。
 *
 * **速さはこの値だけで決まる**——総道のり（`lib/roam.ts` の `roamSpans()` の和＝
 * 2917.4px）÷ 寿命なので、**58.3 → 32.42px/秒**になる。幾何（`ROAM_ROAM` /
 * `ROAM_STEP` / `ROAM_STOPS`）は1つも動かしていない。**`roam.css` の `steps()` は
 * 全部引き直してある**（`roam.test.ts` が突き合わせるので、忘れると落ちる）。
 */
export const ROAM_LIFE_MS = 90_000

/**
 * 跳ねても撃たずに見送る確率。
 *
 * **跳ねは 4.8秒に1回**なので、半分見送ると**平均 9.6秒に1回**になる
 * （見送る確率 p のとき撃つまでの平均試行回数は `1/(1-p)`。`1/(1-0.5) = 2`）。
 * 利用者の言葉は「**揺れ2回につき1回くらい**」（要件14-1）。
 *
 * **1/3 ではない。** `1/(1-1/3) = 1.5` で平均 7.2秒にしかならず、90秒のあいだに
 * `90 ÷ 7.2 × 3 ≒ 38本` 出ようとして [`ROAM_MAX`] に押し出される——**寿命90秒に
 * 届かない線が出る**。
 *
 * **暫定値である。** 焼いて見て「まばらだが寂しくない」になっているかで決め直す。
 */
export const ROAM_SKIP = 0.5

/**
 * 跳ね終わりから撃つまでの遅れ（下限・上限）。
 *
 * 跳ねは 4.8秒の周期のうち**末尾 0.36秒だけ**動くので、残り 4.44秒のどこかで撃つ。
 * **固定値にしない**——固定だと「跳ねの 1.2秒後」が周期になって、結局揺れと連動して
 * 見える（要件14-2）。
 *
 * **暫定値である。** 焼いて見てから決め直す。
 */
export const ROAM_DELAY_MIN_MS = 1_200
export const ROAM_DELAY_MAX_MS = 3_600

/** 尺取り虫（生まれた瞬間の伸び）の長さ。前の版の 15秒 × 3% を引き継いだ */
export const ROAM_BIRTH_MS = 450

/**
 * 1回の跳ねで飛ばす本数。
 *
 * **3本に固定した**（利用者の指定・2026-08-26。設計§9-7-2）。前は種で 2 と 3 を
 * 交互に出していたが、振り付けが「手書きの3本線が放射状に出てくる」と決まったので、
 * **本数が揺れると①の読みが崩れる**。
 */
export const ROAM_LINES = 3

/** 線の形の種類。同じ棒が並ばないよう、種から選び分ける（`roam.css` の `data-shape`） */
export const ROAM_SHAPES = 3

export interface RoamLine {
  id: number
  /** 線の色。カードの `--tile-accent` をそのまま受け取る（層は DOM を読まない） */
  accent: string
  /** いま塗る濃さ。カードの `--tile-ink` と同じ値（設計§9-7・`statusInk`） */
  ink: string
  /** 手書きの形の種別。0〜`ROAM_SHAPES - 1` */
  shape: number
  stops: RoamStop[]
}

interface RoamState {
  lines: RoamLine[]
}

export const useRoamStore = create<RoamState>(() => ({ lines: [] }))

let 次のID = 1
const 寿命 = new Map<number, ReturnType<typeof setTimeout>>()

/** 跳ね終わりから撃つまでの待ち。**止めるときに畳めるよう、握っておく** */
const 待ち = new Set<ReturnType<typeof setTimeout>>()

/**
 * 撃つか、どれだけ遅らせるかを決める籤。
 *
 * **`lib/roam.ts` の `散らす()` を使わない。** あれは**種から決まる再現可能な値**で、
 * 経路を組み立てるためのものである。撃つ／撃たないと遅れは、**同じ種でも毎回違って
 * よい**——むしろ同じであってはならない。同じカードが毎回同じ跳ねで撃つと、
 * 「揺れと連動している」という元の指摘へ戻る。
 */
export function roamDefaultDice(): number {
  return Math.random()
}

let 籤: () => number = roamDefaultDice

function 畳む(id: number): void {
  const タイマ = 寿命.get(id)
  if (タイマ !== undefined) {
    clearTimeout(タイマ)
    寿命.delete(id)
  }
  useRoamStore.setState((state) => ({
    lines: state.lines.filter((line) => line.id !== id),
  }))
}

/** OS が「動きを減らす」と言っているか。**言っていれば1本も出さない** */
function 減らす(): boolean {
  // jsdom には `matchMedia` が無いことがある。**無いことを「減らせ」と読まない**
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface RoamSeed {
  /**
   * 跳ねた瞬間に測った場の様子（`lib/roam.ts` の `measureField`）。
   *
   * **測るのは呼び元。** ここで測ると、jsdom の `getBoundingClientRect` が全部 0 を
   * 返すせいで**単体テストが縮退した格子を通る**——「何も証明しない経路」で緑になる。
   */
  field: RoamField
  accent: string
  ink: string
  quiet: MotionQuiet
}

/**
 * 跳ねたカードから線を放つ。
 *
 * **「控えめ」でも飛ばさない**（利用者の指定・2026-08-26）。「控えめ」は仕様上
 * 作業中の回転だけを止める段で、承認待ちの跳ねは残る——つまりカードは跳ね続けるが、
 * **画面を横切る線だけが止まる**。画面じゅうを飛び回る動きは、いちばん静めたいものに
 * あたるため。
 *
 * 「静止」と OS 設定では、そもそも跳ねが止まっていて**この関数が呼ばれない**（呼び元が
 * CSS アニメーションの折り返しなので、`animation: none` だと鳴らない）。ここで見るのは
 * 保険である。
 */
export function emitRoam(seed: RoamSeed): void {
  if (seed.quiet !== 'lively') return
  if (減らす()) return

  const 空き = ROAM_MAX - useRoamStore.getState().lines.length

  // **空きに応じて減らす。** 満杯のときだけ最古を1本落として1本だけ出す——
  // 新しいほうを捨てると「このカードだけ線が出ない」と読めてしまい、跳ねと線の
  // 対応が崩れて不具合に見える
  const 出す = 空き >= ROAM_LINES ? ROAM_LINES : Math.max(1, 空き)
  const 落とす = Math.max(0, 出す - 空き)
  for (let i = 0; i < 落とす; i += 1) {
    const 最古 = useRoamStore.getState().lines[0]
    if (最古 === undefined) break
    畳む(最古.id)
  }

  const 足す: RoamLine[] = []
  for (let i = 0; i < 出す; i += 1) {
    const id = 次のID
    次のID += 1
    足す.push({
      id,
      accent: seed.accent,
      ink: seed.ink,
      shape: id % ROAM_SHAPES,
      stops: planRoute(seed.field, id),
    })
    寿命.set(
      id,
      setTimeout(() => 畳む(id), ROAM_LIFE_MS),
    )
  }

  useRoamStore.setState((state) => ({ lines: [...state.lines, ...足す] }))
}

/**
 * 跳ねを合図に、**間を置いてから**線を放つ。
 *
 * # なぜ跳ねを合図に使い続けるのか
 *
 * 利用者の指摘は「効果線がカードの揺れと連動している」だった（0.1.43 を実物で見て）。
 * **合図を捨ててタイマを持つと、時計が2つになる**（設計§20-2-1）。採ったのは
 * **合図はそのまま、撃つ時刻をずらす**形である——籤で半分見送り、残りも 1.2〜3.6秒
 * 遅らせるので、**跳ねと線の間に一定の関係が見えなくなる**。
 *
 * # 門は「積む前」に通す
 *
 * **撃つ直前へ門を置いてはいけない。** 止まっているのにタイマだけが積み上がる形に
 * なり、設計§9-7 が門に与えた役割（**仕事を作らない**）が果たせない。線が出ないこと
 * だけを見るテストは、**その壊れ方を緑のまま通す**。
 *
 * # 場を測るのは、撃つ瞬間
 *
 * 遅らせるぶん、跳ねた時点の盤面は**最大3.6秒古い**（`measureField` の控えの寿命は
 * 1秒）。そこで**種は関数で受け取り、撃つ瞬間に呼ぶ**。測るのが呼び元のままなのは
 * 変わらない——在庫の側で測ると jsdom が矩形を全部 0 で返し、**単体テストが縮退した
 * 格子を通る**。
 */
export function scheduleRoam(quiet: MotionQuiet, 種を作る: () => RoamSeed | null): void {
  if (quiet !== 'lively') return
  if (減らす()) return
  // **籤で見送る。** ここが「揺れ2回につき1回」を作っている
  if (籤() < ROAM_SKIP) return

  const 遅れ = ROAM_DELAY_MIN_MS + 籤() * (ROAM_DELAY_MAX_MS - ROAM_DELAY_MIN_MS)
  const タイマ = setTimeout(() => {
    待ち.delete(タイマ)
    const 種 = 種を作る()
    if (種 !== null) emitRoam(種)
  }, 遅れ)
  待ち.add(タイマ)
}

/** テストが籤を固定するための口。**製品コードからは呼ばない** */
export function setRoamDice(次: () => number): void {
  籤 = 次
}

/** テストが状態を持ち越さないようにする。**製品コードからは呼ばない** */
export function resetRoam(): void {
  for (const タイマ of 寿命.values()) {
    clearTimeout(タイマ)
  }
  寿命.clear()
  // **待ちも畳む。** 残すと、次のテストの最中に前のテストの線が湧く
  for (const タイマ of 待ち) {
    clearTimeout(タイマ)
  }
  待ち.clear()
  籤 = roamDefaultDice
  次のID = 1
  useRoamStore.setState({ lines: [] })
}
