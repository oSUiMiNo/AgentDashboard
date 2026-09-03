/**
 * 画面を回遊する効果線の層（カード設計§9-7）。
 *
 * 権限確認待ちのカードが跳ねるたびに線が3本だけ飛び出し、画面じゅうを70秒ほど
 * 回遊してから消える（本数は 2026-08-26 に3本固定、寿命は実物を見ながら 50→90→70秒）。
 * **在庫と門は `stores/roam.ts`、経路と `d` は `lib/roam.ts`、見た目と止め方は
 * `roam.css`** が持っていて、ここは並べるだけである。
 *
 * # 1本の線 ＝ `<g>` の中に `<path>` 4枚（フェーズ18・設計§23）
 *
 * 線は「経路の一部」である——経路ぜんぶを持つ path に 30px の窓
 * （`stroke-dasharray`）を滑らせる。4枚は波の位相を 90° ずつ送ったコマで、
 * `opacity` の `steps(1)` 切り替えが1枚ずつ見せる。**位置も向きも `d` が持つ**ので、
 * この層が渡す変数は色・濃さ・窓の節目（線ごとに全長が違う）だけである。
 *
 * # 置き場所
 *
 * `App.tsx` の**場**（`data-roam-field`）の直下に**1枚だけ**置く。場は一覧の中身を
 * 包む in-flow のラッパで、**高さが中身の全高と一致する**——層をここへ入れると
 * 線が中身と一緒にスクロールし、枠沿いの経路が古くならない（設計§9-7-5）。
 *
 * **スクロールする入れ物の直下ではない。** あそこは `overflow-y-auto` なので、中の
 * 絶対配置は**パディングボックス**に対して解決される＝層の高さが可視1画面ぶんに
 * なる。場を1枚挟むことで「層の矩形＝場の矩形」が保てる。
 *
 * カードの中から出すと切る枠（`overflow: hidden`）に切られるのは、前と変わらない。
 *
 * # 購読をここで閉じる
 *
 * `App.tsx` は `<RoamLayer />` と書くだけで props を1つも渡さない。`Shell` は接続の
 * 様子を6本購読しているので、あちらから値を流すと**接続が揺れるたびに層まで
 * 作り直し判定に入る**。
 *
 * # 層そのものを塗らない
 *
 * `background` や `filter` を層へ付けると、**画面いっぱいの合成テクスチャが1枚生える**。
 * 塗ってよいのは線だけ（理由は `roam.css` の冒頭）。
 */

import { type CSSProperties, useEffect } from 'react'
import {
  ROAM_KOMA,
  ROAM_WINDOW_PX,
  measureField,
  roamMilestones,
  roamPathData,
  roamSegmentAt,
  roamSpans,
} from '@/lib/roam'
import {
  ROAM_BIRTH_MS,
  ROAM_EXIT_DELAY_MS,
  ROAM_EXIT_MS,
  ROAM_FLIP_MS,
  ROAM_LIFE_MS,
  useRoamStore,
} from '@/stores/roam'
import { replanRoam } from '@/stores/roam'
import { type MotionQuiet, useSettingsStore } from '@/stores/settings'
import { isReordering, subscribeReordering } from '@/stores/reordering'

/**
 * 盤面が変わってから引き直すまでの待ち。
 *
 * **見た目より「いちばん重い瞬間に重い処理を足さない」を優先する**（設計§20-5-4）。
 * 細い線が数百ミリ秒ずれても目には見えないが、窓を掴んで動かしている最中に経路の
 * 計算を毎フレーム重ねると、**直そうとしている見た目そのものを壊す**。
 */
export const REPLAN_WAIT_MS = 250

/**
 * 窓（30px）が呼び値の総道のりに占める割合。
 *
 * 引き直しの区間割り出しで**窓の頭の位置**を出すのに使う——`stroke-dashoffset` が
 * 動かすのは窓の尻で、頭は窓1つぶん先に居る。
 */
const 窓の割合 = ROAM_WINDOW_PX / roamSpans().reduce((a, b) => a + b, 0)

/**
 * 盤面が変わったら、飛んでいる線の残りの道を引き直す（設計§20-5）。
 *
 * # 引き金は場そのものを見張る
 *
 * 案は2つあった（設計§20-5-7）。**カードと枠の増減はアプリの状態として既に
 * 分かっている**ので状態から知らせる道もあるが、**窓の伸縮とサイドバーの開閉は
 * 状態に出ない**ので、結局こちらの仕組みが要る。**2つ持つより1つに寄せた。**
 *
 * 拾うのは4つ——`tile-shell` の増減・移動・寸法／`project-group` の同じもの／
 * 場そのものの寸法／サイドバーの開閉。**格子はこの2種の矩形からできている**
 * （`lib/roam.ts` の `measureField`）。
 *
 * # 静けさの門をここにも通す
 *
 * `stores/roam.ts` は「**止まっていれば DOM もタイマも1つも生えない**」を守って
 * いる。**見張りも同じ**——「控えめ」「静止」と OS の「動きを減らす」では
 * `MutationObserver` も `ResizeObserver` も繋がない。
 *
 * # まとめて1回だけ
 *
 * 窓を掴んで動かしている間は毎フレーム変わる。**少し待ってから1回だけ引き直し、
 * 待つ間は古い道のまま泳がせる**（設計§20-5-4）。**いちばん重い瞬間に重い処理を
 * 足さない**ことを、数百ミリ秒のずれより優先する——細い線のずれは目に見えない。
 *
 * **待ちのタイマも、積む前に門を通す。**
 */
function useReplanOnLayout(quiet: MotionQuiet): void {
  useEffect(() => {
    // **止まっているなら、見張りもタイマも1つも生やさない**
    if (quiet !== 'lively') return
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    if (typeof MutationObserver !== 'function' || typeof ResizeObserver !== 'function') return

    const 場 = document.querySelector('[data-roam-field]')
    if (場 === null) return

    let 待ち: ReturnType<typeof setTimeout> | undefined

    const 引き直す = (): void => {
      待ち = undefined
      // **並べ替えの最中は引き直さない**（設計§15-1）。印が立つ前に積まれた待ちが
      // ここで発火しうるので、積む側だけでなく走る側にも門を置く
      if (isReordering()) return
      const 層 = document.querySelector('[data-testid="roam-layer"]')
      if (層 === null) return
      // **控えを使わない。** 控えは場の寸法しか見ていないので、カードが増減しても
      // 寸法が同じなら古い格子が返る——引き直しはその変化のために呼ばれている
      const field = measureField(層, true)
      if (field === null) return
      /*
        **いま何区間目に居るかは、生まれた時刻から計算する**（設計§23-6）。
        DOM は読まない——CSS アニメーションの時計は壁時計なので、経過時間と一致する。

        **窓の頭の側で数える。** `stroke-dashoffset` が動かすのは窓の尻で、頭は
        30px 先に居る。尻で数えると、**窓が跨いでいる最中の区間を書き換えて
        窓の形が飛ぶ**——頭の位置（尻＋窓）から区間を引けば、書き換えは必ず
        窓より先になる。
      */
      const 今 = Date.now()
      const いま: { id: number; 添字: number }[] = []
      for (const line of useRoamStore.getState().lines) {
        if (line.exiting === true) continue
        const 経過 = Math.min(1, Math.max(0, (今 - line.生まれた) / ROAM_LIFE_MS))
        const 頭 = Math.min(1, 経過 * (1 - 窓の割合) + 窓の割合)
        いま.push({ id: line.id, 添字: roamSegmentAt(頭) })
      }
      if (いま.length > 0) replanRoam(field, いま)
    }

    const 変わった = (): void => {
      /*
        **連続した変化は、待ち直してまとめる。** 窓を掴んで動かしている間は毎フレーム
        変わるので、**待ちを積み直して「動かし終わってから1回だけ」**にする。

        **先に1回撃つ形にはしない**——それだと掴んでいる間ずっと 250ms ごとに
        引き直すことになり、**いちばん重い瞬間に重い処理を足す**（設計§20-5-4）。
      */
      /*
        **並べ替えの最中の記録は捨てる。待ち直さない**（設計§15-1）。

        待ち直しでは束ねられない——指を止めた瞬間に 250ms 経って走り、押しのけた
        枚数ぶん `measureField` を丸ごと繰り返す（実測で単発 805ms。線が34本なら
        同じ操作が 7.7倍かかった）。並べ替えの間は誰も撃たないので、盤面が変わって
        いても線が古い道を泳ぐだけで、**降りたときに1回引き直せば足りる**。
      */
      if (isReordering()) return
      if (待ち !== undefined) clearTimeout(待ち)
      待ち = setTimeout(引き直す, REPLAN_WAIT_MS)
    }

    /*
      **効果線そのものの出入りを、盤面の変化と数えない。**（2026-08-28・フェーズ15）

      層は場の**中**に居る（設計§9-7-5。線を中身と一緒にスクロールさせるため）ので、
      場の部分木をそのまま見張ると**線が1本生まれるたびに `childList` が動く**。
      それを合図にすると、**生まれたばかりの線を添字0で引き直す**ことになり、
      引き直しは巻きを持たない普通の歩きを返すので**巻きが丸ごと消える**。

      **実測（8790・32本）では、巻きの区間が 11.7px であるべきところ全部 55px で、
      1本も巻きが残っていなかった。** 経路が変わるだけなので絵としては破綻せず、
      **線が真っ直ぐな棒だったフェーズ14 までは、消えていても気づけなかった。**

      **記録の的が全部 層の中なら、盤面は動いていない。**
    */
    const 層の中 = (的: Node): boolean => {
      const e = 的.nodeType === Node.ELEMENT_NODE ? (的 as Element) : 的.parentElement
      return e?.closest('[data-testid="roam-layer"]') != null
    }
    const 見張り = new MutationObserver((記録) => {
      // **判断が付かないときは引き直す側へ倒す。** 記録が空／無いのは「線の出入りだと
      // 分かった」ではないので、見送ると盤面の変化を取りこぼしうる
      if (記録?.length && 記録.every((r) => 層の中(r.target))) return
      変わった()
    })
    見張り.observe(場, { childList: true, subtree: true })
    const 寸法 = new ResizeObserver(変わった)
    寸法.observe(場)
    for (const 器 of 場.querySelectorAll('[data-testid="tile-shell"], [data-testid="project-group"]')) {
      寸法.observe(器)
    }
    // サイドバーの開閉と窓の伸縮は、場の寸法に出る
    window.addEventListener('resize', 変わった)
    /*
      **並べ替えの印を見る。** 立った瞬間に、積んであった待ちを捨てる（立つ直前の
      記録で走ろうとしているもの）。降りた瞬間に `変わった()` を1回——250ms の待ちを
      挟むのは、離した直後にサーバの返事で並びが確定する `childList` と束ねるためと、
      本人がまだ枠へ収まる途中のときに矩形を読まないため。

      **effect の依存には入れない。** 入れると掴むたびに見張りが切れて張り直され、
      いちばん重い瞬間に重い処理を足すことになる（上の「待ち直し」と同じ理由）。
    */
    const 印を離す = subscribeReordering(() => {
      if (isReordering()) {
        if (待ち !== undefined) {
          clearTimeout(待ち)
          待ち = undefined
        }
        return
      }
      変わった()
    })

    return () => {
      見張り.disconnect()
      寸法.disconnect()
      window.removeEventListener('resize', 変わった)
      印を離す()
      if (待ち !== undefined) clearTimeout(待ち)
    }
  }, [quiet])
}

export function RoamLayer() {
  const lines = useRoamStore((state) => state.lines)
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)

  useReplanOnLayout(quiet)

  return (
    <div
      className="roam-layer"
      data-testid="roam-layer"
      // 賑やかのときは属性ごと出さない（カードの器と同じ作法。設計§9-5-3）
      data-quiet={quiet === 'lively' ? undefined : quiet}
      aria-hidden
    >
      {/*
        線を描く1枚の SVG。**線1本 ＝ `<g>` の中に `<path>` 4枚（コマ）**（設計§23-5）。

        位置も向きも `d` が持っている（`lib/roam.ts` の `roamPathData`）ので、
        層が変数で渡すのは色・濃さ・**窓の動きの節目**（線ごとに全長が違う）だけ。
      */}
      <svg className="roam-svg">
        {lines.map((line) => {
          /*
            節目（`stroke-dashoffset` の値）。**コマ0 の波で測った実長**（`lib/roam.ts` の
            `roamMilestones`）。dashoffset は**負で前進**なので符号を反す。
          */
          const 節目 = roamMilestones(line.stops, line.shape)
          const 変数 = {
            '--roam-accent': line.accent,
            // **濃さもカードから受け取る**（カード設計§9-7）。固定値で塗ると、
            // 同じ状態なのに輪と線で色が食い違う（フェーズ8 が塞いだ形）
            '--roam-ink': line.ink,
            '--roam-s1': `${-節目.飛散}px`,
            '--roam-s2': `${-節目.巻き}px`,
            '--roam-s3': `${-節目.終端}px`,
            // 窓の長さの3態。第2引数（描かない区間）は**全長そのもの**——
            // 足りないと窓が2つ見える（dasharray は繰り返すため）
            '--roam-dash-closed': `0 ${節目.全長}`,
            '--roam-dash-open': `${ROAM_WINDOW_PX} ${節目.全長}`,
            '--roam-dash-puff': `${Math.round(ROAM_WINDOW_PX * 1.2)} ${節目.全長}`,
          } as CSSProperties
          return (
            <g
              key={line.id}
              className="roam-line"
              data-testid="roam-line"
              // **引き直しが線を見つけるための札**（設計§20-5-2）
              data-roam-id={line.id}
              style={変数}
            >
              {Array.from({ length: ROAM_KOMA }, (_, koma) => (
                <path
                  key={koma}
                  className={`roam-paper roam-koma-${koma}`}
                  data-testid="roam-paper"
                  data-shape={line.shape}
                  d={roamPathData(line.stops, line.shape, koma)}
                  style={{
                    /*
                      **秒数の出どころを1つにする**（`stores/roam.ts`）。並びは
                      `roam.css` の `animation-name`（発生・コマ・移動・退場）と
                      1対1——**1本でも数が食い違うと CSS はリストを先頭から
                      繰り返し、別の秒数を食う**。エラーにならず目で気づけない。

                      **退場の遅れだけ線ごとに違う**：寿命で死ぬ線は寿命の終わりへ
                      寄せ、**上限で捨てられた線（`exiting`）は 0 にして今すぐ踏む**
                      （要件15-4。退場は窓の長さしか動かさないので、どこに居ても
                      同じ振り付けで畳める）。
                    */
                    animationDuration: `${ROAM_BIRTH_MS}ms, ${ROAM_FLIP_MS}ms, ${ROAM_LIFE_MS}ms, ${ROAM_EXIT_MS}ms`,
                    animationDelay: `0ms, 0ms, 0ms, ${line.exiting === true ? 0 : ROAM_EXIT_DELAY_MS}ms`,
                  }}
                />
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
