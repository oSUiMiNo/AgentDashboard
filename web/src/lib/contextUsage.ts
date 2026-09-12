/**
 * コンテキスト残量の見せ方を決める側（コンテキスト残量設計§6）。
 *
 * **ここは純関数だけを置く。** `window` も `document` も読まない——測る側と混ざると、
 * jsdom が矩形を固定で返すぶん**何も確かめないまま緑になる**（並べ替えが同じ理由で
 * `reorder.ts` と `useReorder.ts` に割れている）。
 */

/**
 * トークン数を `/context` と同じ見た目へ畳む（`241.5k` ／ `1m`）。
 *
 * **利用者が突き合わせるのは `/context` の表示なので、桁の畳み方をあちらに合わせる。**
 * 実測では見出しが `241.5k / 1m tokens (24%)` の形で出る。
 *
 * 末尾の `.0` は落とす——分母はちょうど `1000000` で届くので、落とさないと
 * `1.0m` になって実物と食い違う。
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${trimZero(n / 1_000_000)}m`
  }
  if (n >= 1_000) {
    return `${trimZero(n / 1_000)}k`
  }
  return String(n)
}

function trimZero(value: number): string {
  const s = value.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
