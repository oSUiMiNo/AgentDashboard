/**
 * 画面を回遊する効果線の層（カード設計§9-7）。
 *
 * 権限確認待ちのカードが跳ねるたびに線が2〜3本だけ飛び出し、画面じゅうを15秒ほど
 * 回遊してから消える。**在庫と門は `stores/roam.ts`、経路は `lib/roam.ts`、見た目と
 * 止め方は `roam.css`** が持っていて、ここは並べるだけである。
 *
 * # 置き場所
 *
 * `App.tsx` の `<main>` の直下に**1枚だけ**置く。カードの中から出すと、切る枠の
 * `overflow: hidden` にも一覧のスクロールする入れ物にも切られる。
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
              // **秒数の出どころを1つにする。** CSS 側へ書くと、寿命のタイマと
              // 見た目の長さが別々に育って食い違う
              animationDuration: `${ROAM_LIFE_MS}ms, ${ROAM_LIFE_MS}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
