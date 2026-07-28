/**
 * 小窓に出す「最終活動からの経過時間」（要件の一覧画面）。
 *
 * 「作業中」の表示のまま実はハングしている、というのが一番怖い見落としなので、
 * 状態ラベルの隣に必ず経過時間を並べる。数字が止まっていれば人が気づける。
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 経過ミリ秒を日本語の相対表現にする。
 *
 * 秒単位まで出すのは1分未満のときだけ。それより長い場合に秒まで出しても、
 * 数字が忙しく動くだけで「止まっているかどうか」は読み取りやすくならない。
 */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))

  if (seconds < 5) {
    return 'たった今'
  }
  if (seconds < MINUTE) {
    return `${seconds}秒前`
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}分前`
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)}時間前`
  }
  return `${Math.floor(seconds / DAY)}日前`
}
