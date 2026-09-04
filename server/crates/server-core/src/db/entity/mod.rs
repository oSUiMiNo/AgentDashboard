//! DB のテーブル定義（セルフホスト化設計§3-2）。
//!
//! **表がそのままこのモジュールの一覧**になっている。表を増やしたら
//! [`super::migration`] にも足すこと——entity だけ足しても CREATE TABLE は走らない。
//!
//! 時刻はすべて `i64` の epoch ミリ秒で持つ（`protocol::Timestamp` と同じ）。DB の
//! 日時型を使わないのは、SQLite と PostgreSQL で保存形と時差の扱いが揃わないため。

pub mod accounts;
pub mod agents;
pub mod notices;
pub mod pairing_tokens;
pub mod projects;
pub mod session_branches;
pub mod session_nicknames;
pub mod sessions;
pub mod settings;
pub mod transcript_nodes;
pub mod web_sessions;
