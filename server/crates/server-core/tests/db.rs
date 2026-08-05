//! 永続化層の単体検証（テスト計画フェーズ2）。
//!
//! **同じテストコードを SQLite と PostgreSQL の両方へ通す**（`common::backends`）。
//! 片方でしか出ない食い違い——型の厳密さ・JSON の扱い・主キーの制約——を、
//! ローカルで書いた段階で捕まえるのがこの並べ方の目的（設計§3-2）。

#![allow(non_snake_case)]

mod common;

use protocol::{AgentId, CardId, Node, NodeId, SessionStatus, ToolStatus, TreeNode};
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
async fn 更新確認を切る設定はサーバ全体で持つ() {
    // アカウント単位に持つと「片方が切ったのにもう片方の画面にボタンが出る」という
    // 食い違いが生まれる。更新すれば全員に効くので、持ち場もサーバ全体（CICD 設計§8）
    for backend in common::backends("update-check").await {
        // 行が無い＝既定（見に行く）
        assert!(
            settings::update_check_enabled(&backend.db).await.unwrap(),
            "[{}] 既定で見に行かないことになっている",
            backend.name
        );

        settings::set_update_check_enabled(&backend.db, false)
            .await
            .unwrap();
        assert!(
            !settings::update_check_enabled(&backend.db).await.unwrap(),
            "[{}] 切ったのに効いていない",
            backend.name
        );

        // アカウント側へ同じ綴りで書いても、サーバ全体の答えは動かない
        settings::put(
            &backend.db,
            db::LOCAL_ACCOUNT_ID,
            settings::UPDATE_CHECK_ENABLED,
            serde_json::json!(true),
        )
        .await
        .unwrap();
        assert!(
            !settings::update_check_enabled(&backend.db).await.unwrap(),
            "[{}] アカウント側の行に引きずられている",
            backend.name
        );

        // 消せば既定へ戻る
        settings::remove(
            &backend.db,
            db::SERVER_SCOPE_ID,
            settings::UPDATE_CHECK_ENABLED,
        )
        .await
        .unwrap();
        assert!(
            settings::update_check_enabled(&backend.db).await.unwrap(),
            "[{}] 消しても既定へ戻らない",
            backend.name
        );
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

/// 枠の自動起動は、行が無いあいだ既定で読める（イシューグループ_2026_0805_0514 §12）。
///
/// `always_bypass_permissions` と違って **PC 側に初期値の出どころが無い**ので、
/// `Option` ではなく既定で埋めて返す形になっている。ここが `None` を返す作りに
/// 変わると、画面が「まだ選んでいない」を扱う羽目になる。
#[tokio::test]
async fn 枠の自動起動は行が無ければ既定で読める() {
    for backend in common::backends("autostart").await {
        assert!(
            !settings::project_autostart_session(&backend.db, db::LOCAL_ACCOUNT_ID).await,
            "[{}] 行が無いのに ON で読めた",
            backend.name
        );

        settings::set_project_autostart_session(&backend.db, db::LOCAL_ACCOUNT_ID, true)
            .await
            .unwrap();
        assert!(
            settings::project_autostart_session(&backend.db, db::LOCAL_ACCOUNT_ID).await,
            "[{}] 書いた値が読めない",
            backend.name
        );

        // 消したら既定へ戻る（行が無いことに意味がある、という約束）
        settings::remove(
            &backend.db,
            db::LOCAL_ACCOUNT_ID,
            settings::PROJECT_AUTOSTART_SESSION,
        )
        .await
        .unwrap();
        assert!(
            !settings::project_autostart_session(&backend.db, db::LOCAL_ACCOUNT_ID).await,
            "[{}] 消しても ON のまま",
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

/// 版を戻すときの門が使う、スキーマの名前の口（CICD設計§9）。
mod スキーマの名前 {
    use super::*;
    use sea_orm::ConnectionTrait as _;

    /// 「適用済みだが、この実行ファイルは知らない」形を1件だけ作る。
    async fn 知らないものを適用済みにする(
        db: &sea_orm::DatabaseConnection,
    ) -> String {
        let unknown = "m99999999_000099_知らない形".to_string();
        db.execute_unprepared(&format!(
            "INSERT INTO seaql_migrations (version, applied_at) VALUES ('{unknown}', 0)"
        ))
        .await
        .expect("記録の表へ書けること");
        unknown
    }

    #[tokio::test]
    async fn 自分が知っている名前を並べられる() {
        let names = db::migration_names();
        assert!(!names.is_empty(), "1つも知らないことはない");
        assert!(
            names.iter().all(|name| name.starts_with('m')),
            "ファイル名がそのまま名前になる: {names:?}"
        );
    }

    #[tokio::test]
    async fn 当てたあとは知っている名前と適用済みが揃う() {
        for backend in common::backends("names").await {
            let mut applied = db::applied_migration_names(&backend.db).await.unwrap();
            let mut known = db::migration_names();
            applied.sort();
            known.sort();
            assert_eq!(applied, known, "[{}] 揃っていない", backend.name);
            backend.finish().await;
        }
    }

    #[tokio::test]
    async fn 知らないものが適用済みでも生の行は読める() {
        // **整った形で返すほう（get_applied_migrations）は、まさにこの状況で落ちる。**
        // 門は「知らないものが適用済みか」を見たいので、記録の行をそのまま読む必要がある
        for backend in common::backends("raw").await {
            let unknown = 知らないものを適用済みにする(&backend.db).await;

            let applied = db::applied_migration_names(&backend.db)
                .await
                .unwrap_or_else(|err| panic!("[{}] 生の行すら読めない: {err}", backend.name));

            assert!(
                applied.contains(&unknown),
                "[{}] 知らないものが落ちている: {applied:?}",
                backend.name
            );
            backend.finish().await;
        }
    }

    #[tokio::test]
    async fn 知らないものが適用済みなら繋ぎ直せない() {
        // 後退の症状は**静かな破損ではなく「起動できない」**（設計§20-3）。
        // だから門の目的は破損を防ぐことではなく、袋小路を作らないことになる
        for backend in common::backends("stuck").await {
            知らないものを適用済みにする(&backend.db).await;

            let err = db::connect(&backend.url)
                .await
                .err()
                .unwrap_or_else(|| panic!("[{}] 繋げてしまった", backend.name));
            assert!(
                err.to_string().contains("スキーマを適用できません"),
                "[{}] 断り方が変わった: {err}",
                backend.name
            );
            backend.finish().await;
        }
    }
}

// --- PJT 枠（イシューグループ_2026_0805_0514 設計§2・§3）-----------------------

/// 枠を確かめるためのカード行。`archived` と時刻と宛先を指定できる。
async fn seed_card(
    db: &sea_orm::DatabaseConnection,
    agent_id: Option<uuid::Uuid>,
    project: &str,
    created_at: i64,
    archived: bool,
) {
    let row = entity::sessions::ActiveModel {
        card_id: Set(CardId::new().0),
        agent_id: Set(agent_id),
        account_id: Set(db::LOCAL_ACCOUNT_ID),
        project: Set(project.to_string()),
        claude_session_id: Set(None),
        permission_mode: Set(None),
        model: Set(None),
        model_label: Set(None),
        model_requested: Set(None),
        status: Set(serde_json::to_value(SessionStatus::Working).unwrap()),
        subagent_active: Set(0),
        last_activity_at: Set(created_at),
        last_assistant_message: Set(None),
        created_at: Set(created_at),
        hooks_seen: Set(false),
        archived: Set(archived),
        toml_account: Set(None),
    };
    entity::sessions::Entity::insert(row)
        .exec(db)
        .await
        .expect("カード行を入れられること");
}

/// 枠の表だけを「まだ無い」状態へ戻す。
///
/// **製品コードへ検証用の口を増やさずに済ませるための手口。** 表を落として適用済みの
/// 記録を消せば、次に繋いだときにその1本だけがもう一度走る——つまり**本物の
/// マイグレーションが本物のカードを見て作り直す**ところを、そのまま観察できる。
async fn 枠の表を巻き戻す(db: &sea_orm::DatabaseConnection) {
    use sea_orm::ConnectionTrait as _;

    let version = db::migration_names()
        .into_iter()
        .find(|name| name.contains("projects"))
        .expect("枠のマイグレーションが一覧に居ること");
    db.execute_unprepared("DROP TABLE projects")
        .await
        .expect("枠の表を落とせること");
    db.execute_unprepared(&format!(
        "DELETE FROM seaql_migrations WHERE version = '{version}'"
    ))
    .await
    .expect("適用済みの記録を消せること");
}

#[tokio::test]
async fn 同じ枠を二度足しても増えない() {
    // 二重に押したときに増えないことを、判定ではなくユニーク索引で担保している。
    // 判定に頼ると、並行して押されたときにすり抜ける
    for backend in common::backends("proj-dup").await {
        let path = "/home/example/dev/app";
        let first = db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, 10)
            .await
            .expect("足せること");
        let again = db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, 20)
            .await
            .expect("二度目も断られないこと");

        assert_eq!(first.id, again.id, "[{}] 別の行ができた", backend.name);
        // **既にある行をそのまま返す**（画面はこの id で消しにくる）
        assert_eq!(first.created_at, again.created_at);
        let rows = db::projects::list(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        assert_eq!(rows.len(), 1, "[{}] 行が増えた", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn pcが違えば同じパスでも別の枠になる() {
    // 枠の同一性は「PC ＋ パス」（利用者判断）。ここが破れると、どの PC の枠なのかが
    // 分からなくなり、「+」を押したときの宛先も決まらない
    for backend in common::backends("proj-host").await {
        let path = "/home/osuim/Dev/App";
        let a = AgentId(uuid::Uuid::new_v4());
        let b = AgentId(uuid::Uuid::new_v4());

        db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, Some(a), path, 1)
            .await
            .expect("足せること");
        db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, Some(b), path, 2)
            .await
            .expect("足せること");
        // ローカル（番兵）もまた別の枠
        db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, 3)
            .await
            .expect("足せること");

        let rows = db::projects::list(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        assert_eq!(rows.len(), 3, "[{}] 同じ枠に混ざった", backend.name);
        backend.finish().await;
    }
}

#[tokio::test]
async fn ローカルの枠は番兵で1つに揃う() {
    // **NULL を許すと PostgreSQL では NULL 同士が別物と扱われ、二重に入る。**
    // 番兵にしてあるのはそれを避けるため
    for backend in common::backends("proj-local").await {
        let path = "/home/example/dev/app";
        db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, 1)
            .await
            .expect("足せること");
        db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, 2)
            .await
            .expect("足せること");

        let rows = db::projects::list(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        assert_eq!(
            rows.len(),
            1,
            "[{}] ローカルの枠が二重に入った",
            backend.name
        );
        assert_eq!(rows[0].agent_id, db::projects::LOCAL_AGENT);
        assert_eq!(db::projects::from_column(rows[0].agent_id), None);
        backend.finish().await;
    }
}

#[test]
fn 番兵の綴りは1箇所にしか無い() {
    // 目視の約束にすると、次に触った人が2箇所目を作る。**同じ nil でも意味が違う**
    // （サーバ全体の印と、PC という単位が無いこと）ので、綴りを散らすと片方だけ直る
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("ソースを読めること") {
            let path = entry.expect("項目を読めること").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && std::fs::read_to_string(&path)
                    .expect("読めること")
                    .contains("Uuid::nil()")
            {
                found.push(
                    path.strip_prefix(&src)
                        .expect("src の下")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    found.sort();
    assert_eq!(
        found,
        vec!["db/mod.rs".to_string(), "db/projects.rs".to_string()],
        "nil UUID の綴りが増えている。意味の違う nil を共有していないか確かめること"
    );
}

#[tokio::test]
async fn 作り直しは外していないカードから枠を起こす() {
    // これが無いと、版を上げた利用者の画面から枠が消える。しかも「消えた」ではなく
    // 「セッションが終わったら消える枠」に戻るので、原因が版上げにあると気づけない
    for backend in common::backends("proj-backfill").await {
        枠の表を巻き戻す(&backend.db).await;

        let agent = uuid::Uuid::new_v4();
        // カードは PC の行を参照するので、先に登録しておく
        entity::agents::Entity::insert(entity::agents::ActiveModel {
            id: Set(agent),
            account_id: Set(db::LOCAL_ACCOUNT_ID),
            name: Set("仕事用ノート".to_string()),
            created_at: Set(1),
            last_seen_at: Set(None),
            model_table: Set(None),
            capabilities: Set(None),
        })
        .exec(&backend.db)
        .await
        .expect("PC を登録できること");

        // 同じ組のカードが2枚。**古いほうの時刻が枠の時刻になる**
        seed_card(&backend.db, Some(agent), "/home/example/a", 300, false).await;
        seed_card(&backend.db, Some(agent), "/home/example/a", 100, false).await;
        // ローカル（`agent_id` が NULL）は番兵へ読み替わる
        seed_card(&backend.db, None, "/home/example/b", 200, false).await;
        // **外したカードからは起こさない**
        seed_card(&backend.db, Some(agent), "/home/example/gone", 50, true).await;

        let again = db::connect(&backend.url)
            .await
            .unwrap_or_else(|err| panic!("[{}] 繋ぎ直せない: {err}", backend.name));
        let mut rows = db::projects::list(&again, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        rows.sort_by(|a, b| a.path.cmp(&b.path));

        let paths: Vec<&str> = rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["/home/example/a", "/home/example/b"],
            "[{}] 起こした枠が違う（外したカードから起こしていないか）",
            backend.name
        );
        assert_eq!(rows[0].agent_id, agent);
        assert_eq!(
            rows[0].created_at, 100,
            "[{}] いちばん古いカードの時刻になっていない",
            backend.name
        );
        assert_eq!(rows[1].agent_id, db::projects::LOCAL_AGENT);
        assert_eq!(rows[1].created_at, 200);

        let _ = sea_orm::DatabaseConnection::close(again).await;
        backend.finish().await;
    }
}

#[tokio::test]
async fn 作り直しはカードが1枚も無ければ何も起こさない() {
    // 新規の利用者がここを通る。空の DB で落ちると**初めて動かした人だけ**起動できない
    for backend in common::backends("proj-empty").await {
        枠の表を巻き戻す(&backend.db).await;

        let again = db::connect(&backend.url)
            .await
            .unwrap_or_else(|err| panic!("[{}] 繋ぎ直せない: {err}", backend.name));
        let rows = db::projects::list(&again, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        assert!(rows.is_empty(), "[{}] 何も無いのに枠ができた", backend.name);

        let _ = sea_orm::DatabaseConnection::close(again).await;
        backend.finish().await;
    }
}

#[tokio::test]
async fn 枠は持ち主で絞って読み書きされる() {
    // 帰属の判定を呼び出し側の心がけに任せない（設計§18）。ここで絞っておけば、
    // 書き忘れても他人のものは出てこない
    for backend in common::backends("proj-owner").await {
        let other = uuid::Uuid::new_v4();
        entity::accounts::Entity::insert(entity::accounts::ActiveModel {
            id: Set(other),
            name: Set("よそ".to_string()),
            password_hash: Set(None),
            is_admin: Set(false),
            created_at: Set(1),
        })
        .exec(&backend.db)
        .await
        .expect("よそのアカウントを作れること");

        let mine = db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, "/mine", 1)
            .await
            .expect("足せること");
        db::projects::add(&backend.db, other, None, "/theirs", 2)
            .await
            .expect("足せること");

        let rows = db::projects::list(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        assert_eq!(rows.len(), 1, "[{}] 他人の枠が混ざった", backend.name);

        // 他人の枠は引けないし消せない
        assert!(
            db::projects::get(&backend.db, other, mine.id)
                .await
                .expect("読めること")
                .is_none()
        );
        assert!(
            !db::projects::remove(&backend.db, other, mine.id)
                .await
                .expect("消せること")
        );
        assert!(
            db::projects::remove(&backend.db, db::LOCAL_ACCOUNT_ID, mine.id)
                .await
                .expect("消せること"),
            "[{}] 自分の枠は消せること",
            backend.name
        );
        backend.finish().await;
    }
}

#[tokio::test]
async fn 枠は追加した順に並ぶ() {
    // 一覧の箱が「最初に現れた順」で安定している既存の作りと揃える
    for backend in common::backends("proj-order").await {
        for (path, at) in [("/c", 30), ("/a", 10), ("/b", 20)] {
            db::projects::add(&backend.db, db::LOCAL_ACCOUNT_ID, None, path, at)
                .await
                .expect("足せること");
        }
        let rows = db::projects::list(&backend.db, db::LOCAL_ACCOUNT_ID)
            .await
            .expect("読めること");
        let paths: Vec<&str> = rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["/a", "/b", "/c"],
            "[{}] 並びが違う",
            backend.name
        );
        backend.finish().await;
    }
}
