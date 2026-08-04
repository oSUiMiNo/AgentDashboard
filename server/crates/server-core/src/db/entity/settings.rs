//! ダッシュボードから編集する設定（セルフホスト化設計§13-3）。
//!
//! 線引きは「**接続と機械に属するものはファイル（toml）、利用体験に属するものは DB**」
//! （§13-1）。**設定画面の4項目はすべてこちら**にある。
//!
//! `always_bypass_permissions` は当初 toml に残していたが、**同じ画面に並ぶ1項目だけ
//! 保存先が違うと、セルフホスト構成では画面から触れない**（書き戻す相手が利用者の PC の
//! ファイルで、サーバから手が届かない）。持ち出し設計§1〜§3 でこちらへ寄せた。
//! toml のキーは消していない——**行が無いときの初期値**として読み続ける。
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
