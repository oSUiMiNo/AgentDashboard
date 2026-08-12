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
/// 画面サイズが変わった（SIGWINCH を受けた）ときのマーカー。`<cols>x<rows>` が続く。
///
/// 本物の claude も SIGWINCH には反応する（再描画で応える）。擬似はテストが読める形で
/// 応える——「PTY のリサイズが子まで届いた」ことを PTY の外から観測する唯一の口になる
/// （PTY のサイズに getter は無く、fake-claude はサイズ依存の描画もしないため）。
pub const RESIZED_PREFIX: &str = "[fake-claude] resized: ";
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
By proceeding, you accept all responsibility for actions taken without permission checks";

/// 責任の受諾の選択肢。**既定は「いいえ」の側**（本物の説明に合わせてある）。
pub const BYPASS_OPTIONS: &[&str] = &["1. No, exit", "2. Yes, I accept"];

/// 選択ダイアログの末尾に本物が出す案内。
///
/// **3種すべてがこれを出す**ことを実測した（v2.1.228。`fixtures/v2.1.228/screens/`）。
/// Enter の側の文言は画面ごとに違う（`confirm` ／ `continue` ／ そもそも出さない）が、
/// `Esc to cancel` だけは共通で、**ブラウザはこれを選択待ちの目印にしている**
/// （ローカルイシュー「送信以外の操作も Ctrl+Enter になっている」設計§4）。
///
/// 擬似 claude が出さないと、あの判定が E2E で一度も踏まれない。
pub const DIALOG_HINT: &str = "Enter to confirm · Esc to cancel";

/// 選択ダイアログを、いま選ばれている位置ごと描く。
///
/// 本物は**方向キーで選択が動き、Enter で確定する**。番号を打つ形しか受け付けないと、
/// ブラウザの Enter が確定として届くことを確かめられない。
pub fn render_dialog(header: &str, options: &[&str], selected: usize) -> String {
    let mut out = String::from(header);
    for (index, option) in options.iter().enumerate() {
        let cursor = if index == selected { "❯" } else { " " };
        out.push('\n');
        out.push_str(cursor);
        out.push(' ');
        out.push_str(option);
    }
    out.push('\n');
    out.push_str(DIALOG_HINT);
    out
}

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

/// `/model <値>` を受け取ったことを示す行頭。
pub const MODEL_SET_PREFIX: &str = "[fake-claude] model-set: ";

/// 注入された `statusLine` を実行し終えたことを示す行頭。
///
/// **出すのは応答契機のときだけ。** `refreshInterval` の周期実行は別スレッドで走るので、
/// そちらから標準出力へ書くと本文と混ざる。周期のほうは「ダッシュボードの
/// `SessionMeta` が更新される」ことで観測する。
pub const STATUS_LINE_SENT_PREFIX: &str = "[fake-claude] statusline-sent: ";

/// 会話が進んだ状態でモデルを変えようとしたときに本物が出す確認画面（設計§11 で実測）。
///
/// 選択肢の番号を読んでから答える、というダッシュボード側の作法を検証するために出す。
/// **既定のカーソルは「はい」の側**という点も本物に合わせてある。
pub const MODEL_SWITCH_NOTICE: &str = "\
Switch model?
This conversation is cached for the current model. Switching means the full history
gets re-read on your next message.";

/// モデル切替の確認の選択肢。**既定は「はい」の側**（本物に合わせてある）。
pub const MODEL_SWITCH_OPTIONS: &[&str] = &["1. Yes, switch", "2. No, go back"];

/// モデルの別名が解決される先（本物の実測。設計§11）。
///
/// `(別名, CLI が名乗るフルID, 表示名)` の3つ組。**日付が付くものと付かないものがある**
/// のも実物どおりで、`id` から版番号を取り出してはいけないことの根拠になっている。
pub const MODEL_RESOLUTIONS: &[(&str, &str, &str)] = &[
    ("default", "claude-sonnet-5", "Sonnet 5"),
    ("best", "claude-fable-5", "Fable 5"),
    ("fable", "claude-fable-5", "Fable 5"),
    ("opus", "claude-opus-5", "Opus 5"),
    ("sonnet", "claude-sonnet-5", "Sonnet 5"),
    ("haiku", "claude-haiku-4-5-20251001", "Haiku 4.5"),
    ("opusplan", "claude-opus-5", "Opus 5"),
    ("opus[1m]", "claude-opus-5", "Opus 5"),
    ("sonnet[1m]", "claude-sonnet-5", "Sonnet 5"),
];

/// 別名を `(フルID, 表示名)` に解決する。
///
/// 表に無い値は**そのまま通す**。本物も知らない別名を受け取りうる（利用者がフルIDを
/// 直に打つ場合など）ので、ここで弾くと擬似のほうが厳しくなってしまう。
pub fn resolve_model(alias: &str) -> (String, String) {
    MODEL_RESOLUTIONS
        .iter()
        .find(|(value, _, _)| *value == alias)
        .map(|(_, id, label)| (id.to_string(), label.to_string()))
        .unwrap_or_else(|| (alias.to_string(), alias.to_string()))
}

/// `fake-claude` 実行ファイルの場所。
pub fn path() -> PathBuf {
    crate::binary_path("fake-claude")
}
