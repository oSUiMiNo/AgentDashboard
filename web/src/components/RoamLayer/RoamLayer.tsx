/**
 * 画面を回遊する効果線の層（カード設計§9-7）。
 *
 * 権限確認待ちのカードが跳ねるたびに線が2〜3本だけ飛び出し、画面じゅうを15秒ほど
 * 回遊してから消える。**在庫と門は `stores/roam.ts`、経路は `lib/roam.ts`、見た目と
 * 止め方は `roam.css`** が持っていて、ここは並べるだけである。
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

import type { CSSProperties } from 'react'
import { routeVars } from '@/lib/roam'
import { ROAM_LIFE_MS, useRoamStore } from '@/stores/roam'
import { useSettingsStore } from '@/stores/settings'

export function RoamLayer() {
  const lines = useRoamStore((state) => state.lines)
  const quiet = useSettingsStore((state) => state.settings.motion_quiet)

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
          */}
          <b
            className="roam-paper"
            data-testid="roam-paper"
            data-shape={line.shape}
            style={{ animationDuration: `${ROAM_LIFE_MS}ms` }}
          />
        </i>
      ))}
    </div>
  )
}
