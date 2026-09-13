//! 全体メモの画像を置く表を足す（メモ設計§10-1 の【決着】）。
//!
//! # なぜ記録（DB）へ置くのか
//!
//! **帰属と保管を揃えるためである。** 全体メモは**アカウントに属する**ので、その
//! 画像もアカウントに属する。本文が既にサーバの記録に在るのに画像だけ PC のディスクに
//! 在ると、**別の端末から開いたときに画像だけ欠ける**——要件10 の「別の端末から
//! 開いても、同じ吹き出しが同じ順で出る」に反する。
//!
//! **セッションメモの画像はここへ来ない。** あちらは**その PC の作業に属する**ので、
//! 既存の添付（`<state_dir>/attachments/`）へ相乗りしたままである。**扱いが違うのは
//! 帰属が違うから**であって、要件9（同じ部品・同じ口）は宛先を引数で受ける形のまま
//! 保たれている。
//!
//! # なぜファイルではなく表なのか
//!
//! **サーバにはファイルの置き場が無い。** `ServerConfig` が持つのは `database_url` と
//! `valkey_url` だけで、`state_dir` はセッションホスト側のキーである。**セルフホストの
//! 箱には永続ボリュームが無い構成もありうる**ので、**どの構成でも在る durable な
//! 置き場は記録だけ**である。
//!
//! # 大きさの見当
//!
//! 1枚 8 MiB（`protocol::fs::MAX_BLOB_BYTES`）、合計は `memo_max_bytes`（既定 1 GiB）。
//! **行数ではなくバイト数で抑える**ので、索引は「アカウント＋古い順」の1本でよい
//! ——掃除が古い順に消すため（要件10）。
//!
//! # 作り直し（backfill）が要らない
//!
//! 全体メモに画像を置く道がこれまで無かったので、**記録に残っている画像は1つも無い**。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(MemoBlobs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MemoBlobs::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(MemoBlobs::AccountId).uuid().not_null())
                    // 媒体型。**中身から推測しない**（既存の添付と同じ作法）
                    .col(ColumnDef::new(MemoBlobs::MediaType).string().not_null())
                    // 画像そのもの。SQLite は BLOB、PostgreSQL は BYTEA になる
                    .col(ColumnDef::new(MemoBlobs::Data).binary().not_null())
                    // **バイト数を列で持つ。** 掃除が合計を出すたびに中身を読むと、
                    // 1 GiB を数えるのに 1 GiB 運ぶことになる
                    .col(ColumnDef::new(MemoBlobs::Bytes).big_integer().not_null())
                    .col(
                        ColumnDef::new(MemoBlobs::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_memo_blobs_account")
                            .from(MemoBlobs::Table, MemoBlobs::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // **古い順に消す**（要件10）ので、アカウントで絞ってから時刻で並べる
        manager
            .create_index(
                Index::create()
                    .name("idx_memo_blobs_account_created")
                    .table(MemoBlobs::Table)
                    .col(MemoBlobs::AccountId)
                    .col(MemoBlobs::CreatedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MemoBlobs::Table).to_owned())
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（セルフホスト化設計§3-2 の流儀）。
#[derive(DeriveIden)]
enum MemoBlobs {
    Table,
    Id,
    AccountId,
    MediaType,
    Data,
    Bytes,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
}
