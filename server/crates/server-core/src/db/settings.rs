//! ダッシュボードから編集する設定の読み書き（セルフホスト化設計§13-3）。
//!
//! # なぜファイルではなく DB なのか
//!
//! 線引きは「**接続と機械に属するものはファイル、利用体験に属するものは DB**」（§13-1）。
//! 履歴の同期間隔や画面の更新間隔は利用者がその日の回線に合わせて変える値で、
//! 設定ファイルを開かせるものではない。要件3-2・5-3 の「設定は保存され、アプリを
//! 閉じても引き継がれる」はこちら側で満たす。
//!
//! # 既定値は「行が無い」ことで表す
//!
//! 起動時に既定値を書き込む方式は採らない。書いてしまうと、**後で既定を変えたときに
//! 既存の環境だけ古い値に取り残される**（利用者が選んだ値なのか、昔の既定なのかを
//! 区別できない）。行が無い＝まだ選んでいない、として読むときに埋める。
//!
//! 設定画面からの操作はフェーズ5、接続中セッションホストへの即時反映（SetIntervals）は
//! フェーズ3。ここは置き場所と読み書きだけを用意する。

use super::entity::settings;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use uuid::Uuid;

/// 履歴を送る間隔（秒）。選択肢は 5 / 10 / 20 / 60。
pub const SYNC_INTERVAL_SECS: &str = "sync_interval_secs";
pub const DEFAULT_SYNC_INTERVAL_SECS: u64 = 20;

/// 画面を送る間隔（ミリ秒）。選択肢は 50 / 1000 / 5000 / 10000 / 20000。
pub const SCREEN_INTERVAL_MS: &str = "screen_interval_ms";
pub const DEFAULT_SCREEN_INTERVAL_MS: u64 = 20_000;

/// 端末のスクロールバック行数。
pub const SCROLLBACK_LINES: &str = "scrollback_lines";
pub const DEFAULT_SCROLLBACK_LINES: u64 = 1_000;

/// 起動時の権限モードの「既定の選択」を「全承認をスキップ」にするか。
///
/// **アカウントスコープ**。LAN パスワードや更新確認と違い、サーバ全体で1つにしない——
/// 「起動フォームの既定をどちらにするか」は完全に利用体験の話で、他人に影響しない。
///
/// **行が無いことに意味がある**（持ち出し設計§3）。まだ画面から触っていない間は
/// PC 側が持っている値（`config.toml` ／ 名乗り）を初期値として使う。ここに行ができた
/// 時点で、以後はこちらが正になる。
pub const ALWAYS_BYPASS_PERMISSIONS: &str = "always_bypass_permissions";
pub const DEFAULT_ALWAYS_BYPASS_PERMISSIONS: bool = false;

/// LAN 開放時の共有パスワード（argon2 ハッシュ）。**サーバ全体スコープ**（設計§8-3）。
pub const LAN_PASSWORD_HASH: &str = "lan_password_hash";

/// 新しい版が出ていないか見に行くか。**サーバ全体スコープ**（CICD 設計§8）。
///
/// アカウント単位に持たない。更新すれば全員に効くので、片方が切ったのに
/// **もう片方の画面にボタンが出る**という食い違いが生まれる。
///
/// 既定は「見に行く」。**見に行くだけ**で、取ってくることも入れ替えることもしない。
pub const UPDATE_CHECK_ENABLED: &str = "update_check_enabled";
pub const DEFAULT_UPDATE_CHECK_ENABLED: bool = true;

/// アカウントに属する設定のキー（持ち出し設計§7）。**書き出す対象はこれで決まる。**
///
/// サーバ全体スコープのもの（LAN パスワード・更新確認）はここに入らないので、
/// **秘密が持ち出しへ混ざる余地が構造的に無い**。裏返すと、**アカウントスコープへ
/// 秘密を置いてはいけない**——ここが持ち出しの対象そのものになる。
pub const ACCOUNT_KEYS: [&str; 4] = [
    ALWAYS_BYPASS_PERMISSIONS,
    SYNC_INTERVAL_SECS,
    SCREEN_INTERVAL_MS,
    SCROLLBACK_LINES,
];

/// 入れてよい間隔の範囲。画面の選択肢を含む、余裕のある幅にしてある。
///
/// **上限を置くのは、事故の桁を止めるため**。0 は「休みなく送る」と読めてしまうので
/// 下限も要る。
pub const SYNC_INTERVAL_SECS_RANGE: std::ops::RangeInclusive<u64> = 1..=86_400;
pub const SCREEN_INTERVAL_MS_RANGE: std::ops::RangeInclusive<u64> = 10..=600_000;
pub const SCROLLBACK_LINES_RANGE: std::ops::RangeInclusive<u64> = 1..=1_000_000;

/// その値を入れてよいか。**入口が違っても同じ答えになる**ように、検査はここ1か所に置く
/// （持ち出し設計§9）。
///
/// 画面からの `PUT` も、ファイルからの読み込みも、書く前にここを通る。片方だけ厳しいと、
/// **同じ値が入口によって通ったり通らなかったりする**——追いにくい食い違いになる。
///
/// 断る理由は**どのキーがどう駄目か**が分かる文にする。そのまま利用者へ見せる。
pub fn check(key: &str, value: &serde_json::Value) -> Result<(), String> {
    let number = |range: &std::ops::RangeInclusive<u64>| -> Result<(), String> {
        match value.as_u64() {
            Some(number) if range.contains(&number) => Ok(()),
            Some(number) => Err(format!(
                "{key} は {}〜{} の範囲で指定してください（{number} が入っています）",
                range.start(),
                range.end()
            )),
            None => Err(format!("{key} には数値を指定してください")),
        }
    };
    match key {
        ALWAYS_BYPASS_PERMISSIONS => value
            .as_bool()
            .map(|_| ())
            .ok_or_else(|| format!("{key} には true か false を指定してください")),
        SYNC_INTERVAL_SECS => number(&SYNC_INTERVAL_SECS_RANGE),
        SCREEN_INTERVAL_MS => number(&SCREEN_INTERVAL_MS_RANGE),
        SCROLLBACK_LINES => number(&SCROLLBACK_LINES_RANGE),
        _ => Err(format!("{key} は知らない設定です")),
    }
}

/// セッションホストへ配る間隔の一式（設計§4-2 の SetIntervals と同じ組）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Intervals {
    pub sync_interval_secs: u64,
    pub screen_interval_ms: u64,
    pub scrollback_lines: u64,
}

impl Default for Intervals {
    fn default() -> Self {
        Self {
            sync_interval_secs: DEFAULT_SYNC_INTERVAL_SECS,
            screen_interval_ms: DEFAULT_SCREEN_INTERVAL_MS,
            scrollback_lines: DEFAULT_SCROLLBACK_LINES,
        }
    }
}

/// 1つ読む。行が無ければ `None`。
pub async fn get(
    db: &DatabaseConnection,
    scope: Uuid,
    key: &str,
) -> Result<Option<serde_json::Value>, DbErr> {
    Ok(settings::Entity::find_by_id((scope, key.to_string()))
        .one(db)
        .await?
        .map(|row| row.value))
}

/// 1つ書く。既にあれば上書きする。
pub async fn put(
    db: &DatabaseConnection,
    scope: Uuid,
    key: &str,
    value: serde_json::Value,
) -> Result<(), DbErr> {
    let row = settings::ActiveModel {
        account_id: Set(scope),
        key: Set(key.to_string()),
        value: Set(value),
    };
    settings::Entity::insert(row)
        .on_conflict(
            OnConflict::columns([settings::Column::AccountId, settings::Column::Key])
                .update_column(settings::Column::Value)
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

/// 1つ消す（＝既定へ戻す）。
pub async fn remove(db: &DatabaseConnection, scope: Uuid, key: &str) -> Result<(), DbErr> {
    settings::Entity::delete_many()
        .filter(settings::Column::AccountId.eq(scope))
        .filter(settings::Column::Key.eq(key))
        .exec(db)
        .await?;
    Ok(())
}

/// そのアカウントの間隔一式を読む。選んでいないものは既定で埋める。
pub async fn intervals(db: &DatabaseConnection, account: Uuid) -> Result<Intervals, DbErr> {
    let mut intervals = Intervals::default();
    for (key, slot) in [
        (SYNC_INTERVAL_SECS, &mut intervals.sync_interval_secs),
        (SCREEN_INTERVAL_MS, &mut intervals.screen_interval_ms),
        (SCROLLBACK_LINES, &mut intervals.scrollback_lines),
    ] {
        // 型が合わない値が入っていたら既定のままにする。**壊れた1つが他まで巻き添えに
        // しない**（利用者から見ると「設定画面が開かない」になるため）
        if let Some(value) = get(db, account, key).await?
            && let Some(number) = value.as_u64()
        {
            *slot = number;
        }
    }
    Ok(intervals)
}

/// 間隔を3つまとめて書く。
///
/// 1つずつ書く形を呼び出し側に持たせると、**書く順序とキー名がそこへ散る**。
/// 配る相手（PC）が居る場合は [`crate::gateway::SessionHostHub::set_intervals`] を通ること
/// （こちらは保存だけで、接続中の PC へは配らない）。
pub async fn put_intervals(
    db: &DatabaseConnection,
    account: Uuid,
    intervals: Intervals,
) -> Result<(), DbErr> {
    for (key, value) in [
        (SYNC_INTERVAL_SECS, intervals.sync_interval_secs),
        (SCREEN_INTERVAL_MS, intervals.screen_interval_ms),
        (SCROLLBACK_LINES, intervals.scrollback_lines),
    ] {
        put(db, account, key, serde_json::json!(value)).await?;
    }
    Ok(())
}

/// 権限確認スキップの既定。**選んでいなければ `None`**。
///
/// 既定で埋めて返さないのは、**「まだ選んでいない」と「オフを選んだ」を呼ぶ側が
/// 区別する必要がある**ため（持ち出し設計§3）。前者のときだけ PC 側の値を見る。
/// この判断ができるのは両側を見られる層（`crates/core`）だけなので、ここは
/// 生の有無をそのまま返す。
pub async fn always_bypass_permissions(
    db: &DatabaseConnection,
    account: Uuid,
) -> Result<Option<bool>, DbErr> {
    Ok(get(db, account, ALWAYS_BYPASS_PERMISSIONS)
        .await?
        .and_then(|value| value.as_bool()))
}

/// 権限確認スキップの既定を、行が無ければ `fallback` で埋めて返す。
///
/// **薄いラッパを1本生やす**のは [`lan_password_hash`] と同じ作法。`crates/core` は
/// 記録の道具そのものを通常依存に持っていないので、**型を書かずに呼べる形**が要る。
///
/// 読めなかったときも `fallback` を返す。記録が読めない事故と「まだ選んでいない」で
/// 落とし先が同じなので分ける意味が無く、ここで失敗を返すと設定画面ごと開かなくなる。
pub async fn always_bypass_or(db: &DatabaseConnection, account: Uuid, fallback: bool) -> bool {
    match always_bypass_permissions(db, account).await {
        Ok(value) => value.unwrap_or(fallback),
        Err(err) => {
            tracing::warn!("権限確認スキップの既定を読めません: {err}");
            fallback
        }
    }
}

/// 権限確認スキップの既定を決める。**ここで行ができ、以後は記録が正になる。**
pub async fn set_always_bypass_permissions(
    db: &DatabaseConnection,
    account: Uuid,
    value: bool,
) -> Result<(), DbErr> {
    put(
        db,
        account,
        ALWAYS_BYPASS_PERMISSIONS,
        serde_json::json!(value),
    )
    .await
}

/// LAN 開放の共有パスワード（ハッシュ）。設定されていなければ `None`。
pub async fn lan_password_hash(db: &DatabaseConnection) -> Result<Option<String>, DbErr> {
    Ok(get(db, super::SERVER_SCOPE_ID, LAN_PASSWORD_HASH)
        .await?
        .and_then(|value| value.as_str().map(str::to_string)))
}

/// 新しい版を見に行ってよいか。行が無ければ既定（見に行く）。
///
/// **薄いラッパを1本生やす**のは [`lan_password_hash`] と同じ作法。呼ぶ側に
/// スコープとキーの綴りを持たせない——`crates/core` は記録の道具そのものを
/// 通常依存に持っていないので、型を書かずに呼べる形が要る。
pub async fn update_check_enabled(db: &DatabaseConnection) -> Result<bool, DbErr> {
    Ok(get(db, super::SERVER_SCOPE_ID, UPDATE_CHECK_ENABLED)
        .await?
        .and_then(|value| value.as_bool())
        .unwrap_or(DEFAULT_UPDATE_CHECK_ENABLED))
}

/// 新しい版を見に行くかを決める。
pub async fn set_update_check_enabled(db: &DatabaseConnection, enabled: bool) -> Result<(), DbErr> {
    put(
        db,
        super::SERVER_SCOPE_ID,
        UPDATE_CHECK_ENABLED,
        serde_json::json!(enabled),
    )
    .await
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 入れてよい値だけが通る() {
        assert!(check(ALWAYS_BYPASS_PERMISSIONS, &serde_json::json!(true)).is_ok());
        assert!(check(SYNC_INTERVAL_SECS, &serde_json::json!(20)).is_ok());
        assert!(check(SCREEN_INTERVAL_MS, &serde_json::json!(20_000)).is_ok());
        assert!(check(SCROLLBACK_LINES, &serde_json::json!(1_000)).is_ok());
    }

    #[test]
    fn 範囲の両端は通り_その外は断る() {
        // 境界を跨ぐところで挙動が変わることを固定する（片側だけ直すと気付けない）
        for (key, range) in [
            (SYNC_INTERVAL_SECS, SYNC_INTERVAL_SECS_RANGE),
            (SCREEN_INTERVAL_MS, SCREEN_INTERVAL_MS_RANGE),
            (SCROLLBACK_LINES, SCROLLBACK_LINES_RANGE),
        ] {
            assert!(
                check(key, &serde_json::json!(range.start())).is_ok(),
                "{key}"
            );
            assert!(check(key, &serde_json::json!(range.end())).is_ok(), "{key}");
            assert!(
                check(key, &serde_json::json!(range.start() - 1)).is_err(),
                "{key}"
            );
            assert!(
                check(key, &serde_json::json!(range.end() + 1)).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn 断る理由にキーの名前が入る() {
        // そのまま利用者へ見せる文なので、どれが駄目かが分かること
        let reason = check(SYNC_INTERVAL_SECS, &serde_json::json!(0)).unwrap_err();
        assert!(reason.contains(SYNC_INTERVAL_SECS), "{reason}");

        let reason = check(SCROLLBACK_LINES, &serde_json::json!("たくさん")).unwrap_err();
        assert!(reason.contains(SCROLLBACK_LINES), "{reason}");

        let reason = check(ALWAYS_BYPASS_PERMISSIONS, &serde_json::json!(1)).unwrap_err();
        assert!(reason.contains(ALWAYS_BYPASS_PERMISSIONS), "{reason}");
    }

    #[test]
    fn 知らないキーは断る() {
        assert!(check("lan_password_hash", &serde_json::json!("x")).is_err());
        assert!(check("update_check_enabled", &serde_json::json!(true)).is_err());
    }

    #[test]
    fn 持ち出しの対象にサーバ全体のものが入らない() {
        // **秘密が混ざる余地を、選び方で断つ**（持ち出し設計§7）。ここに
        // サーバ全体スコープのキーが入ると、書き出しへそのまま乗る
        assert!(!ACCOUNT_KEYS.contains(&LAN_PASSWORD_HASH));
        assert!(!ACCOUNT_KEYS.contains(&UPDATE_CHECK_ENABLED));
        // 持ち出しの対象なら、必ず検査を持っていること。**キーを足して検査を
        // 足し忘れると、読み込みで何でも入る**
        for key in ACCOUNT_KEYS {
            let reason = check(key, &serde_json::json!(null)).unwrap_err();
            assert!(
                !reason.contains("知らない設定"),
                "{key} が検査を持っていない: {reason}"
            );
        }
    }
}
