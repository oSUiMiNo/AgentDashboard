/**
 * 色のコントラストを測る（カード設計§26-5）。
 *
 * # なぜ要るのか
 *
 * **この道具が無かったので、床は数値の直書きで守られていた。** `protocol.test.ts` の
 * 「輪の薄い側が 3:1 を満たす」は期待値を並べるだけで、**比そのものは誰も計算して
 * いない**——あそこには「前の版はどの模型でも再現できない数値が書いてあった」という
 * 自戒が残っており、**コメントの数字は誰も守らない**。
 *
 * フェーズ21 は札の地を沈めるので、**沈めた地と文字の比が床（4.5:1）を割らないこと**を
 * 機械で見張る必要がある。除外表が守ろうとしたのがまさにそこなので、**数字で守らないと
 * 同じ穴がまた開く**。
 *
 * # 模型は `protocol.test.ts` と揃える
 *
 * **合成の相手は地、判定の相手は文字**（設計§9-2-1）。半透明の板は先に地の上で
 * 混ぜて不透明な色にし、そのうえで文字と比べる。
 *
 * 混ぜるのは**ガンマの掛かったままの値**である。CSS の `opacity` は既定の色空間
 * （sRGB）でそのまま合成するので、線形へ戻してから混ぜると実際の画面と食い違う。
 */

/** `#rrggbb` を 0〜255 の3つ組へ。**3桁の短縮形は受け取らない**（実物に出てこない） */
export function rgb(hex: string): [number, number, number] {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`色として読めません：${hex}`)
  return [
    Number.parseInt(m[1], 16),
    Number.parseInt(m[2], 16),
    Number.parseInt(m[3], 16),
  ]
}

/** sRGB の1成分を線形へ戻す（WCAG 2.x の定義そのまま）。 */
function 線形(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** 相対輝度（WCAG 2.x）。 */
export function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map(線形)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * コントラスト比（WCAG 2.x）。**順序は問わない**——明暗のどちらを先に渡しても同じ値。
 */
export function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const [明, 暗] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (明 + 0.05) / (暗 + 0.05)
}

/**
 * `色` を不透明度 `alpha` で `地` の上に置いたときの、見える色。
 *
 * **画面と同じく丸めてから返す。** ブラウザは 8bit の面へ描くので、端数を持ったまま
 * 比を出すと実測とわずかにずれる。
 */
export function composite(
  色: [number, number, number],
  地: [number, number, number],
  alpha: number,
): [number, number, number] {
  return 色.map((c, i) => Math.round(alpha * c + (1 - alpha) * 地[i])) as [
    number,
    number,
    number,
  ]
}
