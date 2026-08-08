//! ブラウザで起きたことを運ぶ型（設計§12）。
//!
//! # なぜ `ws` の中に置かないのか
//!
//! ブラウザ → サーバは **REST**（`POST /api/client-logs`）で、[`crate::ws`] の
//! WebSocket メッセージではない。あちらへ足すと Rust と TypeScript の4箇所同期
//! （ガイドライン「サーバ⇔ブラウザのメッセージを増減するとき」）が要ることになるが、
//! この口は**何も返さない**ので往復の型を揃える相手が居ない。[`crate::fs`] が
//! 「2つの線を流れるから片方のモジュールへ置かない」と書いているのと同じ整理である。
//!
//! # 上限は型と同じ場所に置く
//!
//! 守るのはサーバだが、**上限に合わせて送る形を決めるのはブラウザ**なので、値の綴りが
//! 2箇所に散りやすい。ここに1つだけ置いて全員が引く（設計§23-5 で決めた値）。
//!
//! # 自由文字列にしてよい欄と、してはいけない欄
//!
//! `level` と `kind` を列挙にしてあるのは、**`level` がログ1行の必須7欄**だからである
//! （設計§2-1）。文字列のまま通すと、外から `level` に何でも書ける口になる。本文
//! （`msg` / `stack`）は自由文字列でよい——あれは読む人のためのもので、絞り込みの鍵に
//! しない。

use serde::{Deserialize, Serialize};

/// 1件の大きさの上限（設計§23-5）。
///
/// スタックは1フレーム 100〜200 バイトで既定10フレーム＝2 KiB 前後。長い本文を足しても
/// 収まり、1リクエストに8件は入る。**超えたぶんは切って、切ったことを欄に残す**
/// （[`ClientLogEntry::truncated`]）。
pub const MAX_ENTRY_BYTES: usize = 8 * 1024;

/// 1リクエストの件数の上限（設計§23-5）。
///
/// **大きさと重ねて掛ける**（[`crate::fs::MAX_ENTRIES`] と [`crate::fs::MAX_LISTING_BYTES`]
/// の型紙）。件数だけでは、本文が極端に長い相手を縛れない。
pub const MAX_BATCH_ENTRIES: usize = 32;

/// 1リクエストの合計の上限（設計§23-5）。
///
/// 天井は `sendBeacon` の 64 KiB（ブラウザ側の固い制約）で、JSON の包みのぶんを引いてある。
pub const MAX_BATCH_BYTES: usize = 56 * 1024;

/// 1分あたりに受け取る件数の上限（設計§23-5）。
///
/// ブラウザは1秒ぶんをまとめて送る（設計§12-2）ので、まともな動作なら毎分60件。倍を
/// 上限にする。**超えたら捨て、捨てた件数を残す**。
pub const MAX_PER_MINUTE: u32 = 120;

/// 未認証ぶんの1日の合計の上限（設計§23-5）。
///
/// 無認証で書ける口なのでいちばん厳しく。`log_max_bytes`（512 MiB）の 1/64 で、1件平均
/// 500 バイトなら1日 16,000 件。ログイン画面のエラーとしては十分。
pub const MAX_ANON_DAILY_BYTES: u64 = 8 * 1024 * 1024;

/// 1件あたりの、本文以外の目安バイト数。
///
/// 大きさを測るのに毎回 JSON へ書き出すのは無駄なので、本文の長さに定数を足して見積もる
/// （`hostfs` の `ENTRY_OVERHEAD_BYTES` と同じ手口）。
pub const ENTRY_OVERHEAD_BYTES: usize = 128;

/// 届かなかった件数（設計§12-2・§12-4）。
///
/// **2つの意味を混ぜない。** 送れなかったのか断られたのかで、次に見る場所が変わる
/// （前者はブラウザの中、後者はサーバの門）。1つの数にまとめると、`agentdashboard logs`
/// から見たときに「ブラウザが重い」と読み違える。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ClientLogDrops {
    /// ブラウザ側で送れずに捨てた件数。
    pub browser: u32,
    /// サーバが頻度・大きさの上限で断った件数。
    pub refused: u32,
}

impl ClientLogDrops {
    pub fn is_empty(self) -> bool {
        self.browser == 0 && self.refused == 0
    }
}

/// 1回の送信（設計§12-2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientLogBatch {
    pub entries: Vec<ClientLogEntry>,
    /// ブラウザ側で**送れずに捨てた**件数（前回の送信以降）。
    ///
    /// 送信の失敗そのものはログにしない（拾うと輪ができる。設計§12-1）ので、
    /// 代わりに件数だけを次の便へ載せる。**黙って減らさない**のがこのイシューの約束。
    #[serde(default)]
    pub dropped: u32,
}

/// ブラウザで起きたこと1件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientLogEntry {
    /// ブラウザ側の時刻（RFC3339）。**受け取った側で形を正規化する**——
    /// `agentdashboard logs --since` は文字列比較なので、形が揃っていないと絞り込みが壊れる
    pub ts: String,
    pub level: ClientLogLevel,
    pub kind: ClientLogKind,
    pub msg: String,
    /// そのとき開いていた画面。`/s/<card_id>` などの**アプリ内のパス**だけを入れる
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 関わっているセッション。**送る側は `card_id` まで**で、`agent_id` への
    /// 結び付けは受ける側の仕事（設計§12-5）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    /// どの PC のセッションか。**受け取った側が `card_id` から引いて入れる**（設計§12-5）。
    ///
    /// ブラウザが名乗ってきても信じない——**封筒の中身ではなく、こちらが引いた値を正とする**
    /// （セルフホスト化設計§9 の「持ち主は名前で決める。中身を信じない」と同じ理屈）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// 上限で切ったか。**隠さない**（[`crate::fs::DirListing::truncated`] と同じ扱い）。
    ///
    /// **どちらが切っても立つ。** ブラウザは線に載せる量を減らすために先に切るが、
    /// そこで上限ぴったりに収めてしまうと、受け取った側の [`ClientLogEntry::clamp`] は
    /// 何もしないので**切った事実がどこにも残らない**。だから送る側も立てる。
    /// 受け取った側は**下げない**——立っているものを倒す経路を作らない。
    #[serde(default)]
    pub truncated: bool,
}

impl ClientLogEntry {
    /// この1件の大きさの見積もり。
    pub fn size_bytes(&self) -> usize {
        self.msg.len()
            + self.stack.as_deref().map_or(0, str::len)
            + self.url.as_deref().map_or(0, str::len)
            + self.card_id.as_deref().map_or(0, str::len)
            + self.agent_id.as_deref().map_or(0, str::len)
            + self.ts.len()
            + ENTRY_OVERHEAD_BYTES
    }

    /// [`MAX_ENTRY_BYTES`] に収まるまで切る。切ったら [`Self::truncated`] を立てる。
    ///
    /// **スタックから先に落とす。** 本文は「何が起きたか」で、スタックは「どこで」なので、
    /// 1行しか残らないときに残すべきは前者である。
    pub fn clamp(&mut self) {
        if self.size_bytes() <= MAX_ENTRY_BYTES {
            return;
        }
        self.truncated = true;

        // スタックを削って収まるか
        let without_stack = self.size_bytes() - self.stack.as_deref().map_or(0, str::len);
        if without_stack <= MAX_ENTRY_BYTES {
            if let Some(stack) = &mut self.stack {
                cut_to(stack, MAX_ENTRY_BYTES - without_stack);
            }
            return;
        }
        self.stack = None;

        // それでも溢れるなら本文を切る
        let without_msg = self.size_bytes() - self.msg.len();
        let budget = MAX_ENTRY_BYTES.saturating_sub(without_msg);
        cut_to(&mut self.msg, budget);
    }
}

/// 本文を `budget` バイト以内へ切る。
///
/// **`&text[..budget]` と書いてはいけない。** 本文は日本語で1文字3バイトなので、
/// バイト添字は文字境界で panic する（ガイドライン「ソースに制御文字を混ぜない」と
/// 同じ系統の罠で、`logging.rs` の `head_of` が同じ理由で `chars()` を使っている）。
fn cut_to(text: &mut String, budget: usize) {
    if text.len() <= budget {
        return;
    }
    let mut end = 0;
    for (at, ch) in text.char_indices() {
        if at + ch.len_utf8() > budget {
            break;
        }
        end = at + ch.len_utf8();
    }
    text.truncate(end);
}

/// 行の重さ。**ログ1行の `level` 欄になる**ので、綴りは大文字で固定する（設計§2-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ClientLogLevel {
    Error,
    Warn,
    Info,
}

impl ClientLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientLogLevel::Error => "ERROR",
            ClientLogLevel::Warn => "WARN",
            ClientLogLevel::Info => "INFO",
        }
    }
}

/// 何が拾ったか（設計§12-1）。
///
/// **`console.*` は入らない。** 拾うと、送信の失敗を拾って送信して失敗する輪ができる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientLogKind {
    /// `window.onerror`
    Unhandled,
    /// `unhandledrejection`
    Rejection,
    /// React の `onUncaughtError`
    ReactUncaught,
    /// React の `onCaughtError`
    ReactCaught,
    /// React の `onRecoverableError`
    ReactRecoverable,
    /// WebSocket の `onerror`
    WsError,
    /// WebSocket の `onclose`
    WsClose,
}

impl ClientLogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientLogKind::Unhandled => "unhandled",
            ClientLogKind::Rejection => "rejection",
            ClientLogKind::ReactUncaught => "react_uncaught",
            ClientLogKind::ReactCaught => "react_caught",
            ClientLogKind::ReactRecoverable => "react_recoverable",
            ClientLogKind::WsError => "ws_error",
            ClientLogKind::WsClose => "ws_close",
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn 一件(msg: &str) -> ClientLogEntry {
        ClientLogEntry {
            ts: "2026-08-08T00:00:00.000Z".to_string(),
            level: ClientLogLevel::Error,
            kind: ClientLogKind::Unhandled,
            msg: msg.to_string(),
            url: None,
            card_id: None,
            agent_id: None,
            stack: None,
            truncated: false,
        }
    }

    #[test]
    fn 上限は設計で決めた値のまま() {
        // 設計§23-5 と食い違ったら、どちらかが嘘になっている
        assert_eq!(MAX_ENTRY_BYTES, 8_192);
        assert_eq!(MAX_BATCH_ENTRIES, 32);
        assert_eq!(MAX_BATCH_BYTES, 57_344);
        assert_eq!(MAX_PER_MINUTE, 120);
        assert_eq!(MAX_ANON_DAILY_BYTES, 8_388_608);
    }

    #[test]
    fn 重さと種別は線の上の綴りで固定される() {
        // ブラウザ側（TypeScript）が同じ綴りで読む
        assert_eq!(
            serde_json::to_string(&ClientLogLevel::Error).unwrap(),
            r#""ERROR""#
        );
        assert_eq!(
            serde_json::to_string(&ClientLogKind::ReactUncaught).unwrap(),
            r#""react_uncaught""#
        );
    }

    #[test]
    fn 切らずに済むものは切らない() {
        let mut entry = 一件("短い");
        entry.clamp();
        assert!(!entry.truncated);
        assert_eq!(entry.msg, "短い");
    }

    #[test]
    fn 先に落とすのはスタックのほう() {
        let mut entry = 一件("本文");
        entry.stack = Some("x".repeat(MAX_ENTRY_BYTES * 2));
        entry.clamp();

        assert!(entry.truncated, "切ったことが残ること");
        assert_eq!(entry.msg, "本文", "本文は残ること");
        assert!(entry.size_bytes() <= MAX_ENTRY_BYTES);
    }

    #[test]
    fn 日本語の本文を切っても文字の途中で割れない() {
        // バイト添字で切ると panic する。**この検査が無いと、長い日本語の
        // エラーが来た瞬間にサーバが落ちる**
        let mut entry = 一件(&"あ".repeat(MAX_ENTRY_BYTES));
        entry.clamp();

        assert!(entry.truncated);
        assert!(entry.size_bytes() <= MAX_ENTRY_BYTES);
        assert!(
            entry.msg.chars().all(|ch| ch == 'あ'),
            "文字の途中で割れていないこと: {:?}",
            entry.msg
        );
    }

    #[test]
    fn 立っている印は受け取った側で倒れない() {
        // ブラウザが上限ぴったりに切ってきた場合、`clamp` は何もしない。
        // **それでも印は残ること**——倒す経路があると、切った事実が消える
        let mut entry = 一件("収まっている");
        entry.truncated = true;
        entry.clamp();
        assert!(entry.truncated);
    }

    #[test]
    fn 名乗りが無ければ切られていない扱い() {
        let batch: ClientLogBatch = serde_json::from_str(
            r#"{"entries":[{"ts":"2026-08-08T00:00:00.000Z","level":"ERROR","kind":"ws_close","msg":"切れました"}]}"#,
        )
        .expect("読めること");
        assert_eq!(batch.dropped, 0);
        assert!(!batch.entries[0].truncated);
        assert_eq!(batch.entries[0].card_id, None);
    }
}
