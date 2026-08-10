//! ペアリングトークンに用途（`kind`）の列を足す（CLI設計§5-3）。
//!
//! # なぜ列が要るのか
//!
//! これまで札は PC（セッションホスト）を繋ぐためだけのものだった。CLI も同じ札の
//! 仕組みで通すことにしたが、**同じ行のままにすると2つの困りごとが出る**——
//! アカウント画面に「繋いでこない PC」（CLI 用の札）が並び続けることと、
//! 片方の札が漏れたときに両方の口が開くこと。用途を行に書き、口ごとに照合で課す。
//!
//! # 既定値が既存行の埋めを兼ねる
//!
//! この migration より前に発行された札はすべて PC 用なので、`DEFAULT 'agent'` で
//! 足せば既存行がそのまま正しい値になる。バックフィルの UPDATE は要らない。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PairingTokens::Table)
                    .add_column(
                        ColumnDef::new(PairingTokens::Kind)
                            .string()
                            .not_null()
                            .default("agent"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PairingTokens::Table)
                    .drop_column(PairingTokens::Kind)
                    .to_owned(),
            )
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（設計§3-2 の流儀）。
///
/// 当時の形をここで凍らせるためで、エンティティを後から直してもこのファイルは動かない。
#[derive(DeriveIden)]
enum PairingTokens {
    Table,
    Kind,
}
