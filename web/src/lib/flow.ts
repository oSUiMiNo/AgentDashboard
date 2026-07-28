/**
 * ターミナルのウォーターマーク式フロー制御（設計§10）。
 *
 * xterm.js の `write(data, callback)` は、そのデータを**実際に処理し終えたとき**に
 * コールバックを呼ぶ。呼ばれるまでの合計バイト数（＝端末の処理待ち）を数えておき、
 *
 * - `high` を超えたら サーバへ `pause`（サーバは PTY の読み取りを止める）
 * - `low` を下回ったら `resume`
 *
 * とすることで、ブラウザが処理しきれない量を溜め込まずに済む。バイトは1つも捨てない。
 * ブラウザの遅さが PTY 経由で CLI まで伝わり、CLI 側が自然に減速する。
 *
 * # なぜ端末から切り離してあるのか
 *
 * しきい値の判定は「数を数えて境目で1回だけ知らせる」という、それだけで完結する規則。
 * xterm のインスタンスから切り離しておくと、境目・二重通知・回復の順序を実ブラウザ
 * 無しで固定できる。実際にブラウザで働くことは E2E が別途見る。
 */

/** しきい値はサーバ設定（設計§12）なので、送られてきた最新の値を都度読む。 */
export interface FlowThresholds {
  high: number
  low: number
}

export interface FlowController {
  /** 端末へ書き始めた（処理待ちが増える）。 */
  begin: (size: number) => void
  /** 端末が処理し終えた（処理待ちが減る）。 */
  done: (size: number) => void
  /** いま端末が抱えている未処理バイト数。 */
  pending: () => number
  paused: () => boolean
  /** これまでに何回止めたか。瞬間の値より取りこぼしにくい観測点。 */
  pauseCount: () => number
  /** これまでに書き込みを始めた総バイト数。 */
  totalBytes: () => number
}

interface Options {
  /** 判定のたびに読む。サーバの `hello` で値が変わっても追随できる */
  thresholds: () => FlowThresholds
  onPause: () => void
  onResume: () => void
}

export function createFlowController({
  thresholds,
  onPause,
  onResume,
}: Options): FlowController {
  let pending = 0
  let paused = false
  let pauseCount = 0
  let totalBytes = 0

  return {
    begin(size) {
      pending += size
      totalBytes += size
      // 既に止めているなら重ねて送らない。サーバ側は冪等だが、
      // 同じ指示を毎フレーム送ると WebSocket が無駄な往復で埋まる
      if (!paused && pending > thresholds().high) {
        paused = true
        pauseCount += 1
        onPause()
      }
    },
    done(size) {
      pending = Math.max(0, pending - size)
      if (paused && pending < thresholds().low) {
        paused = false
        onResume()
      }
    },
    pending: () => pending,
    paused: () => paused,
    pauseCount: () => pauseCount,
    totalBytes: () => totalBytes,
  }
}
