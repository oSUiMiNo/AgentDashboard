//! アプリ全体の知らせの記録（トーストとベル テスト計画フェーズ2）。
//!
//! **SQLite と PostgreSQL の両方へ同じコードで通す**（`common::backends`）。表を1つ足したので、
//! `make test-compose` を省けない——「新しい DB テストは両方へ通す」が PJT の約束である。

mod common;

use sea_orm::{ActiveValue::Set, DatabaseConnection, EntityTrait};
use server_core::db::{self, notices};
use uuid::Uuid;

/// 1日のミリ秒。
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// テスト用のアカウント行を1つ作る。
///
/// **外部キーがあるので、アカウントが無いと知らせを積めない。** 積めないこと自体が
/// 「アカウントごと消えたら知らせも消える」の裏返しである。
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

/// 知らせを1件積む（時刻を指定する版）。
async fn push_at(db: &DatabaseConnection, account_id: Uuid, message: &str, at: i64) -> Uuid {
    notices::push(db, account_id, None, "error", "other", message, at)
        .await
        .expect("積めること")
        .id
}

#[tokio::test]
async fn 積んだ知らせは新しい順に読める() {
    for backend in common::backends("notices_order").await {
        let account = account(&backend.db, "みほん").await;
        let base = db::now_ms();
        push_at(&backend.db, account, "ふるい", base - 2000).await;
        push_at(&backend.db, account, "まんなか", base - 1000).await;
        push_at(&backend.db, account, "あたらしい", base).await;

        let (rows, has_more) = notices::list_page(&backend.db, account, None, 10)
            .await
            .expect("読めること");

        let texts: Vec<&str> = rows.iter().map(|r| r.message.as_str()).collect();
        assert_eq!(
            texts,
            vec!["あたらしい", "まんなか", "ふるい"],
            "{}：新しい順に並んでいない",
            backend.name
        );
        assert!(!has_more, "{}：続きがあると言っている", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn ページングは続きの有無を返す() {
    for backend in common::backends("notices_paging").await {
        let account = account(&backend.db, "みほん").await;
        let base = db::now_ms();
        for i in 0..5 {
            push_at(&backend.db, account, &format!("{i}"), base - i).await;
        }

        // **`limit + 1` 件取って判定している**ので、件数を数える問い合わせは飛ばない
        let (first, has_more) = notices::list_page(&backend.db, account, None, 2)
            .await
            .expect("読めること");
        assert_eq!(first.len(), 2, "{}：1ページの件数", backend.name);
        assert!(has_more, "{}：続きがあるのに無いと言っている", backend.name);

        let cursor = first.last().expect("2件目がある").created_at;
        let (second, _) = notices::list_page(&backend.db, account, Some(cursor), 10)
            .await
            .expect("続きを読めること");
        assert_eq!(
            second.len(),
            3,
            "{}：続きの件数（1ページ目の2件と重ならない）",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人の知らせは一覧にも未読にも出ない() {
    for backend in common::backends("notices_tenancy").await {
        let mine = account(&backend.db, "わたし").await;
        let theirs = account(&backend.db, "ひと").await;
        let now = db::now_ms();
        push_at(&backend.db, mine, "わたしの知らせ", now).await;
        push_at(&backend.db, theirs, "ひとの知らせ", now).await;

        let (rows, _) = notices::list_page(&backend.db, mine, None, 10)
            .await
            .expect("読めること");
        assert_eq!(rows.len(), 1, "{}：他人のぶんが混ざっている", backend.name);
        assert_eq!(rows[0].message, "わたしの知らせ", "{}", backend.name);

        assert_eq!(
            notices::unread_count(&backend.db, mine)
                .await
                .expect("数えられること"),
            1,
            "{}：未読の数に他人のぶんが入っている",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 既読にすると未読が減り_他人には効かない() {
    for backend in common::backends("notices_read").await {
        let mine = account(&backend.db, "わたし").await;
        let theirs = account(&backend.db, "ひと").await;
        let now = db::now_ms();
        push_at(&backend.db, mine, "1", now).await;
        push_at(&backend.db, mine, "2", now - 1).await;
        push_at(&backend.db, theirs, "ひとの", now).await;

        let marked = notices::mark_all_read(&backend.db, mine, now + 5)
            .await
            .expect("既読にできること");
        assert_eq!(marked, 2, "{}：印を付けた件数", backend.name);
        assert_eq!(
            notices::unread_count(&backend.db, mine).await.unwrap(),
            0,
            "{}：未読が残っている",
            backend.name
        );
        // **他人の未読は減らない**
        assert_eq!(
            notices::unread_count(&backend.db, theirs).await.unwrap(),
            1,
            "{}：他人の未読まで消している",
            backend.name
        );

        // 既読の時刻が入っていること（真偽値ではなく時刻で持つ。設計§4-1）
        let (rows, _) = notices::list_page(&backend.db, mine, None, 10)
            .await
            .unwrap();
        assert!(
            rows.iter().all(|r| r.read_at == Some(now + 5)),
            "{}：既読の時刻が入っていない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 消す道は自分のものにしか効かない() {
    for backend in common::backends("notices_remove").await {
        let mine = account(&backend.db, "わたし").await;
        let theirs = account(&backend.db, "ひと").await;
        let now = db::now_ms();
        let mine_id = push_at(&backend.db, mine, "わたしの", now).await;
        let theirs_id = push_at(&backend.db, theirs, "ひとの", now).await;

        // 他人のものを名指ししても消えない
        assert_eq!(
            notices::remove(&backend.db, mine, theirs_id).await.unwrap(),
            0,
            "{}：他人の知らせを消せてしまう",
            backend.name
        );
        assert_eq!(
            notices::remove(&backend.db, mine, mine_id).await.unwrap(),
            1,
            "{}：自分の知らせを消せない",
            backend.name
        );

        // 全消しも自分のぶんだけ
        push_at(&backend.db, mine, "もういちど", now).await;
        notices::clear(&backend.db, mine).await.unwrap();
        assert_eq!(
            notices::unread_count(&backend.db, theirs).await.unwrap(),
            1,
            "{}：全消しが他人まで巻き込んでいる",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 掃除は古いものを落とす() {
    for backend in common::backends("notices_sweep_days").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();
        push_at(&backend.db, account, "きのう", now - DAY_MS).await;
        push_at(&backend.db, account, "40日前", now - 40 * DAY_MS).await;

        let removed = notices::sweep(&backend.db, now, 30, 200)
            .await
            .expect("掃けること");
        assert_eq!(removed, 1, "{}：落とした件数", backend.name);

        let (rows, _) = notices::list_page(&backend.db, account, None, 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "{}", backend.name);
        assert_eq!(rows[0].message, "きのう", "{}：残す側を消している", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn 掃除は溢れたぶんを古い順に落とす() {
    for backend in common::backends("notices_sweep_rows").await {
        let account = account(&backend.db, "みほん").await;
        let now = db::now_ms();
        for i in 0..5i64 {
            push_at(&backend.db, account, &format!("{i}"), now - i).await;
        }

        // 上限3件。**古い2件が落ちる**
        let removed = notices::sweep(&backend.db, now, 30, 3)
            .await
            .expect("掃けること");
        assert_eq!(removed, 2, "{}：落とした件数", backend.name);

        let (rows, _) = notices::list_page(&backend.db, account, None, 10)
            .await
            .unwrap();
        let texts: Vec<&str> = rows.iter().map(|r| r.message.as_str()).collect();
        assert_eq!(
            texts,
            vec!["0", "1", "2"],
            "{}：新しいほうを残していない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 件数の上限はアカウントごとに数える() {
    for backend in common::backends("notices_sweep_per_account").await {
        let a = account(&backend.db, "あ").await;
        let b = account(&backend.db, "い").await;
        let now = db::now_ms();
        for i in 0..4i64 {
            push_at(&backend.db, a, &format!("a{i}"), now - i).await;
            push_at(&backend.db, b, &format!("b{i}"), now - i).await;
        }

        // 上限3。**合計8件だが、片方だけを見て消してはいけない**
        notices::sweep(&backend.db, now, 30, 3).await.unwrap();

        for (id, name) in [(a, "あ"), (b, "い")] {
            let (rows, _) = notices::list_page(&backend.db, id, None, 10).await.unwrap();
            assert_eq!(
                rows.len(),
                3,
                "{}：{name} の残り件数（他人の件数に巻き込まれている）",
                backend.name
            );
        }
        backend.finish().await;
    }
}

#[tokio::test]
async fn アカウントを消すと知らせも消える() {
    for backend in common::backends("notices_cascade").await {
        let account = account(&backend.db, "きえるひと").await;
        push_at(&backend.db, account, "のこらない", db::now_ms()).await;

        db::entity::accounts::Entity::delete_by_id(account)
            .exec(&backend.db)
            .await
            .expect("アカウントを消せること");

        let (rows, _) = notices::list_page(&backend.db, account, None, 10)
            .await
            .unwrap();
        assert!(
            rows.is_empty(),
            "{}：アカウントを消しても知らせが残っている",
            backend.name
        );
        backend.finish().await;
    }
}
