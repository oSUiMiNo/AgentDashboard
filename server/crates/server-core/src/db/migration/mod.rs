//! スキーマの適用（セルフホスト化設計§3-2）。
//!
//! **サーバ起動時に `MigratorTrait::up` を自動実行する。** 手でマイグレーションコマンドを
//! 叩かせない理由は、セルフホストの初回 `docker compose up` とローカルの初回起動を
//! 「手作業ゼロでスキーマが揃う」状態にしたいため（5分セットアップ。設計§14-4）。
//!
//! 冪等なので、既に適用済みの環境で再実行しても何も起きない。

mod m20260731_000001_init;
mod m20260801_000002_agent_capabilities;
mod m20260805_000003_projects;
mod m20260810_000004_token_kind;
mod m20260825_000005_session_title;
mod m20260902_000006_position;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260731_000001_init::Migration),
            Box::new(m20260801_000002_agent_capabilities::Migration),
            Box::new(m20260805_000003_projects::Migration),
            Box::new(m20260810_000004_token_kind::Migration),
            Box::new(m20260825_000005_session_title::Migration),
            Box::new(m20260902_000006_position::Migration),
        ]
    }
}
