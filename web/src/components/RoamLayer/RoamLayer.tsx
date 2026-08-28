/**
 * 画面を回遊する効果線の層（カード設計§9-7）。
 *
 * 権限確認待ちのカードが跳ねるたびに線が3本だけ飛び出し、画面じゅうを90秒ほど
 * 回遊してから消える（本数は 2026-08-26 に3本固定、寿命は 2026-08-28 に 50→90秒）。
 * **在庫と門は `stores/roam.ts`、経路は `lib/roam.ts`、見た目と止め方は `roam.css`**
 * が持っていて、ここは並べるだけである。
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
  measureField,
  readRoamProgress,
  roamCurlSide,
  roamSegmentAt,
  routeVars,
} from '@/lib/roam'
import {
  ROAM_BIRTH_MS,
  ROAM_CURL_DELAY_MS,
  ROAM_CURL_MS,
  ROAM_EXIT_DELAY_MS,
  ROAM_EXIT_MS,
  ROAM_FLIP_MS,
  ROAM_LIFE_MS,
  useRoamStore,
} from '@/stores/roam'
import { replanRoam } from '@/stores/roam'
import { type MotionQuiet, useSettingsStore } from '@/stores/settings'

/**
 * 盤面が変わってから引き直すまでの待ち。
 *
 * **見た目より「いちばん重い瞬間に重い処理を足さない」を優先する**（設計§20-5-4）。
 * 細い線が数百ミリ秒ずれても目には見えないが、窓を掴んで動かしている最中に経路の
 * 計算を毎フレーム重ねると、**直そうとしている見た目そのものを壊す**。
 */
export const REPLAN_WAIT_MS = 250

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
      const 層 = document.querySelector('[data-testid="roam-layer"]')
      if (層 === null) return
      // **控えを使わない。** 控えは場の寸法しか見ていないので、カードが増減しても
      // 寸法が同じなら古い格子が返る——引き直しはその変化のために呼ばれている
      const field = measureField(層, true)
      if (field === null) return
      // **いま何区間目に居るかを読むだけ。** 画面の実測は取らない（設計§20-5-1）
      const いま: { id: number; 添字: number }[] = []
      for (const 線 of 層.querySelectorAll('[data-testid="roam-line"]')) {
        const id = Number((線 as HTMLElement).dataset.roamId)
        if (!Number.isFinite(id)) continue
        const 進み = readRoamProgress(線)
        if (進み === null) continue
        いま.push({ id, 添字: roamSegmentAt(進み) })
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

    return () => {
      見張り.disconnect()
      寸法.disconnect()
      window.removeEventListener('resize', 変わった)
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
      {lines.map((line) => (
        <i
          key={line.id}
          className="roam-line"
          data-testid="roam-line"
          // **引き直しが線を見つけるための札**（設計§20-5-2）
          data-roam-id={line.id}
          style={
            {
              ...routeVars(line.stops),
              '--roam-accent': line.accent,
              // **濃さもカードから受け取る**（カード設計§9-7）。固定値で塗ると、
              // 同じ状態なのに輪と線で色が食い違う（フェーズ8 が塞いだ形）
              '--roam-ink': line.ink,
              // **秒数の出どころを1つにする。** CSS 側へ書くと、寿命のタイマと
              // 見た目の長さが別々に育って食い違う
              animationDuration: `${ROAM_LIFE_MS}ms, ${ROAM_LIFE_MS}ms`,
            } as CSSProperties
          }
        >
          {/*
            紙片そのもの。**外側と役割を分けてある**——外は「道と向き」、内は
            「紙のたわみ」。1つの要素に載せると、進行方向を向く回転と尺取り虫が
            同じ `transform-origin` を取り合う（設計§9-7-2）。

            **秒数はここでも層が渡す。** 出どころを1つに保つ約束は内側にも掛かる。

            **紙片に載るのは4本になった**（2026-08-28・フェーズ15）——生まれ・
            回遊のコマ送り・巻きの曲げ・退場。

            **秒数は `animation-name` と並び順で対応している。** 1本でも数が食い違うと
            **CSS はリストを先頭から繰り返す**ので、残ったほうが繰り上がって
            **別の秒数を食う**。**エラーにならず、画面は動き続けるので目では気づけない。**
            `roam.css` の `animation-name` を触ったら、必ずここも数を合わせること。
          */}
          <b
            className="roam-paper"
            data-testid="roam-paper"
            data-shape={line.shape}
            style={
              {
                /*
                  **巻きの向きは線ごとに違う。** どちらへ膨らむかは経路が持っているので、
                  **引かれた点から読む**（`roamCurlSide`）。形を `data-shape` だけに
                  紐付けると、**半分の線が実際と逆へ曲がる**。

                  **セレクタではなくここで選ぶ。** `[data-shape]` のような属性の
                  セレクタへ `animation-name` を書くと詳細度が (0,1,0)→(0,2,0) へ上がり、
                  `roam.css` 末尾の「止める規則」に勝ってしまう（2026-08-28 に
                  `prefers-reduced-motion` が効かなくなり、E2E が捕まえた）。
                  インラインなら**セレクタを1つも増やさない。**
                */
                '--roam-curl': `roam-curl-${line.shape}-${roamCurlSide(line.stops)}`,
                // 生まれ（尺取り虫）／回遊のコマ送り／巻きの曲げ／退場
                animationDuration: `${ROAM_BIRTH_MS}ms, ${ROAM_FLIP_MS}ms, ${ROAM_CURL_MS}ms, ${ROAM_EXIT_MS}ms`,
                /*
                  **曲げは巻きの窓だけ、退場は寿命の終わりだけ。**
                  遅れが明けるまでは下に敷いたコマ送りがそのまま見える
                  ——だから飛散（幾何的に真っ直ぐな区間）で紐が曲がらない。
                */
                animationDelay: `0ms, 0ms, ${ROAM_CURL_DELAY_MS}ms, ${ROAM_EXIT_DELAY_MS}ms`,
              } as CSSProperties
            }
          />
        </i>
      ))}
    </div>
  )
}
