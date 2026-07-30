//! セッションカードの記録（セルフホスト化設計§3-2）。
//!
//! `protocol::SessionMeta` の永続形。往復は [`crate::db::session_row`] が受け持つ。
//!
//! # `status` を列に分解しない
//!
//! `SessionStatus` はタグ付き列挙で、`Ended { ok }` のように値を持つ枝がある。列へ
//! 展開すると**列挙が1つ増えるたびにスキーマ変更**になる。JSON のまま置けば、増えても
//! 表は動かない（`transcript_nodes.payload` と同じ判断）。
//!
//! # `model_requested`（切替中という一時状態）も保存する
//!
//! 同期の単位を `SessionUpsert` 丸ごとにするため（設計§3-2 の論点表）。DB の境界で
//! フィールドを間引くと「どれが一時状態か」を知る第2の場所が生まれる。切断中に
//! 「切替要求中」という最後の既知状態が見えるのは §6-3 の哲学と同型で、再接続後の
//! 最初の `SessionUpsert` が自己修正する。
//!
//! # `agent_connected` は列に無い
//!
//! 保存すると落ちた瞬間の値が残る。読み出すときに「いま生きているか」でかぶせる
//! （[`agents`] の「接続中か」を持たない理由と同じ）。
//!
//! [`agents`]: super::agents

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub card_id: Uuid,
    /// どの PC のセッションか。**ローカルモードは `None`**（設計§3-1）。
    pub agent_id: Option<Uuid>,
    pub account_id: Uuid,
    pub project: String,
    pub claude_session_id: Option<Uuid>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub model_requested: Option<String>,
    pub status: Json,
    pub subagent_active: i32,
    pub last_activity_at: i64,
    pub last_assistant_message: Option<String>,
    pub created_at: i64,
    /// フックを1件でも受け取ったか。
    ///
    /// 設計§3-2 の表には無いが、`SessionMeta` のフィールドなので**保存しないと往復しない**。
    /// 「状態が不明なのはフックが来ていないからだ」という説明が再起動で消える。
    pub hooks_seen: bool,
    /// 一覧から外したか。行そのものは消さない（履歴を残すため）。
    pub archived: bool,
    /// `.agent-dashboard.toml` がこのセッションについて名乗ったアカウント名（設計§8-5）。
    ///
    /// **権限の源はペアリングトークン**なので、これは申告であって権限ではない。
    /// 判定はフェーズ5。
    pub toml_account: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
