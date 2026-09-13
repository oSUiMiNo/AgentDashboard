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
 * 1秒未満はそのまま小数で出す（50ms なら「0.05秒」、300ms なら「0.3秒」）。ミリ秒の
 * まま出すと、他の選択肢（20秒）と桁が揃わず比べにくい。**選択肢を1つ足しても
 * ここは直さなくてよい**——桁で場合分けしていないため。
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

/**
 * 残りミリ秒を日本語の相対表現にする。[`formatElapsed`] と対になる**未来向き**。
 *
 * # なぜ絶対時刻ではなく相対を主に出すのか
 *
 * 使用上限の窓が戻る時刻は、**知りたいのが「いつ」ではなく「あとどれだけ待つか」**である
 * （status 設計「上限が近いことを知らせたいなら、色ではなく形か位置で分ける」）。
 * 「05:10」と出されても、いまが何時かを別に見なければ待ち時間が分からない。
 * **絶対時刻は `title` に添える**——正確さが要るのはそちらで、日常の判断は相対で足りる。
 *
 * # 過ぎている場合はここで扱わない
 *
 * 負の残りを「リセット済み」と言うかどうかは**呼ぶ側の言い回し**なので、ここは
 * 0 へ丸めて「まもなく」を返すに留める。時刻の書式化に、使用上限固有の語を混ぜない。
 */
export function formatUntil(remainingMs: number): string {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000))

  if (seconds < 5) {
    return 'まもなく'
  }
  if (seconds < MINUTE) {
    return `あと${seconds}秒`
  }
  if (seconds < HOUR) {
    return `あと${Math.floor(seconds / MINUTE)}分`
  }
  if (seconds < DAY) {
    return `あと${Math.floor(seconds / HOUR)}時間`
  }
  return `あと${Math.floor(seconds / DAY)}日`
}

/**
 * 期間のミリ秒を日本語にする。[`formatElapsed`] [`formatUntil`] と違い**向きを持たない**。
 *
 * # なぜ [`formatElapsed`] を流用できないのか
 *
 * あちらは「〜前」を付ける**過去向きの相対**で、`total_duration_ms` のような**期間**へ
 * 当てると「3分前」と出る。**所要時間ではなく最終更新時刻に読める**——数字が同じでも
 * 意味が変わってしまう。向きのある語を持たない関数がここに無かったので足した。
 *
 * # 1時間を超えたら分を併記する
 *
 * 相対表現の2つは「2時間」で丸めてよい——あちらが答える問いは「**止まっていないか**」
 * 「**あとどれだけ待つか**」で、分の精度が判断を変えないためである。
 * 一方これは**積み上がった実績**なので、「2時間」と「2時間55分」を同じに見せると
 * 費用や手間の見当が付かない。**粗さの許容が違うので、書式も違ってよい。**
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))

  if (seconds < MINUTE) {
    return `${seconds}秒`
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}分`
  }
  const hours = Math.floor(seconds / HOUR)
  const minutes = Math.floor((seconds % HOUR) / MINUTE)
  if (minutes === 0) {
    return `${hours}時間`
  }
  return `${hours}時間${minutes}分`
}
