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
import {
  type RoamField,
  type RoamJoin,
  type RoamStop,
  planRoute,
  replanRoute,
} from '@/lib/roam'

/**
 * 画面に同時に居てよい線の数。
 *
 * **寿命と噛み合っていないと、書いた寿命どおりに生きない。** 上限が小さいと
 * **古いものから捨てられて、実際の寿命は上限で決まる**（前の版は 10本上限で、
 * 50秒と書いても 16秒しか生きなかった）。
 *
 * **発火は平均 9.6秒に1回**（跳ねは 4.8秒に1回だが、[`ROAM_SKIP`] で半分見送る）で
 * 1回 [`ROAM_LINES`] 本なので、[`ROAM_LIFE_MS`] のあいだに出る線は
 * **84 ÷ 9.6 × 3 ≒ 26本**（寿命を 1.2倍にしたので 22→26 へ増えた）。
 * **32 のまま据え置く**（フェーズ18）——上限に
 * 張り付かないぶんには害が無く、**乱数で撃つ以上、揺れの山に余裕が要る**
 * （切り詰めると揺れの山で毎回押し出され、書いた寿命どおりに生きない）。
 *
 * 待っているカードが2枚以上なら、やはり上限が先に効く——そこは直さない
 * （最古から捨てる作法は据え置き）。
 */
export const ROAM_MAX = 32

/**
 * 1本が飛んでいる時間。`roam.css` へは層が渡すので、秒数の出どころはここだけ。
 *
 * **90秒 → 70秒**（2026-08-28・要件15-8）→ **70秒 → 84秒**（2026-08-31・
 * 要件15-9「寿命を 1.2倍」。どちらも利用者の指定）。
 *
 * **速さは「総道のり ÷ 寿命」で決まる**——寿命だけ延ばすと遅くなるので、
 * 「速さを 0.8倍」と両立させるには**道のりを 0.8 × 1.2 ＝ 0.96倍**にする。
 * 幾何の側も一緒に動かした（`lib/roam.ts` の `ROAM_ROAM` 29→28。総道のり
 * 1797.4 → 1741.4px）。結果は **20.73px/秒**＝25.68 の 0.807倍で、
 * 要件15-9「0.8倍」の 100.9%（区間は整数なので割り切れない。設計§23-5）。
 */
export const ROAM_LIFE_MS = 84_000

/**
 * 跳ねても撃たずに見送る確率。
 *
 * **跳ねは 4.8秒に1回**なので、半分見送ると**平均 9.6秒に1回**になる
 * （見送る確率 p のとき撃つまでの平均試行回数は `1/(1-p)`。`1/(1-0.5) = 2`）。
 * 利用者の言葉は「**揺れ2回につき1回くらい**」（要件14-1）。
 *
 * **1/3 ではない。** `1/(1-1/3) = 1.5` で平均 7.2秒にしかならず、寿命のあいだに
 * `70 ÷ 7.2 × 3 ≒ 29本` 出て [`ROAM_MAX`] の余裕を食い潰していく——**書いた寿命に
 * 届かない線が出やすくなる**。
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
 * 退場の小芝居（ぷるぷる）の長さ。**～1秒**（調査レポート §14-1・設計§20-4-6）。
 *
 * `animate.css` の `jello` が下敷きだが、**あれは8段階で減衰する**ので写すと
 * **周期の下限 0.333秒（1秒に3回）に当たる**。ここは**1秒で2往復＝2Hz**に抑えてある。
 */
export const ROAM_ACT_MS = 1_000

/**
 * 消える瞬間の長さ。**67〜133ms・後半加速**（調査レポート §14-1）。
 *
 * **小芝居と分ける。** 全体が1つのカーブになっていると「ゆっくり消えた」に見えて、
 * コミカルさが出ない。
 */
export const ROAM_VANISH_MS = 130

/** 退場ぜんぶの長さ。**層はこれを `animation-duration` として渡す** */
export const ROAM_EXIT_MS = ROAM_ACT_MS + ROAM_VANISH_MS

/**
 * 退場を始めるまでの遅れ。**寿命の終わりへ寄せる**（自然に死ぬ線の場合）。
 *
 * **上限で捨てられる線は、この遅れを 0 にして今すぐ退場を踏む**（要件15-4・設計§23-8。
 * 退場は `stroke-dasharray`（窓の長さ）だけを動かすので、**線が経路のどこに居ても
 * 同じ振り付けで畳める**——だから遅れを差し替えるだけで流用できる）。
 *
 * **線ごとに散らしてはいけない。** 散らすと寿命の終わりと畳み終わりがずれる。
 * 位相は**放った時刻がすでに散らしている**（調査レポート §14-7）。
 */
export const ROAM_EXIT_DELAY_MS = ROAM_LIFE_MS - ROAM_EXIT_MS

/**
 * 絵（コマ）の切り替えが1巡する長さ。**4コマ ÷ 1.6秒 ＝ 毎秒2.5コマ。**
 *
 * フェーズ18 でも**この値は動かさない**——利用者の明示（2026-08-28）：
 * 「コマ毎に絵を切り替える部分はうまくいっている」「画像切り替えのコマ数は今のままでOK」。
 *
 * コマの実体は **path の変種4枚**（波の位相を 90° ずつ送ったもの。`lib/roam.ts` の
 * `roamPathData`）を `opacity` の `steps(1)` で1枚ずつ見せる形（設計§23-5 の決着）。
 *
 * **移動のコマ数とは別物である。** あちらは `roam-slide`（窓の位置）の `steps()` で、
 * 回遊は毎秒6コマ・飛散と巻きは毎秒12コマ（要件15-6）。
 */
export const ROAM_FLIP_MS = 1_600

/** コマ（path の変種）の枚数。`lib/roam.ts` の `ROAM_KOMA` と揃える */
export const ROAM_FLIP_FRAMES = 4

/**
 * 1回の跳ねで飛ばす本数。
 *
 * **3本に固定した**（利用者の指定・2026-08-26。設計§9-7-2）。前は種で 2 と 3 を
 * 交互に出していたが、振り付けが「手書きの3本線が放射状に出てくる」と決まったので、
 * **本数が揺れると①の読みが崩れる**。
 */
export const ROAM_LINES = 3

/**
 * 効果線の色。**カードの状態から切り離してある**（2026-08-28・利用者の回答）。
 *
 * # なぜ状態から切り離したか
 *
 * フェーズ8 が「同じ状態はどこでも同じ色で出る」を作り、輪と線の色を揃えた。
 * **その規則そのものは生きている**——輪・バー・タグは状態の色のままである。
 * **外れるのは効果線だけ**で、利用者の指定による（要件14-6）。
 *
 * # なぜ利用者が示した `#23396D` ではないのか
 *
 * 利用者が画像で示した紺は `#23396D` だったが、**背景 `#0A0A0A` との明暗差が
 * 1.77 : 1 しかなく沈む**（UI 部品として見分けがつく最低ラインは 3 : 1）。
 * **幅も 2.5px へ細めるので、暗さと細さが同時に効く**。効果線は承認待ちのカードから
 * 出て「あなたの番だ」と伝える役目なので、沈むと役目を失う。
 *
 * **色相（222°）はそのままに、明るさだけ上げた**値を利用者が選んだ。明暗差は
 * **5.41 : 1**——いまの琥珀75%の実効色 `#BA7F1D` が 5.79 : 1 なので、ほぼ同じ強さになる。
 *
 * **`DESIGN.md` §11.2 の役割色4つ（Cyan / Amber / Lime / Coral）のどれとも一致しない。**
 * 役割表は書き換えず、**表の外の装飾色を1つだけ立てる**という位置づけである。
 */
export const ROAM_ACCENT = '#6584CD'

/**
 * 効果線の濃さ。**常に不透明**（2026-08-28・利用者の回答。要件14-4）。
 *
 * **接続が切れていても沈めない。** `DISCONNECTED_INK_SCALE` を効果線の経路へ
 * 掛けるのをやめた——フェーズ12 が「輪とバーは沈むのに線だけ沈まない」を直した
 * 成果を、ここだけ覆すことになる。
 *
 * **「一旦」である**（利用者の言葉）。戻すときは、`SessionTile.tsx` が渡す値へ
 * `statusInk(status, connected)` を掛け直せばよい。**定数そのものは消していない**
 * ——カード側の `[data-connected='false']` が引き続き使っており、`tile.test.ts` が
 * 両者の食い違いを見張っている。
 */
export const ROAM_INK = '100%'

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
  /**
   * 生まれた時刻（`Date.now()`）。**進み具合の唯一の出どころ**（設計§23-6）。
   * CSS アニメーションの時計は壁時計なので、経過時間がそのまま窓の位置になる
   * ——引き直しで DOM を読む必要が無くなる。
   */
  生まれた: number
  /**
   * 退場中か。**上限で捨てられる線も、消える前に退場の演出を踏む**（要件15-4）。
   * true のあいだも描かれ続け、退場が終わってから外れる。
   */
  exiting?: boolean
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

  // **退場中の線は数に入れない。** 入れると、捨てた線が消え切るまでの 1.13秒だけ
  // 「満杯」に見えて、撃った線が細る——跳ねと線の対応が崩れて不具合に見える
  const 生きている = useRoamStore.getState().lines.filter((line) => line.exiting !== true)
  const 空き = ROAM_MAX - 生きている.length

  // **空きに応じて減らす。** 満杯のときだけ最古を落として出す——新しいほうを
  // 捨てると「このカードだけ線が出ない」と読めてしまう。
  // **捨てる線も退場を踏む**（要件15-4）。即座には消えないので、退場が終わるまでの
  // あいだ画面の本数は ROAM_MAX を最大 ROAM_LINES 本だけ超える
  const 出す = 空き >= ROAM_LINES ? ROAM_LINES : Math.max(1, 空き)
  const 落とす = Math.max(0, 出す - 空き)
  for (let i = 0; i < 落とす; i += 1) {
    const 最古 = 生きている[i]
    if (最古 === undefined) break
    退場させる(最古.id)
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
      // **1組として渡す**（2026-08-28・要件14-3）。1本ずつ独立に籤を引くと、
      // 候補が少ない場面で2本が同じ点へ着いて重なる
      stops: planRoute(seed.field, id, i, 出す),
      生まれた: Date.now(),
    })
    寿命.set(
      id,
      setTimeout(() => 畳む(id), ROAM_LIFE_MS),
    )
  }

  useRoamStore.setState((state) => ({ lines: [...state.lines, ...足す] }))
}

/**
 * 線を**退場の演出を踏ませてから**消す（要件15-4・設計§23-8）。
 *
 * 前の版は上限に当たった線を `畳む` で**即座に**消していた——アニメーションを
 * 待たないので、**捨てられる線は退場に一度も出会えない**。退場は窓の長さ
 * （`stroke-dasharray`）だけを動かす振り付けなので、**線が経路のどこに居ても
 * 同じ形で畳める**。層は `exiting` を見て退場の遅れを 0 に差し替える。
 */
function 退場させる(id: number): void {
  const 線 = useRoamStore.getState().lines.find((l) => l.id === id)
  if (線 === undefined || 線.exiting === true) return
  const 前の寿命 = 寿命.get(id)
  if (前の寿命 !== undefined) clearTimeout(前の寿命)
  useRoamStore.setState((state) => ({
    lines: state.lines.map((l) => (l.id === id ? { ...l, exiting: true } : l)),
  }))
  寿命.set(
    id,
    setTimeout(() => 畳む(id), ROAM_EXIT_MS),
  )
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

/**
 * **盤面が変わったので、残りの道を引き直す**（設計§20-5）。
 *
 * # 入口はここ1つ
 *
 * 用途は2つある——**いま**（盤面が変わったらすぐ引き直す）と、**次のイシュー**
 * （カードがぶつかったら退きながら引き直す）。`繋ぎ` を引数に持たせてあるので、
 * あちらは**引き金と繋ぎ方を足すだけ**で済む（設計§20-5-3）。
 * **1回しか呼ばれないからといって畳まないこと。**
 *
 * # 逃げ道
 *
 * `replanRoute` が `null` を返したら——**要求どおりの区間数を返せなかった**
 * （通路が消えた・場が狭くなった）——**引き直さず、その場で寿命を早めて退場させ、
 * 次の放出に任せる**（設計§20-5-5）。**枚数のような外から決めた閾値は置かない。**
 *
 * # 数えられるようにしてある
 *
 * 返すのは「実際に引き直した本数」。**まとめて1回になっているかは、呼ばれた回数を
 * 数えないと分からない**——線の見た目だけを見ると、毎フレーム引き直していても
 * 同じに見えて緑になる（テスト計画の壊し方）。
 */
export function replanRoam(
  field: RoamField,
  いま: { id: number; 添字: number }[],
  繋ぎ: RoamJoin = 'すぐ',
): number {
  let 引き直した = 0
  const 逃がす: number[] = []
  useRoamStore.setState((state) => ({
    lines: state.lines.map((line) => {
      const 場所 = いま.find((x) => x.id === line.id)
      if (場所 === undefined) return line
      const 現在 = line.stops[場所.添字]
      if (現在 === undefined) return line
      const 残り = replanRoute(field, line.id, 場所.添字, 現在, 繋ぎ)
      if (残り === null) {
        逃がす.push(line.id)
        return line
      }
      引き直した += 1
      // **いま通過中の区間から手前は1つも触らない。** 触ると補間の途中で始点が
      // 動いて線が飛ぶ（設計§20-5-2）
      return { ...line, stops: [...line.stops.slice(0, 場所.添字 + 1), ...残り] }
    }),
  }))
  // **逃げ道は寿命を早めるだけ。** 引き直しはしない
  for (const id of 逃がす) 畳む(id)
  return 引き直した
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
