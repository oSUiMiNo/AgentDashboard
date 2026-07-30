//! スキーマの適用（セルフホスト化設計§3-2）。
//!
//! **サーバ起動時に `MigratorTrait::up` を自動実行する。** 手でマイグレーションコマンドを
//! 叩かせない理由は、セルフホストの初回 `docker compose up` とローカルの初回起動を
//! 「手作業ゼロでスキーマが揃う」状態にしたいため（5分セットアップ。設計§14-4）。
//!
//! 冪等なので、既に適用済みの環境で再実行しても何も起きない。

mod m20260731_000001_init;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20260731_000001_init::Migration)]
    }
}
