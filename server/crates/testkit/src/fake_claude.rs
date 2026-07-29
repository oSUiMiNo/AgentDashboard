//! 擬似 claude（`fake-claude` バイナリ）との取り決め。
//!
//! バイナリ本体と、それを起動するテストの両方から参照する定数と補助関数を置く。
//! マーカー文字列を1箇所にまとめておかないと、片方だけ変えたときに「出力を待ち続けて
//! タイムアウトする」という原因の分かりにくい失敗になる。

use std::path::PathBuf;

/// 起動完了を示すマーカー。テスト側はこれを待ってから入力を送る。
pub const READY_MARKER: &str = "[fake-claude] ready";
/// 1行処理したことを示す行頭。
pub const RECEIVED_PREFIX: &str = "[fake-claude] received: ";
/// `dump` が書き出す起動引数の行頭。
pub const ARGV_PREFIX: &str = "[fake-claude] argv: ";
/// `dump` が書き出す環境変数の行頭。
pub const ENV_PREFIX: &str = "[fake-claude] env: ";
/// `dump` の出力が終わったことを示すマーカー。ここまで読めば全件揃っている。
pub const DUMP_END_MARKER: &str = "[fake-claude] dump-end";
/// `flood` の出力が終わったことを示すマーカー。
pub const FLOOD_END_MARKER: &str = "[fake-claude] flood-end";
/// `hook` がフックコマンドを実行し終えたことを示す行頭。
///
/// 実行が終わってから出すので、テストはこれを待てば「ダッシュボード側が受け取り終えた」と
/// みなせる。マーカーが無いと、状態が変わるより先に検証へ進んでしまう。
pub const HOOK_SENT_PREFIX: &str = "[fake-claude] hook-sent: ";
/// `hook` に失敗したことを示す行頭（設定が読めない・イベントが無い等）。
pub const HOOK_FAILED_PREFIX: &str = "[fake-claude] hook-failed: ";
/// `jsonl` がトランスクリプトへ追記し終えたことを示す行頭。
///
/// 追記が済んでから出すので、テストはこれを待てば「パーサが読める状態になった」あとの
/// 検証へ進める。マーカーが無いと、書き終わる前に画面を見に行ってしまう。
pub const JSONL_APPENDED_PREFIX: &str = "[fake-claude] jsonl-appended: ";
/// `jsonl` に失敗したことを示す行頭。
pub const JSONL_FAILED_PREFIX: &str = "[fake-claude] jsonl-failed: ";
/// `crash` で自ら異常終了する直前のマーカー。
pub const CRASH_MARKER: &str = "[fake-claude] crash";
/// 終了時のマーカー。
pub const BYE_MARKER: &str = "[fake-claude] bye";
/// `flood` が繰り返し吐くパターン。ASCII のみで、端末の制御シーケンスを含まない。
///
/// 64バイトごとに改行を入れているのは、実際の CLI 出力に近づけるため。改行の無い
/// 数MBの1行はブラウザ側の折り返し処理だけが重くなり、測りたいもの（配信とフロー制御）が
/// 見えにくくなる。
pub const FLOOD_PATTERN: &[u8] = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abc\n";

/// 権限モードのフッタを書き出すときの行頭。
///
/// 本物の TUI は `⏸ manual mode on · ? for shortcuts` のような行を画面下部に出し続ける。
/// ダッシュボードはそこからモードを読む（設計§11）ので、擬似 claude も**本物と同じ語句**を
/// 出す。語句が違うと、擬似では読めるのに本物では読めない（またはその逆）という
/// 一番たちの悪いずれ方になる。
pub const FOOTER_PREFIX: &str = "[fake-claude] footer: ";

/// 権限モード（正規値）と、本物が出すフッタの語句の対応。
///
/// 巡回の順序でもある。本物の実測（設計§11）に合わせて
/// `default → acceptEdits → plan` を基本とし、`bypassPermissions` は**起動時に
/// 指定した場合だけ**先頭へ加わる。`dontAsk` と `auto` は巡回に入らない。
pub const FOOTER_LABELS: &[(&str, &str)] = &[
    ("default", "⏸ manual mode on"),
    ("acceptEdits", "⏵⏵ accept edits on"),
    ("plan", "⏸ plan mode on"),
    ("auto", "⏵⏵ auto mode on"),
    ("dontAsk", "⏵⏵ don't ask on"),
    ("bypassPermissions", "⏵⏵ bypass permissions on"),
];

/// Shift+Tab の巡回に入るモード（`bypassPermissions` 起動時を除く）。
pub const CYCLE_MODES: &[&str] = &["default", "acceptEdits", "plan"];

/// 全承認をスキップで起動したときに出す、責任の受諾を尋ねる画面。
///
/// 本物では一度受け入れると以後出ないため実測できていない（設計§11）。ここでは
/// **必ず出す**ことで、ダッシュボード側の自動応答を毎回検証できるようにする。
/// 既定の選択肢が「いいえ」である点も本物の説明に合わせてある。
pub const BYPASS_NOTICE: &str = "\
WARNING: Claude Code running in Bypass Permissions mode
By proceeding, you accept all responsibility for actions taken without permission checks
❯ 1. No, exit
  2. Yes, I accept";

/// 受諾の選択肢が選ばれたことを示すマーカー。
pub const BYPASS_ACCEPTED_MARKER: &str = "[fake-claude] bypass-accepted";

/// モードの正規値からフッタの語句を引く。
pub fn footer_for(mode: &str) -> &'static str {
    FOOTER_LABELS
        .iter()
        .find(|(value, _)| *value == mode)
        .map(|(_, label)| *label)
        .unwrap_or("⏸ manual mode on")
}

/// `fake-claude` 実行ファイルの場所。
pub fn path() -> PathBuf {
    crate::binary_path("fake-claude")
}
