//! 利用者が付けた名前の表を足す（名前付け設計§4-1・§4-3）。
//!
//! # 列名をここで別に書いている理由
//!
//! 既存6本と同じ流儀。entity を直接指せば短く書けるが、**列名を変えた瞬間に過去の
//! マイグレーションの意味が変わる**。ここは「作った時の形を凍らせた記録」なので、
//! entity とは独立に綴りを持つ。
//!
//! # 作り直し（backfill）が要らない
//!
//! いま利用者が付けた名前は**この世に1つも無い**（機能そのものが無かった）ので、
//! 空の表から始めてよい。`projects` の表を足したときは、既に画面へ出ている枠が
//! 記録に無いという食い違いがあったが、こちらにはそれが無い。
//!
//! # `sessions` への外部キーを張らない
//!
//! 名前が指すのはカードではなく CLI セッションで、`sessions.claude_session_id` は
//! 一意ではない（乗り換えの履歴で複数のカードが同じセッションを指す）。張れる相手が
//! 無い。帰属は `accounts` への外部キーと、読むときの絞り込みで守る。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SessionNicknames::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SessionNicknames::AccountId)
                            .uuid()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionNicknames::ClaudeSessionId)
                            .uuid()
                            .not_null(),
                    )
                    // **空文字は入らない。** 消すときは行ごと消す（設計§10「空は消すと同義」）
                    .col(
                        ColumnDef::new(SessionNicknames::Nickname)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionNicknames::UpdatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    // **名前はアカウントに属する。** `claude_session_id` だけを主キーに
                    // すると、同じセッションを別のアカウントが見たときに名前を共有する
                    .primary_key(
                        Index::create()
                            .col(SessionNicknames::AccountId)
                            .col(SessionNicknames::ClaudeSessionId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_session_nicknames_account")
                            .from(SessionNicknames::Table, SessionNicknames::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SessionNicknames::Table).to_owned())
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（セルフホスト化設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum SessionNicknames {
    Table,
    AccountId,
    ClaudeSessionId,
    Nickname,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}
