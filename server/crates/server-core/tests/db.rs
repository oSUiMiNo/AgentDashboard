//! 永続化層の単体検証（テスト計画フェーズ2）。
//!
//! **同じテストコードを SQLite と PostgreSQL の両方へ通す**（`common::backends`）。
//! 片方でしか出ない食い違い——型の厳密さ・JSON の扱い・主キーの制約——を、
//! ローカルで書いた段階で捕まえるのがこの並べ方の目的（設計§3-2）。

#![allow(non_snake_case)]

mod common;

use protocol::{CardId, Node, NodeId, SessionStatus, ToolStatus, TreeNode};
use sea_orm::{ActiveValue::Set, EntityTrait, PaginatorTrait as _};
use server_core::db::{self, entity, settings, transcript};

/// FK を満たすための最小のカード行。
///
/// `transcript_nodes` は `sessions` を参照するので、履歴だけ先に入れることはできない。
/// 実際の経路でも `SessionUpsert` が先に来る（設計§5-1）ので、順序はこれで正しい。
async fn seed_session(db: &sea_orm::DatabaseConnection, card_id: CardId) {
    let row = entity::sessions::ActiveModel {
        card_id: Set(card_id.0),
        agent_id: Set(None),
        account_id: Set(db::LOCAL_ACCOUNT_ID),
        project: Set("/tmp/project".to_string()),
        claude_session_id: Set(None),
        permission_mode: Set(None),
        model: Set(None),
        model_label: Set(None),
        model_requested: Set(None),
        status: Set(serde_json::to_value(SessionStatus::Working).unwrap()),
        subagent_active: Set(0),
        last_activity_at: Set(1),
        last_assistant_message: Set(None),
        created_at: Set(1),
        hooks_seen: Set(false),
        archived: Set(false),
        toml_account: Set(None),
    };
    entity::sessions::Entity::insert(row)
        .exec(db)
        .await
        .expect("カード行を入れられること");
}

fn text_node(id: &str) -> TreeNode {
    TreeNode {
        id: NodeId(id.to_string()),
        parent: None,
        node: Node::AssistantText {
            text: id.to_string(),
        },
        ts: 0,
        branch: 0,
    }
}

#[tokio::test]
async fn マイグレーションは空のDBから全表を作り再実行しても壊れない() {
    // 手作業ゼロでスキーマが揃うことが5分セットアップ（設計§14-4）の前提。
    // 冪等でないと、2回目の起動から先へ進めなくなる
    for backend in common::backends("migrate").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        // 同じ DB へ繋ぎ直す＝マイグレーションがもう一度走る
        let again = db::connect(&backend.url)
            .await
            .unwrap_or_else(|err| panic!("[{}] 2回目の接続で落ちた: {err}", backend.name));
        let count = entity::sessions::Entity::find()
            .count(&again)
            .await
            .expect("再接続後も読めること");
        assert_eq!(count, 1, "[{}] 再実行で行が消えた", backend.name);
        let _ = sea_orm::DatabaseConnection::close(again).await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn ローカルモードのアカウント行は起動時に用意される() {
    // `account_id` を NULL 許容にしないための土台（設計§8-6 の絞り込みを両モードで揃える）
    for backend in common::backends("account").await {
        let row = entity::accounts::Entity::find_by_id(db::LOCAL_ACCOUNT_ID)
            .one(&backend.db)
            .await
            .expect("読めること")
            .unwrap_or_else(|| panic!("[{}] ローカルアカウントが無い", backend.name));
        assert_eq!(row.name, db::LOCAL_ACCOUNT_NAME);
        assert!(
            row.password_hash.is_none(),
            "[{}] ログインできる形で作ってはいけない",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 同じノードを入れ直しても行は増えず内容だけ上書きされる() {
    // ツールコールは結果が届いた時点で同じIDで送り直される（upsert 契約）。
    // ここが破れると、切断からの復帰（設計§6-1 の再送）のたびに履歴が二重化する
    for backend in common::backends("upsert").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        let pending = TreeNode {
            id: NodeId("t1".to_string()),
            parent: None,
            node: Node::ToolCall {
                name: "Bash".to_string(),
                input: serde_json::json!({ "command": "ls" }),
                result: None,
                status: ToolStatus::Pending,
                subagent: None,
            },
            ts: 1,
            branch: 0,
        };
        let mut done = pending.clone();
        done.node = Node::ToolCall {
            name: "Bash".to_string(),
            input: serde_json::json!({ "command": "ls" }),
            result: Some(serde_json::json!("ok")),
            status: ToolStatus::Ok,
            subagent: None,
        };

        let mut next = transcript::next_seq(&backend.db, card_id).await.unwrap();
        transcript::append(&backend.db, card_id, &[pending], &mut next)
            .await
            .expect("1回目");
        // 送り直しは番号を進めた状態で来る（実際の経路と同じ）
        transcript::append(&backend.db, card_id, &[done.clone()], &mut next)
            .await
            .expect("2回目");

        let (nodes, _) = transcript::page(&backend.db, card_id, None, 100)
            .await
            .unwrap();
        assert_eq!(nodes.len(), 1, "[{}] 二重に積まれた", backend.name);
        assert_eq!(nodes[0], done, "[{}] 上書きされていない", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn 上書きしても並びは動かない() {
    // 番号を振り直すと、結果が届いただけの古いツールコールが末尾へ飛び、画面が飛ぶ
    for backend in common::backends("seqstable").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        let mut next = transcript::next_seq(&backend.db, card_id).await.unwrap();
        let first = text_node("n1");
        transcript::append(
            &backend.db,
            card_id,
            &[first.clone(), text_node("n2"), text_node("n3")],
            &mut next,
        )
        .await
        .unwrap();

        // n1 を送り直す
        let mut updated = first.clone();
        updated.node = Node::AssistantText {
            text: "更新".to_string(),
        };
        transcript::append(&backend.db, card_id, &[updated], &mut next)
            .await
            .unwrap();

        let (nodes, _) = transcript::page(&backend.db, card_id, None, 100)
            .await
            .unwrap();
        let ids: Vec<String> = nodes.iter().map(|node| node.id.0.clone()).collect();
        assert_eq!(ids, ["n1", "n2", "n3"], "[{}] 並びが動いた", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn seqの順で遡りが安定して返る() {
    for backend in common::backends("paging").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        let mut next = transcript::next_seq(&backend.db, card_id).await.unwrap();
        let nodes: Vec<TreeNode> = (0..10)
            .map(|index| text_node(&format!("n{index}")))
            .collect();
        transcript::append(&backend.db, card_id, &nodes, &mut next)
            .await
            .unwrap();

        // 起点なし＝最新から3件
        let (latest, has_more) = transcript::page(&backend.db, card_id, None, 3)
            .await
            .unwrap();
        let ids: Vec<String> = latest.iter().map(|node| node.id.0.clone()).collect();
        assert_eq!(ids, ["n7", "n8", "n9"], "[{}]", backend.name);
        assert!(has_more, "[{}] まだ前があるはず", backend.name);

        // n7 より前を3件
        let (before, has_more) =
            transcript::page(&backend.db, card_id, Some(&NodeId("n7".to_string())), 3)
                .await
                .unwrap();
        let ids: Vec<String> = before.iter().map(|node| node.id.0.clone()).collect();
        assert_eq!(ids, ["n4", "n5", "n6"], "[{}]", backend.name);
        assert!(has_more, "[{}]", backend.name);

        // 先頭まで遡ったら「もう無い」と言う
        let (head, has_more) =
            transcript::page(&backend.db, card_id, Some(&NodeId("n2".to_string())), 5)
                .await
                .unwrap();
        let ids: Vec<String> = head.iter().map(|node| node.id.0.clone()).collect();
        assert_eq!(ids, ["n0", "n1"], "[{}]", backend.name);
        assert!(!has_more, "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 未知の構造を含むノードがそのまま往復する() {
    // 寛容パース（初期実装§3）の美点を DB スキーマが壊さないことの直接検証。
    // 列へ分解すると、ここで未知フィールドが落ちる
    for backend in common::backends("unknown").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        let raw = serde_json::json!({
            "type": "brand_new_record",
            "nested": { "深い": [1, 2, { "まだ知らない": true }] },
        });
        let node = TreeNode {
            id: NodeId("u1".to_string()),
            parent: Some(NodeId("root".to_string())),
            node: Node::Unknown {
                record_type: "brand_new_record".to_string(),
                raw: raw.clone(),
            },
            ts: 42,
            branch: 3,
        };

        let mut next = transcript::next_seq(&backend.db, card_id).await.unwrap();
        transcript::append(&backend.db, card_id, std::slice::from_ref(&node), &mut next)
            .await
            .unwrap();

        let (nodes, _) = transcript::page(&backend.db, card_id, None, 10)
            .await
            .unwrap();
        assert_eq!(nodes, vec![node], "[{}] 往復で形が変わった", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn 巻き戻りでそのカードの履歴だけが消える() {
    for backend in common::backends("reset").await {
        let mine = CardId::new();
        let other = CardId::new();
        seed_session(&backend.db, mine).await;
        seed_session(&backend.db, other).await;

        let mut next = transcript::next_seq(&backend.db, mine).await.unwrap();
        transcript::append(&backend.db, mine, &[text_node("a")], &mut next)
            .await
            .unwrap();
        let mut next_other = transcript::next_seq(&backend.db, other).await.unwrap();
        transcript::append(&backend.db, other, &[text_node("b")], &mut next_other)
            .await
            .unwrap();

        transcript::reset(&backend.db, mine).await.unwrap();

        assert!(
            transcript::latest(&backend.db, mine, 10)
                .await
                .unwrap()
                .is_empty(),
            "[{}] 消えていない",
            backend.name
        );
        assert_eq!(
            transcript::latest(&backend.db, other, 10)
                .await
                .unwrap()
                .len(),
            1,
            "[{}] 巻き添えで消えた",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 番号は既にある行の続きから振られる() {
    // 再起動や再接続のあとに 0 から振り直すと、並びが壊れる
    for backend in common::backends("resume-seq").await {
        let card_id = CardId::new();
        seed_session(&backend.db, card_id).await;

        let mut next = transcript::next_seq(&backend.db, card_id).await.unwrap();
        transcript::append(
            &backend.db,
            card_id,
            &[text_node("n0"), text_node("n1")],
            &mut next,
        )
        .await
        .unwrap();

        // 別の起動を模して求め直す
        let mut fresh = transcript::next_seq(&backend.db, card_id).await.unwrap();
        assert_eq!(fresh, 2, "[{}] 続きから振っていない", backend.name);
        transcript::append(&backend.db, card_id, &[text_node("n2")], &mut fresh)
            .await
            .unwrap();

        let (nodes, _) = transcript::page(&backend.db, card_id, None, 10)
            .await
            .unwrap();
        let ids: Vec<String> = nodes.iter().map(|node| node.id.0.clone()).collect();
        assert_eq!(ids, ["n0", "n1", "n2"], "[{}]", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn 設定はアカウントとサーバ全体で別々に持てる() {
    // 設計§3-2 は主キーを (account_id nullable, key) としているが、PostgreSQL は
    // 主キーに NULL を許さない。nil UUID をサーバ全体スコープの印にしている
    for backend in common::backends("settings").await {
        // 選んでいない間は既定が返る（行を先に書かない。§13-3）
        let defaults = settings::intervals(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .unwrap();
        assert_eq!(
            defaults,
            settings::Intervals::default(),
            "[{}]",
            backend.name
        );
        assert!(
            settings::lan_password_hash(&backend.db)
                .await
                .unwrap()
                .is_none(),
            "[{}] 既定でパスワードが入っている",
            backend.name
        );

        settings::put(
            &backend.db,
            db::LOCAL_ACCOUNT_ID,
            settings::SYNC_INTERVAL_SECS,
            serde_json::json!(5),
        )
        .await
        .unwrap();
        settings::put(
            &backend.db,
            db::SERVER_SCOPE_ID,
            settings::LAN_PASSWORD_HASH,
            serde_json::json!("$argon2id$dummy"),
        )
        .await
        .unwrap();

        let chosen = settings::intervals(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .unwrap();
        assert_eq!(chosen.sync_interval_secs, 5, "[{}]", backend.name);
        // 選んでいないものは既定のまま
        assert_eq!(
            chosen.screen_interval_ms,
            settings::DEFAULT_SCREEN_INTERVAL_MS,
            "[{}]",
            backend.name
        );
        assert_eq!(
            settings::lan_password_hash(&backend.db).await.unwrap(),
            Some("$argon2id$dummy".to_string()),
            "[{}]",
            backend.name
        );
        // 同じキーへ書き直しても行は増えない（上書き）
        settings::put(
            &backend.db,
            db::LOCAL_ACCOUNT_ID,
            settings::SYNC_INTERVAL_SECS,
            serde_json::json!(60),
        )
        .await
        .unwrap();
        assert_eq!(
            settings::intervals(&backend.db, db::LOCAL_ACCOUNT_ID)
                .await
                .unwrap()
                .sync_interval_secs,
            60,
            "[{}]",
            backend.name
        );

        // 消したら既定へ戻る
        settings::remove(
            &backend.db,
            db::LOCAL_ACCOUNT_ID,
            settings::SYNC_INTERVAL_SECS,
        )
        .await
        .unwrap();
        assert_eq!(
            settings::intervals(&backend.db, db::LOCAL_ACCOUNT_ID)
                .await
                .unwrap()
                .sync_interval_secs,
            settings::DEFAULT_SYNC_INTERVAL_SECS,
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}

/// ログインセッションの置き場所（設計§8-2）。**結線はフェーズ5**だが、置き場所は
/// 統合前に単体で固める（テスト計画F2）。
mod ログインセッション {
    use super::*;
    use server_core::db::web_session_store::DbSessionStore;
    use std::collections::HashMap;
    use time::OffsetDateTime;
    use tower_sessions::session::{Id, Record};
    use tower_sessions::session_store::{ExpiredDeletion, SessionStore};

    fn record(id: i128, expires_in_secs: i64) -> Record {
        Record {
            id: Id(id),
            data: HashMap::from([("who".to_string(), serde_json::json!("mao"))]),
            expiry_date: OffsetDateTime::now_utc() + time::Duration::seconds(expires_in_secs),
        }
    }

    #[tokio::test]
    async fn 作って読んで書き換えて消せる() {
        for backend in common::backends("websession").await {
            let store = DbSessionStore::new(backend.db.clone());
            let mut row = record(1, 3600);

            store.create(&mut row).await.expect("作れること");
            let loaded = store
                .load(&row.id)
                .await
                .expect("読めること")
                .unwrap_or_else(|| panic!("[{}] 作った直後に読めない", backend.name));
            assert_eq!(loaded.data, row.data, "[{}]", backend.name);

            row.data
                .insert("who".to_string(), serde_json::json!("別の人"));
            store.save(&row).await.expect("書き換えられること");
            assert_eq!(
                store.load(&row.id).await.unwrap().unwrap().data,
                row.data,
                "[{}] 書き換えが効いていない",
                backend.name
            );

            store.delete(&row.id).await.expect("消せること");
            assert!(
                store.load(&row.id).await.unwrap().is_none(),
                "[{}] 消えていない",
                backend.name
            );

            backend.finish().await;
        }
    }

    #[tokio::test]
    async fn 期限切れは掃除を待たずに読めなくなる() {
        // 掃除は1時間ごと。その間に失効したセッションが通ると TTL（設計§8-3 の5時間）が
        // 意味を失う
        for backend in common::backends("expiry").await {
            let store = DbSessionStore::new(backend.db.clone());
            let mut alive = record(10, 3600);
            let mut dead = record(11, -60);
            store.create(&mut alive).await.unwrap();
            store.create(&mut dead).await.unwrap();

            assert!(
                store.load(&dead.id).await.unwrap().is_none(),
                "[{}] 期限切れが読めてしまう",
                backend.name
            );
            assert!(
                store.load(&alive.id).await.unwrap().is_some(),
                "[{}] 生きているセッションまで消えた",
                backend.name
            );

            // 掃除は期限切れだけを落とす（溜まり続けないため）
            store.delete_expired().await.expect("掃除できること");
            assert!(
                store.load(&alive.id).await.unwrap().is_some(),
                "[{}] 掃除が巻き添えにした",
                backend.name
            );

            backend.finish().await;
        }
    }

    #[tokio::test]
    async fn 既にあるIDを踏んだら採番し直す() {
        // 上書きにすると、たまたま同じIDが出たときに**他人のセッションを乗っ取る**。
        // トレイトが create と save を分けているのはこのため
        for backend in common::backends("collision").await {
            let store = DbSessionStore::new(backend.db.clone());
            let mut first = record(42, 3600);
            store.create(&mut first).await.unwrap();

            let mut collided = record(42, 3600);
            collided
                .data
                .insert("who".to_string(), serde_json::json!("あとから来た人"));
            store.create(&mut collided).await.unwrap();

            assert_ne!(
                collided.id, first.id,
                "[{}] 採番し直していない",
                backend.name
            );
            assert_eq!(
                store.load(&first.id).await.unwrap().unwrap().data,
                first.data,
                "[{}] 先にあったセッションが書き換わった",
                backend.name
            );

            backend.finish().await;
        }
    }
}
