//! セッションカードに「`--resume` で頼んだ会話のID」（`resumed_from`）の列を足す。
//!
//! # なぜ列が要るのか
//!
//! `claude_session_id` は**いま動いている会話**で、フックが名乗るたびに張り替わる。
//! **張り替え自体は正しい**——動いている会話が変わったのだから、そう書くのが本当である。
//!
//! **間違っていたのは、張り替えた結果、頼んだIDがどこにも残らなくなることだった。**
//! 呼び戻しの一覧は行の `claude_session_id` を引くので、**元の会話のIDを持つ行が
//! 1つも無くなると、その会話は一覧から消える。** 記録にも残らないので二度と戻せない。
//!
//! **とくに復旧（`revive`）で悪い。** あちらは新しいカードを採番せず既にあるカードを
//! 使い回すため、上書きされるのが**その会話が持つ唯一の行**になる——つまり
//! **「復旧ボタンを押した結果、復旧しようとしていた会話が一覧から消える」**。
//!
//! 実測（2026-09-10）：`sessions` 194行のうち **22行（11%）**が、実体の無い会話を
//! 指す状態で残っていた。
//!
//! # 既定値を入れない
//!
//! `NULL` は「引き継ぎで始めていない」を表す。新規セッション（`SessionStart::Fresh`）は
//! 必ずこの状態で、**空文字や自分自身のIDで埋めると「頼んでいない」と「自分を頼んだ」が
//! 区別できなくなる。** 既存の行も `NULL` のままでよい——**遡って埋め直すことはできない**
//! （何を頼んだかは、起こした時点にしか存在しない情報である）。
//!
//! **したがって、この migration より前に壊れた行は救えない。** 既知のものを救うのは
//! 一覧側の迂回（`registry::past_sessions`）の仕事で、こちらは再発を止める側である。

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
                    // 引き継ぎで始めていないカードがあるので NULL を許す。
                    // **既定値も入れない**（上記「既定値を入れない」）
                    .add_column(ColumnDef::new(Sessions::ResumedFrom).uuid().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Sessions::Table)
                    .drop_column(Sessions::ResumedFrom)
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
    ResumedFrom,
}
