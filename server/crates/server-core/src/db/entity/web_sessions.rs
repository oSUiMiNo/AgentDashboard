//! ブラウザのログインセッション（セルフホスト化設計§8-2）。
//!
//! `tower-sessions` の [`SessionStore`] が読み書きする置き場所。実装は
//! [`crate::db::web_session_store`]。**ログインへの結線はフェーズ5**で、ここは表と
//! ストアだけを先に作る。
//!
//! [`SessionStore`]: tower_sessions::SessionStore

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "web_sessions")]
pub struct Model {
    /// `tower_sessions::session::Id`（128bit）の10進表記。
    ///
    /// 整数のまま置かないのは、**符号付き128bit を素で持てる DB が無い**ため。
    /// 文字列にしておけば SQLite と PostgreSQL で同じ形になる。
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    /// セッションの中身（rmp-serde で直列化済み）。中身の形は tower-sessions の都合。
    pub data: Vec<u8>,
    /// 失効時刻（UNIX 秒）。掃除ジョブがこれを見て消す。
    pub expiry_date: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
