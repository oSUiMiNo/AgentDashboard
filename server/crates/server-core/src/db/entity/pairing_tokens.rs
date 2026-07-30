//! ペアリングトークン（セルフホスト化設計§8-4）。
//!
//! 平文は発行時に1回だけ表示し、DB には SHA-256 のハッシュだけを置く。低速ハッシュに
//! しないのは、トークンが 256bit 乱数で辞書攻撃が成立しないためと、接続のたびに
//! ハッシュ一致で引く必要があるため（設計§3-2）。
//!
//! **発行と失効の UI はフェーズ5。** ここは置き場所だけを先に作る。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "pairing_tokens")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub account_id: Uuid,
    #[sea_orm(unique)]
    pub token_hash: String,
    pub label: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    /// 失効した時刻。`None` なら有効。
    pub revoked_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
