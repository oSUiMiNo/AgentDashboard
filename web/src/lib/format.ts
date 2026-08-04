/**
 * 画面へ出すための整形。
 *
 * 時刻まわりは `lib/time.ts` が持っている。こちらは**大きさ**のように、
 * 時間とは関係のない値のためのもの。
 */

/** 桁の呼び名。1024 ごとに繰り上げる。 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * バイト数を人が読める形にする。
 *
 * **保管庫の使用量に使う。** 版ごとに数十MB 積み上がるので、黙って溜まる形にせず
 * 「いま何を抱えているか」を出す（CICD設計§14）。
 *
 * 小数を出すのは MB 以上だけ。バイトやキロバイトで「1.0 KB」と出しても、
 * 読む側にできることが増えない。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit >= 2 && value < 100 ? 1 : 0
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}
