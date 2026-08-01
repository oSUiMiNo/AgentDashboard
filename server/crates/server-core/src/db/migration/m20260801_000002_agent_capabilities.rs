//! PC が名乗った「できること」を残す列を足す（セルフホスト化設計§13-4・§9-2）。
//!
//! # なぜ列が要るのか
//!
//! 受け付ける権限モードと起動ボタンのトグルは、PC が名乗り（Hello）で寄越すもので、
//! これまで**接続を持っているインスタンスのメモリにしか無かった**。インスタンスが
//! 1台のうちはそれで足りたが、2台並べるとブラウザが繋がった側に PC が居ないことがあり、
//! そのとき起動ボタンの選択肢が空になる。
//!
//! # なぜ列に分解しないのか
//!
//! `sessions.status` や `agents.model_table` と同じ理由——**名乗る中身が増えても
//! スキーマ変更を起こさない**ため（設計§13-4）。ここに入るのは「その PC の CLI が
//! 何をできるか」で、CLI の版が上がれば増える性質のものになる。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Agents::Table)
                    // 名乗る前の PC もあるので NULL を許す。**空の表と「まだ名乗って
                    // いない」を区別する**ために、既定値も入れない
                    .add_column(ColumnDef::new(Agents::Capabilities).json().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Agents::Table)
                    .drop_column(Agents::Capabilities)
                    .to_owned(),
            )
            .await
    }
}

/// 表と列の名前。**エンティティとは別に書く**（設計§3-2 の流儀）。
///
/// 当時の形をここで凍らせるためで、エンティティを後から直してもこのファイルは動かない。
#[derive(DeriveIden)]
enum Agents {
    Table,
    Capabilities,
}
