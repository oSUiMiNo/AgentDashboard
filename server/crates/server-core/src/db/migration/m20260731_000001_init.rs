//! 最初のスキーマ（セルフホスト化設計§3-2 の7表）。
//!
//! # 列名をここで別に書いている理由
//!
//! entity（[`crate::db::entity`]）を直接指せば同じ表を短く書けるが、**列名を変えた瞬間に
//! 過去のマイグレーションの意味が変わる**。「作った時の形」を固定できなくなり、
//! 既に流した環境と、これから流す環境で結果が食い違う。マイグレーションは
//! **その時点の形を凍らせた記録**なので、entity とは独立に綴りを持つ。
//!
//! 表を増やす・列を足すときは、このファイルを直さず**新しいマイグレーションを足す**こと。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Accounts::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Accounts::Id).uuid().not_null().primary_key())
                    .col(
                        ColumnDef::new(Accounts::Name)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    // ローカルモードの行はハッシュを持たない（＝ログインできない）
                    .col(ColumnDef::new(Accounts::PasswordHash).string().null())
                    .col(ColumnDef::new(Accounts::IsAdmin).boolean().not_null())
                    .col(ColumnDef::new(Accounts::CreatedAt).big_integer().not_null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PairingTokens::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PairingTokens::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(PairingTokens::AccountId).uuid().not_null())
                    .col(
                        ColumnDef::new(PairingTokens::TokenHash)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(PairingTokens::Label).string().not_null())
                    .col(
                        ColumnDef::new(PairingTokens::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PairingTokens::LastUsedAt)
                            .big_integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PairingTokens::RevokedAt)
                            .big_integer()
                            .null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_pairing_tokens_account")
                            .from(PairingTokens::Table, PairingTokens::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Agents::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Agents::Id).uuid().not_null().primary_key())
                    .col(ColumnDef::new(Agents::AccountId).uuid().not_null())
                    .col(ColumnDef::new(Agents::Name).string().not_null())
                    .col(ColumnDef::new(Agents::CreatedAt).big_integer().not_null())
                    .col(ColumnDef::new(Agents::LastSeenAt).big_integer().null())
                    .col(ColumnDef::new(Agents::ModelTable).json().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_agents_account")
                            .from(Agents::Table, Agents::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Sessions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Sessions::CardId)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Sessions::AgentId).uuid().null())
                    .col(ColumnDef::new(Sessions::AccountId).uuid().not_null())
                    .col(ColumnDef::new(Sessions::Project).string().not_null())
                    .col(ColumnDef::new(Sessions::ClaudeSessionId).uuid().null())
                    .col(ColumnDef::new(Sessions::PermissionMode).string().null())
                    .col(ColumnDef::new(Sessions::Model).string().null())
                    .col(ColumnDef::new(Sessions::ModelLabel).string().null())
                    .col(ColumnDef::new(Sessions::ModelRequested).string().null())
                    .col(ColumnDef::new(Sessions::Status).json().not_null())
                    .col(
                        ColumnDef::new(Sessions::SubagentActive)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Sessions::LastActivityAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Sessions::LastAssistantMessage)
                            .string()
                            .null(),
                    )
                    .col(ColumnDef::new(Sessions::CreatedAt).big_integer().not_null())
                    .col(ColumnDef::new(Sessions::HooksSeen).boolean().not_null())
                    .col(ColumnDef::new(Sessions::Archived).boolean().not_null())
                    .col(ColumnDef::new(Sessions::TomlAccount).string().null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_sessions_account")
                            .from(Sessions::Table, Sessions::AccountId)
                            .to(Accounts::Table, Accounts::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_sessions_agent")
                            .from(Sessions::Table, Sessions::AgentId)
                            .to(Agents::Table, Agents::Id)
                            // PC の登録を外してもカードの記録は残す（履歴を失わせない）
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        // 一覧は「このアカウントの、外していないカード」で引く（設計§8-6 の WHERE）
        manager
            .create_index(
                Index::create()
                    .name("idx_sessions_account_archived")
                    .table(Sessions::Table)
                    .col(Sessions::AccountId)
                    .col(Sessions::Archived)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(TranscriptNodes::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(TranscriptNodes::CardId).uuid().not_null())
                    .col(ColumnDef::new(TranscriptNodes::NodeId).string().not_null())
                    .col(ColumnDef::new(TranscriptNodes::Parent).string().null())
                    .col(ColumnDef::new(TranscriptNodes::Ts).big_integer().not_null())
                    .col(ColumnDef::new(TranscriptNodes::Branch).integer().not_null())
                    .col(
                        ColumnDef::new(TranscriptNodes::Seq)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(TranscriptNodes::Payload).json().not_null())
                    // 同じIDは上書き（設計§3-2 の upsert 契約）を、主キーで機構にする
                    .primary_key(
                        Index::create()
                            .col(TranscriptNodes::CardId)
                            .col(TranscriptNodes::NodeId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_transcript_nodes_session")
                            .from(TranscriptNodes::Table, TranscriptNodes::CardId)
                            .to(Sessions::Table, Sessions::CardId)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // ページングの並びはこの索引で決まる（設計§3-3）
        manager
            .create_index(
                Index::create()
                    .name("idx_transcript_nodes_card_seq")
                    .table(TranscriptNodes::Table)
                    .col(TranscriptNodes::CardId)
                    .col(TranscriptNodes::Seq)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(WebSessions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(WebSessions::Id)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(WebSessions::Data).binary().not_null())
                    .col(
                        ColumnDef::new(WebSessions::ExpiryDate)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // 掃除ジョブは「期限を過ぎたもの」だけを消す
        manager
            .create_index(
                Index::create()
                    .name("idx_web_sessions_expiry")
                    .table(WebSessions::Table)
                    .col(WebSessions::ExpiryDate)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Settings::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Settings::AccountId).uuid().not_null())
                    .col(ColumnDef::new(Settings::Key).string().not_null())
                    .col(ColumnDef::new(Settings::Value).json().not_null())
                    .primary_key(Index::create().col(Settings::AccountId).col(Settings::Key))
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 参照している側から落とす
        for table in [
            Settings::Table.into_iden(),
            WebSessions::Table.into_iden(),
            TranscriptNodes::Table.into_iden(),
            Sessions::Table.into_iden(),
            Agents::Table.into_iden(),
            PairingTokens::Table.into_iden(),
            Accounts::Table.into_iden(),
        ] {
            manager
                .drop_table(Table::drop().table(table).if_exists().to_owned())
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Accounts {
    Table,
    Id,
    Name,
    PasswordHash,
    IsAdmin,
    CreatedAt,
}

#[derive(DeriveIden)]
enum PairingTokens {
    Table,
    Id,
    AccountId,
    TokenHash,
    Label,
    CreatedAt,
    LastUsedAt,
    RevokedAt,
}

#[derive(DeriveIden)]
enum Agents {
    Table,
    Id,
    AccountId,
    Name,
    CreatedAt,
    LastSeenAt,
    ModelTable,
}

#[derive(DeriveIden)]
enum Sessions {
    Table,
    CardId,
    AgentId,
    AccountId,
    Project,
    ClaudeSessionId,
    PermissionMode,
    Model,
    ModelLabel,
    ModelRequested,
    Status,
    SubagentActive,
    LastActivityAt,
    LastAssistantMessage,
    CreatedAt,
    HooksSeen,
    Archived,
    TomlAccount,
}

#[derive(DeriveIden)]
enum TranscriptNodes {
    Table,
    CardId,
    NodeId,
    Parent,
    Ts,
    Branch,
    Seq,
    Payload,
}

#[derive(DeriveIden)]
enum WebSessions {
    Table,
    Id,
    Data,
    ExpiryDate,
}

#[derive(DeriveIden)]
enum Settings {
    Table,
    AccountId,
    Key,
    Value,
}
