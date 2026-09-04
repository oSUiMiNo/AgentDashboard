use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_branches")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub account_id: Uuid,
    /// **枝の側**の CLI セッション（`protocol::ClaudeSessionId`）。印はこちらに付く。
    #[sea_orm(primary_key, auto_increment = false)]
    pub claude_session_id: Uuid,
    /// **分かれ元**の CLI セッション。呼び戻しの宛先でもある。
    pub branched_from: Uuid,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
