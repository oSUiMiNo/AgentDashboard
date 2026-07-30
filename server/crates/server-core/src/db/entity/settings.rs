//! ダッシュボードから編集する設定（セルフホスト化設計§13-3）。
//!
//! 線引きは「**接続と機械に属するものはファイル（toml）、利用体験に属するものは DB**」
//! （§13-1）。`always_bypass_permissions` だけは現行どおり toml に残る——書き戻す相手が
//! 利用者の `config.toml` そのものだからで、DB へ移すと「設定ファイルを書き換えた覚えが
//! あるのに画面と食い違う」が起きる。
//!
//! # スコープを NULL で表さない
//!
//! 設計§3-2 は主キーを `(account_id nullable, key)` としているが、**PostgreSQL は主キーに
//! NULL を許さない**。ユニーク索引へ逃がしても NULL 同士は互いに別物と扱われ、同じキーが
//! 二重に入る。そこで `account_id` は非 NULL のままにし、サーバ全体スコープを
//! [`crate::db::SERVER_SCOPE_ID`]（nil UUID）で表す。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "settings")]
pub struct Model {
    /// アカウントスコープならそのID、サーバ全体なら [`crate::db::SERVER_SCOPE_ID`]。
    #[sea_orm(primary_key, auto_increment = false)]
    pub account_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub key: String,
    pub value: Json,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
