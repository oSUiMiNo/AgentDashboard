import fs from 'node:fs'
import path from 'node:path'

/**
 * E2E が相手にする「利用者のグローバル設定」を用意する。
 *
 * # なぜ要るのか
 *
 * `e2e/config.toml` の `claude_settings_path` が**存在しないファイル**を指していたため、
 * サーバ側は `refresh_default()` が常に `None`、`recover()` が常に `Skipped` になり、
 * **注入も回復も一度も動いていなかった**。それでもテストが緑だったのは、注入が無いと
 * 擬似 claude が組み込み既定（`default` → `claude-sonnet-5`）で始まり、
 * 「切替前」と「切替後に起こしたセッション」が同じ値になっていたから。
 * つまり**注入と回復の実装を丸ごと消しても通る**状態だった。
 *
 * # なぜ `opus` なのか
 *
 * 注入が効かなかったときの値（`claude-sonnet-5`）と**違う**値を選ぶ。同じ値だと
 * 「注入が効いた」のか「何も起きなかった」のかを画面から区別できない。
 *
 * # 起動順は気にしなくてよい
 *
 * サーバは起動時にこのファイルを読まない。`ClaudeSettings::new` はパスを控えるだけで、
 * 実際に読むのはセッションを起こす瞬間（`session/mod.rs` の `spawn_with`）。
 * テストが走る前に置いてあれば必ず読まれる。
 *
 * # 回復までは見られない
 *
 * 本物の CLI は `/model` を送るとこのファイルを書き換えるが、擬似 claude は書き換えない
 * （教えるには環境変数が要り、`session/lifecycle.rs` の `ALLOWED_ENV` に穴を開けることに
 * なる。**テストのために本番の許可リストは緩めない**）。回復の担保は Rust 側にある。
 */

/** サーバの cwd は `web/`。`e2e/config.toml` の `claude_settings_path` と同じ場所を指す。 */
const SETTINGS_PATH = path.join(
  import.meta.dirname,
  '../.e2e-state/state/claude-settings.json',
)

/**
 * 実物にありがちなキーを一緒に置く。
 *
 * 回復が `model` 以外を巻き込んで書き換えたら、ここが崩れて気づける
 * （擬似 claude は汚さないので E2E で回復そのものは走らないが、置いておく分の害は無い）。
 */
const BODY = `{
  "permissions": { "defaultMode": "auto" },
  "model": "opus",
  "effortLevel": "xhigh"
}
`

export default function globalSetup() {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  // 毎回書き直す。前回の実行が残した値から始めると、実行するたびに前提が変わる
  fs.writeFileSync(SETTINGS_PATH, BODY)
}
