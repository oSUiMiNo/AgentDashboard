//! アプリ全体の知らせの表を足す（トーストとベル設計§4-1・§4-4）。
//!
//! # 列名をここで別に書いている理由
//!
//! 既存7本と同じ流儀。entity を直接指せば短く書けるが、**列名を変えた瞬間に過去の
//! マイグレーションの意味が変わる**。ここは「作った時の形を凍らせた記録」なので、
//! entity とは独立に綴りを持つ。
//!
//! # 作り直し（backfill）が要らない
//!
//! いま記録に残っている知らせは**この世に1つも無い**（画面に出て消えるだけだった）
//! ので、空の表から始めてよい。
//!
//! # 索引を2本張る
//!
//! ベルの一覧は「そのアカウントのぶんを新しい順」、未読バッジは「そのアカウントの
//! 未読を数える」。**どちらも `account_id` で絞ってから**なので、先頭列を揃えた
//! 複合索引にする（`idx_sessions_account_archived` と同じ形）。
//!
//! # `card_id` に外部キーを張らない
//!
//! 知らせはカードの生死と関わりなく残ってよい。カードは論理削除で行が残るので
//! 技術的には張れるが、**張ると「カードを物理削除したら知らせも道連れ」になる**。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Notices::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Notices::Id).uuid().not_null().primary_key())
                    .col(ColumnDef::new(Notices::AccountId).uuid().not_null())
                    // **いまは常に NULL。** 将来カードを名指しする知らせの受け皿
                    .col(ColumnDef::new(Notices::CardId).uuid().null())
                    .col(ColumnDef::new(Notices::Source).string().not_null())
                    .col(ColumnDef::new(Notices::Kind).string().not_null())
                    .col(ColumnDef::new(Notices::Message).string().not_null())
                    .col(ColumnDef::new(Notices::CreatedAt).big_integer().not_null())
                    // **空なら未読**（設計§4-1）
                    .col(ColumnDef::new(Notices::ReadAt).big_integer().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_notices_account")
                            .from(Notices::Table, Notices::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // ベルの一覧（新しい順）
        manager
            .create_index(
                Index::create()
                    .name("idx_notices_account_created")
                    .table(Notices::Table)
                    .col(Notices::AccountId)
                    .col(Notices::CreatedAt)
                    .to_owned(),
            )
            .await?;

        // 未読の数え上げ
        manager
            .create_index(
                Index::create()
                    .name("idx_notices_account_read")
                    .table(Notices::Table)
                    .col(Notices::AccountId)
                    .col(Notices::ReadAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Notices::Table).to_owned())
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（セルフホスト化設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum Notices {
    Table,
    Id,
    AccountId,
    CardId,
    Source,
    Kind,
    Message,
    CreatedAt,
    ReadAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}
