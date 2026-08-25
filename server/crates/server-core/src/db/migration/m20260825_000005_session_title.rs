//! セッションカードに名前（`session_title`）の列を足す（カード設計§6-2）。
//!
//! # なぜ列が要るのか
//!
//! 名前は CLI が履歴へ1行書くだけのもので（`{"type":"ai-title","aiTitle":"…"}`）、
//! パーサがそれを拾って報告する。**記録に持たないと、サーバを起こし直した瞬間に
//! カードの名前が全部消える**——行はもう追記されないので、二度と戻らない。
//!
//! # 既定値を入れない
//!
//! `NULL` は「まだ付いていない」を表す。名前は最初のターンのあとに付くので、
//! **起こした直後は必ずこの状態を通る**。空文字を既定にすると「付いていない」と
//! 「空の名前が付いた」が区別できなくなり、空で上書きしない規則（§6-1）が
//! 判定できなくなる。既存の行も `NULL` のままでよく、埋め直しは要らない。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Sessions::Table)
                    // 名前がまだ無いカードがあるので NULL を許す。**「付いていない」と
                    // 「空が付いた」を区別する**ために、既定値も入れない
                    .add_column(ColumnDef::new(Sessions::SessionTitle).string().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Sessions::Table)
                    .drop_column(Sessions::SessionTitle)
                    .to_owned(),
            )
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（設計§3-2 の流儀）。
///
/// 当時の形をここで凍らせるためで、エンティティを後から直してもこのファイルは動かない。
#[derive(DeriveIden)]
enum Sessions {
    Table,
    SessionTitle,
}
