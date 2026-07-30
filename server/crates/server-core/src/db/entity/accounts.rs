//! アカウント（セルフホスト化設計§3-2）。
//!
//! ローカルモードには利用者のアカウントという概念が無いが、**行は1つ必ず置く**
//! （[`crate::db::LOCAL_ACCOUNT_ID`]）。他のテーブルの `account_id` を NULL 許容にすると、
//! §8-6 の「REST 全エンドポイントで `account_id` を WHERE に含める」という enforcement に
//! 「NULL は誰のものでもない」という抜け道ができる。**ローカルも1つのアカウントとして
//! 扱う**ほうが、絞り込みの形が両モードで揃う。

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "accounts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    #[sea_orm(unique)]
    pub name: String,
    /// argon2id のハッシュ（設計§8-2）。
    ///
    /// `None` は**ログインできないアカウント**という意味で、ローカルモードの行がこれにあたる。
    /// 空文字と区別できるようにしてあるのは、フェーズ5 の照合で「ハッシュが無いなら常に拒否」を
    /// 型で判断できるようにするため。
    pub password_hash: Option<String>,
    pub is_admin: bool,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
