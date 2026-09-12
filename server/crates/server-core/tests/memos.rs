//! メモの記録（メモ テスト計画フェーズ2）。
//!
//! **SQLite と PostgreSQL の両方へ同じコードで通す**（`common::backends`）。表を1つ足したので、
//! `make test-compose` を省けない——「新しい DB テストは両方へ通す」が PJT の約束である。
//!
//! # 宛先を2つとも同じ経路で通す
//!
//! 要件9 が「2つのメモは同じ部品・同じ口・同じ記録で作る」ことを求めているので、
//! **テストも同じ関数を宛先違いで呼ぶ**。片方だけ別の書き方になっていたら、そこが
//! 二重実装の兆しである。

mod common;

use sea_orm::{ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use server_core::db::{self, entity::memos as entity, memos, settings};
use uuid::Uuid;

/// 1日のミリ秒。
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// テスト用のアカウント行を1つ作る。
///
/// **外部キーがあるので、アカウントが無いとメモを積めない。** 積めないこと自体が
/// 「アカウントごと消えたらメモも消える」の裏返しである。
async fn account(db: &DatabaseConnection, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    db::entity::accounts::Entity::insert(db::entity::accounts::ActiveModel {
        id: Set(id),
        name: Set(name.to_string()),
        password_hash: Set(None),
        is_admin: Set(false),
        created_at: Set(db::now_ms()),
    })
    .exec(db)
    .await
    .expect("アカウントを作れること");
    id
}

/// 本文（ブロックエディタの構造を模したもの）。
fn body(text: &str) -> serde_json::Value {
    serde_json::json!({ "blocks": [{ "type": "paragraph", "text": text }] })
}

/// 本文から見出しの文字列を取り出す（並びの確認用）。
fn text_of(row: &entity::Model) -> String {
    row.body["blocks"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// メモを1件積んで、時刻を指定の値へ寄せる。
///
/// **`add` は時刻を引数に取らない**（サーバが打つ）ので、並びや掃除を確かめるには
/// 積んだあとに寄せる。**これはテストの都合であって、製品の経路ではない。**
async fn add_at(
    db: &DatabaseConnection,
    account_id: Uuid,
    kind: &str,
    session: Option<Uuid>,
    text: &str,
    noted_at: i64,
) -> Uuid {
    let row = memos::add(db, account_id, kind, session, body(text))
        .await
        .expect("積めること");
    let mut active: entity::ActiveModel = row.clone().into();
    active.noted_at = Set(noted_at);
    entity::Entity::update(active)
        .exec(db)
        .await
        .expect("時刻を寄せられること");
    row.id
}

#[tokio::test]
async fn 宛先が違うメモは互いの一覧に出ない() {
    for backend in common::backends("memos_targets").await {
        let account = account(&backend.db, "みほん").await;
        let session = Uuid::new_v4();
        let 別のセッション = Uuid::new_v4();

        memos::add(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            body("ぜんたい"),
        )
        .await
        .expect("積めること");
        memos::add(
            &backend.db,
            account,
            memos::TARGET_SESSION,
            Some(session),
            body("このセッション"),
        )
        .await
        .expect("積めること");
        memos::add(
            &backend.db,
            account,
            memos::TARGET_SESSION,
            Some(別のセッション),
            body("となりのセッション"),
        )
        .await
        .expect("積めること");

        // **同じ表に3行入っている**（宛先は列であって、別の表ではない）
        let 全行 = entity::Entity::find()
            .filter(entity::Column::AccountId.eq(account))
            .all(&backend.db)
            .await
            .expect("読めること");
        assert_eq!(全行.len(), 3, "{}：同じ表に入っていない", backend.name);

        let 全体 = memos::list(&backend.db, account, memos::TARGET_GLOBAL, None)
            .await
            .expect("読めること");
        assert_eq!(
            全体.iter().map(text_of).collect::<Vec<_>>(),
            vec!["ぜんたい"],
            "{}：全体メモにセッションのぶんが混ざっている",
            backend.name
        );

        let このセッション =
            memos::list(&backend.db, account, memos::TARGET_SESSION, Some(session))
                .await
                .expect("読めること");
        assert_eq!(
            このセッション.iter().map(text_of).collect::<Vec<_>>(),
            vec!["このセッション"],
            "{}：別のセッションのメモが出ている",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 並びは2段でどちらも新しいものが下() {
    for backend in common::backends("memos_order").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();

        let 古い = add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "ふるい",
            now - 3000,
        )
        .await;
        add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "まんなか",
            now - 2000,
        )
        .await;
        let 新しい = add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "あたらしい",
            now - 1000,
        )
        .await;

        // **先に「あたらしい」を、あとから「ふるい」をチェックする。**
        // 上段の並びはメモの時刻ではなく**チェックした時刻**で決まる
        memos::check(&backend.db, account, 新しい, true)
            .await
            .expect("チェックできること");
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        memos::check(&backend.db, account, 古い, true)
            .await
            .expect("チェックできること");

        let rows = memos::list(&backend.db, account, memos::TARGET_GLOBAL, None)
            .await
            .expect("読めること");
        assert_eq!(
            rows.iter().map(text_of).collect::<Vec<_>>(),
            vec!["あたらしい", "ふるい", "まんなか"],
            "{}：チェック済みが上段へ行き、あとからチェックしたものほど下、という並びになっていない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn チェックを外すとメモの時刻の位置へ戻る() {
    for backend in common::backends("memos_uncheck").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();
        add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "1ばん",
            now - 3000,
        )
        .await;
        let 真ん中 = add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "2ばん",
            now - 2000,
        )
        .await;
        add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "3ばん",
            now - 1000,
        )
        .await;

        memos::check(&backend.db, account, 真ん中, true)
            .await
            .expect("チェックできること");
        memos::check(&backend.db, account, 真ん中, false)
            .await
            .expect("外せること");

        let rows = memos::list(&backend.db, account, memos::TARGET_GLOBAL, None)
            .await
            .expect("読めること");
        assert_eq!(
            rows.iter().map(text_of).collect::<Vec<_>>(),
            vec!["1ばん", "2ばん", "3ばん"],
            "{}：外したあとが末尾へ行っている（メモの時刻の位置へ戻っていない）",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 時刻は端末から受け取らずサーバが打つ() {
    for backend in common::backends("memos_server_clock").await {
        let account = account(&backend.db, "みほん").await;
        let 直前 = db::now_ms();
        let row = memos::add(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            body("いま"),
        )
        .await
        .expect("積めること");
        let 直後 = db::now_ms();

        // **`add` は時刻を引数に取らない**（取れないことがこの検査の本体である）。
        // 打たれた時刻が呼び出しの前後に収まっていることを見る
        assert!(
            row.noted_at >= 直前 && row.noted_at <= 直後,
            "{}：サーバの時計で打たれていない（{} は {}〜{} の外）",
            backend.name,
            row.noted_at,
            直前,
            直後
        );
        assert!(
            row.checked_at.is_none(),
            "{}：積んだ直後にチェックが立っている",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 内容が変わったときだけ時刻が動く() {
    for backend in common::backends("memos_edit_clock").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();
        let id = add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "もと",
            now - DAY_MS,
        )
        .await;
        let 元の時刻 = now - DAY_MS;

        // 同じ本文で確定した場合は据え置き
        let 据え置き = memos::edit(&backend.db, account, id, body("もと"))
            .await
            .expect("書けること")
            .expect("行があること");
        assert_eq!(
            据え置き.noted_at, 元の時刻,
            "{}：内容が同じなのに時刻が動いた（並びまで動く）",
            backend.name
        );

        // 変えた場合は進む
        let 進んだ = memos::edit(&backend.db, account, id, body("かえた"))
            .await
            .expect("書けること")
            .expect("行があること");
        assert!(
            進んだ.noted_at > 元の時刻,
            "{}：内容を変えたのに時刻が動いていない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人のメモは読めず書き換えられず消せない() {
    for backend in common::backends("memos_tenancy").await {
        let 自分 = account(&backend.db, "じぶん").await;
        let 他人 = account(&backend.db, "たにん").await;
        let 他人のメモ = memos::add(
            &backend.db,
            他人,
            memos::TARGET_GLOBAL,
            None,
            body("ひみつ"),
        )
        .await
        .expect("積めること")
        .id;

        let 一覧 = memos::list(&backend.db, 自分, memos::TARGET_GLOBAL, None)
            .await
            .expect("読めること");
        assert!(一覧.is_empty(), "{}：他人のメモが一覧に出た", backend.name);

        assert!(
            memos::edit(&backend.db, 自分, 他人のメモ, body("のっとり"))
                .await
                .expect("落ちないこと")
                .is_none(),
            "{}：他人のメモを書き換えられた",
            backend.name
        );
        assert!(
            memos::check(&backend.db, 自分, 他人のメモ, true)
                .await
                .expect("落ちないこと")
                .is_none(),
            "{}：他人のメモにチェックを立てられた",
            backend.name
        );
        assert_eq!(
            memos::remove(&backend.db, 自分, 他人のメモ)
                .await
                .expect("落ちないこと"),
            0,
            "{}：他人のメモを消せた",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn アカウントを消すとメモも消える() {
    for backend in common::backends("memos_cascade").await {
        let account = account(&backend.db, "みほん").await;
        memos::add(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            body("きえる"),
        )
        .await
        .expect("積めること");

        db::entity::accounts::Entity::delete_by_id(account)
            .exec(&backend.db)
            .await
            .expect("消せること");

        let 残り = entity::Entity::find()
            .filter(entity::Column::AccountId.eq(account))
            .all(&backend.db)
            .await
            .expect("読めること");
        assert!(残り.is_empty(), "{}：Cascade が効いていない", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn セッションの行が無くてもメモは積めて読める() {
    for backend in common::backends("memos_no_session_fk").await {
        let account = account(&backend.db, "みほん").await;
        // **`sessions` に1行も無い状態で、そのセッション宛てのメモを積む。**
        // 外部キーを張っていないから通る——張っていたらここで落ちる。
        // これは要件15「終了したカード・抜け殻のカードでこそ読みたい」の裏づけである
        let 消えたセッション = Uuid::new_v4();
        memos::add(
            &backend.db,
            account,
            memos::TARGET_SESSION,
            Some(消えたセッション),
            body("カードはもう無い"),
        )
        .await
        .expect("カードが無くても積めること");

        let rows = memos::list(
            &backend.db,
            account,
            memos::TARGET_SESSION,
            Some(消えたセッション),
        )
        .await
        .expect("読めること");
        assert_eq!(
            rows.iter().map(text_of).collect::<Vec<_>>(),
            vec!["カードはもう無い"],
            "{}：カードが無いと読めない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 掃除は期限切れだけを落とす() {
    for backend in common::backends("memos_sweep").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();
        add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "きのう",
            now - DAY_MS,
        )
        .await;
        add_at(
            &backend.db,
            account,
            memos::TARGET_GLOBAL,
            None,
            "100日前",
            now - 100 * DAY_MS,
        )
        .await;

        let removed = memos::sweep(&backend.db, now, settings::DEFAULT_MEMO_RETENTION_DAYS)
            .await
            .expect("掃けること");
        assert_eq!(removed, 1, "{}：落とした件数", backend.name);

        let rows = memos::list(&backend.db, account, memos::TARGET_GLOBAL, None)
            .await
            .expect("読めること");
        assert_eq!(
            rows.iter().map(text_of).collect::<Vec<_>>(),
            vec!["きのう"],
            "{}：残す側を消している",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 掃除の日数はアカウントごとの設定で決まる() {
    for backend in common::backends("memos_sweep_per_account").await {
        let 短い = account(&backend.db, "みじかい").await;
        let 既定 = account(&backend.db, "きてい").await;
        let now = db::now_ms();
        add_at(
            &backend.db,
            短い,
            memos::TARGET_GLOBAL,
            None,
            "10日前",
            now - 10 * DAY_MS,
        )
        .await;
        add_at(
            &backend.db,
            既定,
            memos::TARGET_GLOBAL,
            None,
            "10日前",
            now - 10 * DAY_MS,
        )
        .await;

        // 片方だけ「7日で消す」にする
        settings::put_memo_limits(
            &backend.db,
            短い,
            settings::MemoLimits {
                retention_days: 7,
                ..settings::MemoLimits::default()
            },
        )
        .await
        .expect("設定を書けること");

        let removed = memos::sweep(&backend.db, now, settings::DEFAULT_MEMO_RETENTION_DAYS)
            .await
            .expect("掃けること");
        assert_eq!(removed, 1, "{}：設定を見ずに一律で消している", backend.name);

        assert!(
            memos::list(&backend.db, 短い, memos::TARGET_GLOBAL, None)
                .await
                .unwrap()
                .is_empty(),
            "{}：短く設定した側が残っている",
            backend.name
        );
        assert_eq!(
            memos::list(&backend.db, 既定, memos::TARGET_GLOBAL, None)
                .await
                .unwrap()
                .len(),
            1,
            "{}：既定の側まで消えた",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 保持の設定は上限を超える値と無期限を断る() {
    // **記録を要さない検査**なので、バックエンドを起こさずに済む
    let 通る = |key: &str, value: serde_json::Value| settings::check(key, &value).is_ok();

    assert!(
        通る(settings::MEMO_RETENTION_DAYS, serde_json::json!(365)),
        "12か月は通ること"
    );
    assert!(
        通る(
            settings::MEMO_MAX_BYTES,
            serde_json::json!(20u64 * 1024 * 1024 * 1024)
        ),
        "20GB は通ること"
    );

    // **「無期限」「無制限」に当たる値を作らせない**（要件10）
    assert!(
        !通る(settings::MEMO_RETENTION_DAYS, serde_json::json!(0)),
        "0 日は断ること"
    );
    assert!(
        !通る(settings::MEMO_MAX_BYTES, serde_json::json!(0)),
        "0 バイトは断ること"
    );
    assert!(
        !通る(settings::MEMO_RETENTION_DAYS, serde_json::json!(366)),
        "12か月を超えたら断ること"
    );
    assert!(
        !通る(
            settings::MEMO_MAX_BYTES,
            serde_json::json!(20u64 * 1024 * 1024 * 1024 + 1)
        ),
        "20GB を超えたら断ること"
    );
    assert!(
        !通る(
            settings::MEMO_RETENTION_DAYS,
            serde_json::json!("unlimited")
        ),
        "文字列は断ること"
    );
}
