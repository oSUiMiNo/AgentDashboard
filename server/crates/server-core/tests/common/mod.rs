//! DB のテストを **SQLite と PostgreSQL の両方へ同じコードで**通すための足場
//! （セルフホスト化設計§3-2・§15-3、テスト計画フェーズ2 の最終項目）。
//!
//! # なぜ両方へ通すのか
//!
//! 「共有するのはスキーマ」が本設計の前提なので、**SQLite では通るのに PostgreSQL で
//! 落ちる**という食い違いが最も痛い。型の厳密さ（SQLite は動的型・PostgreSQL は静的型）、
//! JSON の扱い、主キーに NULL を置けるか——どれも片方でしか出ない。ローカルで書いた
//! コードがセルフホストで初めて壊れるのを、この足場が手前で止める。
//!
//! # 走り方
//!
//! - `make ci`：SQLite だけ（PostgreSQL は用意されていないので黙って飛ばす）
//! - `make test-compose`：`AGENTDASHBOARD_TEST_DATABASE_URL` が指す PostgreSQL も加える
//!
//! **飛ばしたことは黙らない。** 環境変数が無いときは理由を印字する。「両方通した」と
//! 「片方しか走っていない」を見分けられないと、この足場は意味を失う。

#![allow(dead_code)]

use sea_orm::{ConnectionTrait as _, Database, DatabaseConnection};
use std::path::PathBuf;

/// PostgreSQL 側の接続先を指す環境変数（`make test-compose` が設定する）。
///
/// 指すのは**管理用のデータベース**で、テストごとに使い捨ての DB をこの接続から作る。
pub const PG_URL_ENV: &str = "AGENTDASHBOARD_TEST_DATABASE_URL";

/// テスト1本ぶんの DB。
pub struct Backend {
    /// 落ちたときにどちらで落ちたか分かるようにする名札
    pub name: &'static str,
    pub db: DatabaseConnection,
    /// 同じ DB へ繋ぎ直すための接続文字列（マイグレーションの冪等性を見るのに要る）
    pub url: String,
    cleanup: Cleanup,
}

enum Cleanup {
    /// SQLite：ファイルごと消す
    File(PathBuf),
    /// PostgreSQL：管理用接続から使い捨て DB を落とす
    Database { admin_url: String, name: String },
}

impl Backend {
    /// 後始末。**テストの最後に必ず呼ぶ**（呼ばないと使い捨て DB が溜まる）。
    pub async fn finish(self) {
        let Backend { db, cleanup, .. } = self;
        let _ = db.close().await;
        match cleanup {
            Cleanup::File(path) => {
                let _ = std::fs::remove_file(&path);
                // SQLite は WAL とジャーナルを隣に作る
                for suffix in ["-wal", "-shm", "-journal"] {
                    let mut sidecar = path.clone().into_os_string();
                    sidecar.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(sidecar));
                }
            }
            Cleanup::Database { admin_url, name } => {
                if let Ok(admin) = Database::connect(admin_url).await {
                    let _ = admin
                        .execute_unprepared(&format!(r#"DROP DATABASE IF EXISTS "{name}""#))
                        .await;
                    let _ = admin.close().await;
                }
            }
        }
    }
}

/// このテストで使う DB を全部用意する。
///
/// `label` はテストの名札。使い捨ての置き場所の名前に混ぜて、並行して走る他のテストと
/// ぶつからないようにする（nextest はテストごとにプロセスを分けるが、PostgreSQL は
/// 共有なのでこちらで分ける必要がある）。
pub async fn backends(label: &str) -> Vec<Backend> {
    let mut backends = vec![sqlite(label).await];
    match std::env::var(PG_URL_ENV) {
        Ok(url) if !url.is_empty() => backends.push(postgres(label, &url).await),
        _ => eprintln!(
            "[{label}] PostgreSQL は飛ばしました（{PG_URL_ENV} が未設定）。両方で確かめるには make test-compose"
        ),
    }
    backends
}

async fn sqlite(label: &str) -> Backend {
    let path = std::env::temp_dir().join(format!(
        "agentdashboard-test-{label}-{}.db",
        uuid::Uuid::new_v4().simple()
    ));
    let url = format!("sqlite://{}", path.display());
    let db = server_core::db::connect(&url)
        .await
        .expect("SQLite へ繋げること");
    Backend {
        name: "sqlite",
        db,
        url,
        cleanup: Cleanup::File(path),
    }
}

async fn postgres(label: &str, admin_url: &str) -> Backend {
    // 使い捨ての DB を1つ作る。スキーマを共有すると、並行して走るテストが互いの行を見る
    let name = format!("adash_test_{label}_{}", uuid::Uuid::new_v4().simple());
    let admin = Database::connect(admin_url)
        .await
        .expect("PostgreSQL の管理用接続を開けること");
    admin
        .execute_unprepared(&format!(r#"CREATE DATABASE "{name}""#))
        .await
        .expect("使い捨てのデータベースを作れること");
    let _ = admin.close().await;

    let url = replace_database(admin_url, &name);
    let db = server_core::db::connect(&url)
        .await
        .expect("PostgreSQL へ繋げること");
    Backend {
        name: "postgres",
        db,
        url,
        cleanup: Cleanup::Database {
            admin_url: admin_url.to_string(),
            name,
        },
    }
}

/// 接続文字列のデータベース名だけを差し替える。
fn replace_database(url: &str, name: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (url, None),
    };
    // `postgres://user:pass@host:port/dbname` の最後の `/` から後ろが名前
    let stem = match base.rfind('/') {
        Some(at) if at > "postgres://".len() => &base[..at],
        _ => base,
    };
    match query {
        Some(query) => format!("{stem}/{name}?{query}"),
        None => format!("{stem}/{name}"),
    }
}
