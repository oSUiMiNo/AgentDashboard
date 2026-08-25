/**
 * 画面を回遊する効果線の経路（カード設計§9-7）。
 *
 * # なぜ純関数なのか
 *
 * 経路を毎フレーム計算すると `requestAnimationFrame` が要り、**12セッションの fps を
 * 測っている計測（`web/e2e/perf.spec.ts`）に直撃する**。ここで停留点を先に決めて
 * しまえば、あとは CSS のキーフレームが合成スレッド側で回すだけになる。
 *
 * したがってこのファイルは**時計を持たない**。持っているのは「跳ねたカードの位置と
 * 画面の大きさから、5つの停留点を決める」という計算だけである。
 *
 * # 乱数を使わない
 *
 * `Math.random()` を使うとテストが揺れる。**種（`seed`）から決まる**形にしてあるので、
 * 同じ種なら必ず同じ経路になる。見た目のばらつきは、種が線ごとに違うことで出る。
 */

/** 停留点。`x` / `y` はビューポート座標（層が `fixed` なのでそのまま使える） */
export interface RoamStop {
  x: number
  y: number
  /** 進む向き（度）。線は進行方向を向く＝漫画のスピード線の読みになる */
  r: number
}

/** 画面の内側へ、これだけ余白を取る。線が縁で見切れないため */
const MARGIN = 24

/** 経路の停留点の数。`roam.css` のキーフレームの停留点と揃える */
export const ROAM_STOPS = 5

/**
 * 種から 0〜1 の値を作る。
 *
 * **暗号の用途ではない。** ばらけて、同じ種なら同じ値が出ればよい。
 */
function 散らす(seed: number, 回: number): number {
  const x = Math.sin(seed * 12.9898 + 回 * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function 挟む(値: number, 下: number, 上: number): number {
  if (上 < 下) {
    // 画面が余白より狭い。真ん中へ寄せる以外にできることが無い
    return (下 + 上) / 2
  }
  return Math.min(上, Math.max(下, 値))
}

/**
 * 跳ねたカードから飛び出して、画面を回遊する経路を1本ぶん作る。
 *
 * 第1点は**カードの上辺の中央**。跳ねた勢いで上へ抜ける読みにする——飛び出しの向きを
 * カードの外側で揃えたいので、`rect` の中心ではなく縁から出す。
 *
 * 以降の4点は、画面を `MARGIN` だけ内側へ詰めた範囲に散らす。**画面の外へ出さない**のは
 * 見切れを防ぐためだけでなく、`fixed` の要素が**スクロールできる範囲を押し広げる事故**を
 * 起こさないためでもある。
 */
export function planRoute(
  rect: { left: number; top: number; width: number },
  viewport: { width: number; height: number },
  seed: number,
): RoamStop[] {
  const 左 = MARGIN
  const 右 = viewport.width - MARGIN
  const 上 = MARGIN
  const 下 = viewport.height - MARGIN

  const 点: { x: number; y: number }[] = [
    { x: rect.left + rect.width / 2, y: rect.top },
  ]

  for (let i = 1; i < ROAM_STOPS; i += 1) {
    点.push({
      x: 挟む(左 + 散らす(seed, i) * (右 - 左), 左, 右),
      y: 挟む(上 + 散らす(seed, i + 100) * (下 - 上), 上, 下),
    })
  }

  // 向きは**次の点へ進む向き**。最後の点だけは、その手前の区間の向きを引き継ぐ
  return 点.map((点い, i) => {
    const 次 = 点[i + 1] ?? 点い
    const 前 = 点[i - 1] ?? 点い
    const dx = i + 1 < 点.length ? 次.x - 点い.x : 点い.x - 前.x
    const dy = i + 1 < 点.length ? 次.y - 点い.y : 点い.y - 前.y
    return {
      x: 点い.x,
      y: 点い.y,
      r: (Math.atan2(dy, dx) * 180) / Math.PI,
    }
  })
}

/**
 * 停留点を CSS のカスタムプロパティへ写す。
 *
 * キーフレーム側は `var(--roam-x0)` … の形で読むだけにしてある——**経路の決め方を
 * CSS へ持ち込まない**ので、値の出どころが1つに保たれる。
 */
export function routeVars(stops: RoamStop[]): Record<string, string> {
  const vars: Record<string, string> = {}
  stops.forEach((stop, i) => {
    vars[`--roam-x${i}`] = `${Math.round(stop.x)}px`
    vars[`--roam-y${i}`] = `${Math.round(stop.y)}px`
    vars[`--roam-r${i}`] = `${Math.round(stop.r)}deg`
  })
  return vars
}
