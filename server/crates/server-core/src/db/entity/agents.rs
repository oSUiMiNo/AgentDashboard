//! 登録済みの PC（セルフホスト化設計§3-2）。
//!
//! # 「接続中か」を持たない
//!
//! 接続はインスタンスローカルの事実で、DB に書くと**落ちた瞬間の値が残る**。複数
//! インスタンスをまたぐ生死は視聴リース（設計§9-4）で表し、ブラウザへは
//! `SessionMeta::agent_connected` として都度かぶせる。
//!
//! `model_table` を列に分解しないのは `sessions.status` と同じ理由——表の形が変わっても
//! スキーマ変更を起こさないため（設計§13-4）。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agents")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub account_id: Uuid,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    /// モデル表（正式名⇔通称・別名の実測解決先）。**フェーズ3 で中身が入る。**
    pub model_table: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
