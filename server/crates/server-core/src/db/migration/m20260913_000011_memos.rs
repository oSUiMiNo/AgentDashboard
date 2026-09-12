//! メモの表を足す（メモ設計§3）。
//!
//! # 列名をここで別に書いている理由
//!
//! 既存10本と同じ流儀。entity を直接指せば短く書けるが、**列名を変えた瞬間に過去の
//! マイグレーションの意味が変わる**。ここは「作った時の形を凍らせた記録」なので、
//! entity とは独立に綴りを持つ。
//!
//! # 作り直し（backfill）が要らない
//!
//! メモという機能がこれまで無かったので、**記録に残っているメモはこの世に1つも無い**。
//! 空の表から始めてよい。
//!
//! # 索引を2本張る
//!
//! 並びが2段ある（メモ設計§7-1）——上段はチェック済みを `checked_at` の順、下段は
//! 未チェックを `noted_at` の順。**どちらも「アカウント＋宛先」で絞ってから並べる**ので、
//! 先頭列を揃えた複合索引を段ごとに1本ずつ立てる。1本にすると片方が全走査になる。
//! `notices` が `(account_id, created_at)` と `(account_id, read_at)` の2本を張って
//! いるのと同じ理由。
//!
//! # `sessions` へ外部キーを張らない
//!
//! `sessions.claude_session_id` は**一意ではない**（乗り換えの履歴で複数のカードが同じ
//! CLI セッションを指しうる）ので、参照先が1行に定まらず**張れない**。`session_nicknames`
//! が同じ理由で張っていない。
//!
//! **結果としてカードを消してもメモが残るのは、意図した振る舞いである**——要件15 が
//! 「終了したカード・抜け殻のカードでこそ読みたい」と定めている。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Memos::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Memos::Id).uuid().not_null().primary_key())
                    .col(ColumnDef::new(Memos::AccountId).uuid().not_null())
                    // `"global"` か `"session"`
                    .col(ColumnDef::new(Memos::TargetKind).string().not_null())
                    // **`"session"` のときだけ入る**
                    .col(ColumnDef::new(Memos::TargetSessionId).uuid().null())
                    // ブロックエディタの構造を丸ごと（設計§3-3）
                    .col(ColumnDef::new(Memos::Body).json().not_null())
                    .col(ColumnDef::new(Memos::NotedAt).big_integer().not_null())
                    // **空ならチェックなし**（設計§3-2）
                    .col(ColumnDef::new(Memos::CheckedAt).big_integer().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_memos_account")
                            .from(Memos::Table, Memos::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // 上段：チェック済みを、チェックした時刻の順に
        manager
            .create_index(
                Index::create()
                    .name("idx_memos_target_checked")
                    .table(Memos::Table)
                    .col(Memos::AccountId)
                    .col(Memos::TargetKind)
                    .col(Memos::TargetSessionId)
                    .col(Memos::CheckedAt)
                    .to_owned(),
            )
            .await?;

        // 下段：未チェックを、メモの時刻の順に
        manager
            .create_index(
                Index::create()
                    .name("idx_memos_target_noted")
                    .table(Memos::Table)
                    .col(Memos::AccountId)
                    .col(Memos::TargetKind)
                    .col(Memos::TargetSessionId)
                    .col(Memos::NotedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Memos::Table).to_owned())
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（セルフホスト化設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum Memos {
    Table,
    Id,
    AccountId,
    TargetKind,
    TargetSessionId,
    Body,
    NotedAt,
    CheckedAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}
