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

/**
 * 画面の更新間隔を日本語にする（セルフホスト化設計§11-3）。
 *
 * # なぜ出すのか
 *
 * 別の PC のターミナルは、無操作のあいだ**間隔をあけて**画面が届く（既定20秒）。
 * 出さないと、利用者は「相手が止まっている」のか「間引かれているだけ」なのかを
 * 区別できない——1秒でも20秒でも、見えているのは同じ止まった画面になる。
 *
 * 1秒未満は既定の選択肢（50ms）を「0.05秒」と読ませる。ミリ秒のまま出すと、
 * 他の選択肢（20秒）と桁が揃わず比べにくい。
 */
export function formatScreenInterval(intervalMs: number): string {
  const seconds = intervalMs / 1000
  if (seconds < 1) {
    return `${seconds}秒`
  }
  return `${Math.round(seconds)}秒`
}

/**
 * epoch ミリ秒を「いつのことか」が読める絶対時刻にする。
 *
 * # なぜ相対表示だけでは足りないのか
 *
 * 「3日前」は近い過去には効くが、**版がいつのものか**を見るには弱い。数ヶ月前の版を
 * 動かしていると「92日前」としか出ず、どの版の時期だったかを思い出せない。
 * 版の話では絶対時刻のほうが手掛かりになるので、こちらを主に出して相対を添える。
 *
 * 0 と未定義は「分からない」として扱う。**推測で埋めない**——実行ファイルの時刻は
 * 読めないことがあり、そこで嘘の日付を出すと更新の判断を誤らせる。
 */
export function formatDateTime(epochMs: number | null | undefined): string | null {
  if (epochMs === null || epochMs === undefined || epochMs <= 0) {
    return null
  }
  const at = new Date(epochMs)
  if (Number.isNaN(at.getTime())) {
    return null
  }
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}
