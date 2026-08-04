//! 記録層の振る舞い（セルフホスト化設計§3-2・§3-3）。
//!
//! セッションホストの報告を受けて「DB へ書いてからブラウザへ配る」（§9-1）ところを、
//! 報告を直に流し込んで確かめる。**SQLite と PostgreSQL の両方へ同じコードを通す**。

#![allow(non_snake_case)]

mod common;

use protocol::{
    CardId, Node, NodeId, ProjectId, SessionMeta, SessionStatus, TreeNode, ws::ServerMessage,
};
use server_core::registry::{ReportOrigin, SessionRegistry};

const WINDOW: usize = 100;

/// このテストの報告はすべてローカルモードの出どころから来る。
///
/// **セルフホストの出どころ（PC 付き）は `crates/core/tests/a2s.rs` が受け持つ** —— 記録層の
/// 側から見ると違いは `agent_id` が入るかどうかだけで、ここで確かめたいのは書き込みの
/// 順序と門であるため。
fn local() -> ReportOrigin {
    ReportOrigin::local()
}

fn meta(card_id: CardId) -> SessionMeta {
    SessionMeta {
        card_id,
        project: ProjectId("/tmp/project".to_string()),
        claude_session_id: None,
        permission_mode: None,
        model: None,
        model_label: None,
        model_requested: None,
        status: SessionStatus::Working,
        subagent_active: 0,
        last_activity_at: 1,
        last_assistant_message: None,
        created_at: 1,
        hooks_seen: false,
        agent_id: None,
        agent_connected: true,
        account: None,
        toml_account: None,
    }
}

fn upsert(card_id: CardId) -> ServerMessage {
    ServerMessage::SessionUpsert {
        session: Box::new(meta(card_id)),
    }
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
async fn 報告は書いてから配られる() {
    // 配信を受け取った時点で DB に入っていること（設計§9-1）。逆だと、ブラウザには
    // 出ているのに再読み込みで消えるという嘘になる
    for backend in common::backends("apply").await {
        let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let mut events = registry.subscribe_events();
        let card_id = CardId::new();

        registry.apply(&local(), upsert(card_id)).await;

        let event = events.recv().await.expect("配信されること");
        assert_eq!(
            event.account_id,
            server_core::db::LOCAL_ACCOUNT_ID,
            "[{}] 誰のカードの話かが添えられていない",
            backend.name
        );
        assert!(
            matches!(event.message, ServerMessage::SessionUpsert { .. }),
            "[{}] 実際: {:?}",
            backend.name,
            event.message
        );
        // 配信を受け取った時点で、別に立てた記録層（＝DB だけを見る側）にも見えている
        let other = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("同じ DB から立て直せること");
        assert_eq!(
            other.list(server_core::db::LOCAL_ACCOUNT_ID).len(),
            1,
            "[{}] DB に入っていない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 外したカードは後から届いた報告で戻らない() {
    // **回帰テスト。** 外す（archive）と記録は落ちるが、報告の待ち行列にはまだその
    // カードのぶんが残っている（切替の結果配信・見張りの1周・処理中のフック）。
    // それを素直に取り込むと記録が作り直され、消したはずのカードが一覧へ戻る。
    //
    // 実際に E2E がこれで壊れた——片付けたはずのカードが次のテストへ漏れ、
    // 通しで流すと一覧の枚数が合わなくなる形で出た
    for backend in common::backends("archived").await {
        let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let card_id = CardId::new();

        registry.apply(&local(), upsert(card_id)).await;
        assert_eq!(
            registry.list(server_core::db::LOCAL_ACCOUNT_ID).len(),
            1,
            "[{}]",
            backend.name
        );

        registry
            .apply(&local(), ServerMessage::SessionRemoved { card_id })
            .await;
        assert!(
            registry.list(server_core::db::LOCAL_ACCOUNT_ID).is_empty(),
            "[{}] 外れていない",
            backend.name
        );

        // 遅れて届いた報告
        registry.apply(&local(), upsert(card_id)).await;
        assert!(
            registry.list(server_core::db::LOCAL_ACCOUNT_ID).is_empty(),
            "[{}] 外したカードが戻ってきた",
            backend.name
        );

        // 立て直しても戻らない（DB 側にも外した印が残っている）
        let again = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("立て直せること");
        assert!(
            again.list(server_core::db::LOCAL_ACCOUNT_ID).is_empty(),
            "[{}] 再起動で戻ってきた",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 再起動しても履歴は残り接続していない印が付く() {
    // 利用者判断：戻ってきたカードは一覧に出す。ただし PTY は道連れで死んでいるので、
    // **鮮度が落ちていること**を `agent_connected=false` で示す（設計§6-3 と同型）
    for backend in common::backends("restore").await {
        let card_id = CardId::new();
        {
            let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
                .await
                .expect("記録層を立てられること");
            registry.apply(&local(), upsert(card_id)).await;
            registry
                .apply(
                    &local(),
                    ServerMessage::TranscriptAppend {
                        card_id,
                        nodes: vec![text_node("n1"), text_node("n2")],
                    },
                )
                .await;
        }

        // サーバだけを起動し直した状態
        let restored = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("立て直せること");

        let listed = restored.list(server_core::db::LOCAL_ACCOUNT_ID);
        assert_eq!(listed.len(), 1, "[{}] 復元されていない", backend.name);
        assert!(
            !listed[0].agent_connected,
            "[{}] 生きているように見えている",
            backend.name
        );
        // 状態そのものは書き換えない（最後の既知状態のまま）
        assert_eq!(
            listed[0].status,
            SessionStatus::Working,
            "[{}]",
            backend.name
        );

        // 履歴は読める。窓は DB の直近ぶんで満たされている
        let record = restored.get(card_id).expect("記録があること");
        let ids: Vec<String> = record
            .transcript_snapshot()
            .into_iter()
            .map(|node| node.id.0)
            .collect();
        assert_eq!(ids, ["n1", "n2"], "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 巻き戻りのあとも番号は最初から振り直される() {
    // 巻き戻し（/rewind）で全部消えるので、続きの番号から始めると並びに穴が空いたまま
    // 大きな値へ飛ぶ。消したなら番号も戻す
    for backend in common::backends("rewind").await {
        let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let card_id = CardId::new();
        registry.apply(&local(), upsert(card_id)).await;

        registry
            .apply(
                &local(),
                ServerMessage::TranscriptAppend {
                    card_id,
                    nodes: vec![text_node("a"), text_node("b")],
                },
            )
            .await;
        registry
            .apply(&local(), ServerMessage::TranscriptReset { card_id })
            .await;
        registry
            .apply(
                &local(),
                ServerMessage::TranscriptAppend {
                    card_id,
                    nodes: vec![text_node("c")],
                },
            )
            .await;

        let page = registry
            .transcript_page(server_core::db::LOCAL_ACCOUNT_ID, card_id, None, 10)
            .await
            .expect("読めること");
        let ids: Vec<String> = page.nodes.into_iter().map(|node| node.id.0).collect();
        assert_eq!(ids, ["c"], "[{}] 巻き戻りが効いていない", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 知らないカードの履歴は捨てる() {
    // 外した直後に届いたノードで一覧を汚さない
    for backend in common::backends("orphan").await {
        let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let card_id = CardId::new();

        registry
            .apply(
                &local(),
                ServerMessage::TranscriptAppend {
                    card_id,
                    nodes: vec![text_node("x")],
                },
            )
            .await;

        assert!(
            registry.list(server_core::db::LOCAL_ACCOUNT_ID).is_empty(),
            "[{}]",
            backend.name
        );
        assert_eq!(
            registry
                .transcript_page(server_core::db::LOCAL_ACCOUNT_ID, card_id, None, 10)
                .await
                .err(),
            Some(server_core::registry::PageError::NotFound),
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn モデルの3つは未設定のまま往復する() {
    // 設計§3-2 の論点表：切替中という一時状態（model_requested）も保存する。
    // DB の境界でフィールドを間引くと「どれが一時状態か」を知る第2の場所が生まれる。
    // 切断中に「切替要求中」という最後の既知状態が見えるのは §6-3 の哲学と同型で、
    // 再接続後の最初の SessionUpsert が自己修正する
    for backend in common::backends("model").await {
        let bare = CardId::new();
        let filled = CardId::new();
        {
            let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
                .await
                .expect("記録層を立てられること");
            registry.apply(&local(), upsert(bare)).await;

            let mut with_model = meta(filled);
            with_model.model = Some(protocol::ModelId::new("claude-opus-5"));
            with_model.model_label = Some("Opus 5".to_string());
            with_model.model_requested = Some(protocol::ModelId::new("sonnet"));
            registry
                .apply(
                    &local(),
                    ServerMessage::SessionUpsert {
                        session: Box::new(with_model),
                    },
                )
                .await;
        }

        let restored = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("立て直せること");

        let bare = restored.get(bare).expect("記録があること").meta();
        assert_eq!(bare.model, None, "[{}] 未設定が埋まった", backend.name);
        assert_eq!(bare.model_label, None, "[{}]", backend.name);
        assert_eq!(bare.model_requested, None, "[{}]", backend.name);

        let filled = restored.get(filled).expect("記録があること").meta();
        assert_eq!(
            filled.model.as_ref().map(protocol::ModelId::as_str),
            Some("claude-opus-5"),
            "[{}]",
            backend.name
        );
        assert_eq!(
            filled.model_label.as_deref(),
            Some("Opus 5"),
            "[{}]",
            backend.name
        );
        assert_eq!(
            filled
                .model_requested
                .as_ref()
                .map(protocol::ModelId::as_str),
            Some("sonnet"),
            "[{}] 切替中という一時状態が落ちた",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 実体が居ないカードもブラウザから外せる() {
    // **回帰テスト。** 外す指示は普段セッションホストへ頼むが、前回の起動が残したカードや
    // PC ごと落ちたあとのカードには頼む相手が居ない。行を消さない設計（履歴を残すため）
    // と噛み合うと、そういうカードは**一覧から二度と消せなくなる**——記録が残ることの
    // 利点ではなく害になる（compose で PC を落として実際に踏んだ）
    for backend in common::backends("archive-owned").await {
        let card_id = CardId::new();
        {
            let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
                .await
                .expect("記録層を立てられること");
            registry.apply(&local(), upsert(card_id)).await;
        }

        // 立て直す＝実体がどこにも居ない状態
        let restored = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("同じ DB から立て直せること");
        assert_eq!(restored.list(server_core::db::LOCAL_ACCOUNT_ID).len(), 1);

        restored
            .archive_owned(server_core::db::LOCAL_ACCOUNT_ID, card_id)
            .await
            .expect("外せること");
        assert!(
            restored.list(server_core::db::LOCAL_ACCOUNT_ID).is_empty(),
            "[{}] 外したのに一覧へ残っている",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 他人のカードは名指ししても外せない() {
    // 実体の居ないカードを外す口を開けたので、**そこにも持ち主の確認が要る**。
    // 無いと、IDを名指しするだけで他人のカードを一覧から消せる（§8-6）
    for backend in common::backends("archive-owned-cross").await {
        let registry = SessionRegistry::load(backend.db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let card_id = CardId::new();
        registry.apply(&local(), upsert(card_id)).await;

        let stranger = server_core::db::pairing::ensure_account(&backend.db, "他人")
            .await
            .expect("アカウントを用意できること");
        registry
            .archive_owned(stranger, card_id)
            .await
            .expect("問い合わせ自体は成功すること");

        assert_eq!(
            registry.list(server_core::db::LOCAL_ACCOUNT_ID).len(),
            1,
            "[{}] 他人に外されている",
            backend.name
        );

        backend.finish().await;
    }
}
