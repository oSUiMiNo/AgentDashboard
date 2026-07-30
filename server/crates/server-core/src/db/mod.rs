//! 記録の置き場所（セルフホスト化設計§3）。
//!
//! **ここが真実**。一覧も履歴も、メモリの写しではなくこの DB が正になる（§3-3）。
//! ローカルモードは SQLite、セルフホストは PostgreSQL で、**スキーマとコードは共通**。
//! 方針の「共有するのはスキーマ」をそのまま形にしてある。
//!
//! # 繋げなければ起動しない
//!
//! 接続やマイグレーションに失敗したら、縮退させずに**起動を拒否する**（利用者判断）。
//! DB が真実である以上、無い状態で動かすと一覧も履歴も嘘になる。設計§12 の「DB 断」は
//! *稼働中に* 落ちた場合の縮退の話で、起動時の検査とは別に扱う——起動時に失敗するのは
//! たいてい設定の打ち間違いで、そのときに黙って動くほうが害が大きい。
//!
//! # アカウントはローカルにも1つ置く
//!
//! ローカルモードに利用者アカウントの概念は無いが、行は [`LOCAL_ACCOUNT_ID`] で1つ作る。
//! `account_id` を NULL 許容にすると、§8-6 の「全エンドポイントで `account_id` を WHERE に
//! 含める」という絞り込みに「NULL は誰のものでもない」という抜け道ができるため。

pub mod entity;
mod migration;
pub mod settings;
pub mod transcript;

use sea_orm::{ActiveValue::Set, ConnectOptions, Database, DatabaseConnection, EntityTrait};
use sea_orm_migration::MigratorTrait as _;
use std::path::Path;
use uuid::Uuid;

/// ローカルモードのセッションが属するアカウント。
///
/// 値を固定しているのは、**再起動しても同じ行を指し続ける**必要があるため。起動のたびに
/// 採番すると、前回の記録が「別のアカウントのもの」になって一覧から消える。
pub const LOCAL_ACCOUNT_ID: Uuid = Uuid::from_u128(1);

/// ローカルアカウントの名前。モデル表のキー（設計§13-4）と同じ綴りにしてある。
pub const LOCAL_ACCOUNT_NAME: &str = "local";

/// アカウントに属さない設定（LAN パスワード等）のスコープ（設計§13-3）。
///
/// 設計§3-2 は NULL でこれを表すとしているが、**PostgreSQL は主キーに NULL を許さない**。
/// nil UUID を「サーバ全体」の印として使う。
pub const SERVER_SCOPE_ID: Uuid = Uuid::nil();

/// DB へ繋いでスキーマを揃える。
///
/// 順序は「繋ぐ → マイグレーション → 既定の行を用意」。この3つが揃って初めて
/// 「DB が真実」と言える状態になるので、どれか1つでも失敗したら呼び出し側は起動を諦める。
pub async fn connect(url: &str) -> anyhow::Result<DatabaseConnection> {
    let url = prepare_sqlite(url)?;

    let mut options = ConnectOptions::new(url.clone());
    // SQL をそのままログへ出すと、指示の本文や履歴の中身が端末とログファイルへ流れる。
    // 個人の手元とはいえ、既定で出すものではない
    options.sqlx_logging(false);

    let db = Database::connect(options)
        .await
        .map_err(|err| anyhow::anyhow!("DB へ接続できません（{}）: {err}", masked(&url)))?;

    migration::Migrator::up(&db, None)
        .await
        .map_err(|err| anyhow::anyhow!("DB のスキーマを適用できません: {err}"))?;

    ensure_local_account(&db).await?;
    Ok(db)
}

/// ローカルモードのアカウント行を用意する。既にあれば何もしない。
async fn ensure_local_account(db: &DatabaseConnection) -> anyhow::Result<()> {
    use entity::accounts;

    if accounts::Entity::find_by_id(LOCAL_ACCOUNT_ID)
        .one(db)
        .await?
        .is_some()
    {
        return Ok(());
    }

    let row = accounts::ActiveModel {
        id: Set(LOCAL_ACCOUNT_ID),
        name: Set(LOCAL_ACCOUNT_NAME.to_string()),
        // ハッシュを持たない＝ログインできない。フェーズ5 の照合はここで弾く
        password_hash: Set(None),
        is_admin: Set(false),
        created_at: Set(now_ms()),
    };
    // 起動が競合しても片方が入っていればよい（主キー衝突は成功と同じ意味）
    accounts::Entity::insert(row)
        .on_conflict_do_nothing()
        .exec(db)
        .await?;
    Ok(())
}

/// epoch ミリ秒。DB に入れる時刻はすべてこの形（`protocol::Timestamp` と同じ）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// SQLite なら置き場所を作り、ファイルが無くても作られるようにする。
///
/// `mode=rwc` を付けないと**存在しないファイルは開けずに失敗する**。初回起動が必ず
/// この経路を通るので、ここで面倒を見ておかないと「初めて動かした人だけ落ちる」になる。
fn prepare_sqlite(url: &str) -> anyhow::Result<String> {
    let Some(rest) = url.strip_prefix("sqlite:") else {
        return Ok(url.to_string());
    };
    // `sqlite://path` と `sqlite:path` のどちらも受ける
    let path_part = rest.strip_prefix("//").unwrap_or(rest);
    let (path_part, query) = match path_part.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path_part, None),
    };

    // メモリDB（テスト用）はファイルを作らない
    if path_part.is_empty() || path_part.starts_with(":memory:") {
        return Ok(url.to_string());
    }

    if let Some(dir) = Path::new(path_part).parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir).map_err(|err| {
            anyhow::anyhow!("DB の置き場所を作れません（{}）: {err}", dir.display())
        })?;
    }

    let has_mode = query.is_some_and(|query| query.contains("mode="));
    Ok(match (query, has_mode) {
        (_, true) => url.to_string(),
        (Some(query), false) => format!("sqlite://{path_part}?{query}&mode=rwc"),
        (None, false) => format!("sqlite://{path_part}?mode=rwc"),
    })
}

/// 接続文字列をログやエラーに出すときの伏せ字。
///
/// PostgreSQL の URL にはパスワードが入る。失敗したときにそのまま画面へ出すと、
/// **エラーメッセージ経由で秘密が漏れる**。
fn masked(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    match rest.split_once('@') {
        Some((_credentials, host)) => format!("{scheme}://***@{host}"),
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn sqlite_のURLには作成モードが足される() {
        // これが無いと、初めて動かしたときだけ「ファイルが無い」で落ちる
        assert_eq!(
            prepare_sqlite("sqlite:///tmp/x/dashboard.db").unwrap(),
            "sqlite:///tmp/x/dashboard.db?mode=rwc"
        );
        assert_eq!(
            prepare_sqlite("sqlite:///tmp/x/dashboard.db?cache=shared").unwrap(),
            "sqlite:///tmp/x/dashboard.db?cache=shared&mode=rwc"
        );
        // 明示されていれば尊重する
        assert_eq!(
            prepare_sqlite("sqlite:///tmp/x/dashboard.db?mode=ro").unwrap(),
            "sqlite:///tmp/x/dashboard.db?mode=ro"
        );
        let _ = std::fs::remove_dir_all("/tmp/x");
    }

    #[test]
    fn postgres_のURLは触らない() {
        let url = "postgres://user:pass@localhost/agentdashboard";
        assert_eq!(prepare_sqlite(url).unwrap(), url);
    }

    #[test]
    fn 接続文字列のパスワードは伏せる() {
        // 失敗のたびにエラーメッセージへ秘密が乗るのを防ぐ
        assert_eq!(
            masked("postgres://user:pass@db:5432/agentdashboard"),
            "postgres://***@db:5432/agentdashboard"
        );
        assert_eq!(
            masked("sqlite:///tmp/dashboard.db"),
            "sqlite:///tmp/dashboard.db"
        );
    }
}
