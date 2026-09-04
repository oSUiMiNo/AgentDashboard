//! 枝分かれの印を置く表を足す（ブランチ設計§5-2）。
//!
//! # 印が付くのはカードではなく会話
//!
//! カードは乗り換え（`--resume` など）で中身が入れ替わるが、**「この会話はあの会話から
//! 分かれた」は会話そのものの性質**なので、`claude_session_id` を鍵に置く。名前
//! （`session_nicknames`）と同じ理由・同じ形である。
//!
//! # 列名をここで別に書いている理由
//!
//! 既存と同じ流儀。entity を直接指せば短く書けるが、**列名を変えた瞬間に過去の
//! マイグレーションの意味が変わる**。ここは「作った時の形を凍らせた記録」なので、
//! entity とは独立に綴りを持つ。
//!
//! # 作り直し（backfill）が要らない
//!
//! いま枝の印が付くべき会話は**この世に1つも無い**（機能そのものが無かった）ので、
//! 空の表から始めてよい。
//!
//! # `sessions` への外部キーを張らない
//!
//! 印が指すのはカードではなく CLI セッションで、`sessions.claude_session_id` は
//! 一意ではない（乗り換えの履歴で複数のカードが同じセッションを指す）。張れる相手が
//! 無い。帰属は `accounts` への外部キーと、読むときの絞り込みで守る。
//!
//! # 連番が 000008 ではなく 000009 なのは
//!
//! 同じ日に別の作業が 000008 を取っている。**日付が同じでも連番は必ず一意に進める**。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SessionBranches::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(SessionBranches::AccountId).uuid().not_null())
                    // **枝の側**の CLI セッションID。印はこちらに付く
                    .col(
                        ColumnDef::new(SessionBranches::ClaudeSessionId)
                            .uuid()
                            .not_null(),
                    )
                    // **分かれ元**の CLI セッションID。呼び戻しの宛先でもある
                    .col(
                        ColumnDef::new(SessionBranches::BranchedFrom)
                            .uuid()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SessionBranches::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    // **印はアカウントに属する。** `claude_session_id` だけを主キーに
                    // すると、同じセッションを別のアカウントが見たときに印を共有する
                    .primary_key(
                        Index::create()
                            .col(SessionBranches::AccountId)
                            .col(SessionBranches::ClaudeSessionId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_session_branches_account")
                            .from(SessionBranches::Table, SessionBranches::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SessionBranches::Table).to_owned())
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（セルフホスト化設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum SessionBranches {
    Table,
    AccountId,
    ClaudeSessionId,
    BranchedFrom,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}
