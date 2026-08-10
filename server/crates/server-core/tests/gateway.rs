//! セッションホストの受け口（セルフホスト化設計§4-1・§6-3、テスト計画フェーズ3）。
//!
//! **本物の WebSocket で叩く。** 版交渉もトークン照合も upgrade の前後に散っているので、
//! ハンドラだけを呼んでも「接続できるかどうか」は確かめられない。
//!
//! ここも SQLite と PostgreSQL の両方へ同じコードを通す（`make test-compose`）。
//! トークンの照合と PC の登録は DB を触るので、型の厳しさの違いが出る側にあたる。

#![allow(non_snake_case)]

mod common;

use protocol::{
    CardId, SessionMeta, SessionStatus,
    a2s::{A2S_PROTOCOL, A2S_VERSION, AgentMessage, BatchId, ServerToAgent},
};
use sea_orm::DatabaseConnection;
use server_core::{db::pairing, gateway::SessionHostHub, registry::SessionRegistry};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

use common::{SessionHostSocket, hello, meta};

const WINDOW: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(5);

/// 待ち受けているセッションホスト受け口。
struct TestGateway {
    addr: SocketAddr,
    hub: Arc<SessionHostHub>,
    registry: Arc<SessionRegistry>,
    task: tokio::task::JoinHandle<()>,
}

impl TestGateway {
    async fn start(db: DatabaseConnection) -> Self {
        let registry = SessionRegistry::load(db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let hub = SessionHostHub::new(db, Arc::clone(&registry));

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr = listener.local_addr().expect("待ち受け先を取れること");
        let router = server_core::gateway::agent_routes(Arc::clone(&hub));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        Self {
            addr,
            hub,
            registry,
            task,
        }
    }

    /// セッションホストとして繋ぐ。版とトークンは呼び出し側が決める（断られ方も試すため）。
    async fn connect(
        &self,
        token: Option<&str>,
        protocol: Option<&str>,
    ) -> Result<SessionHostSocket, tungstenite::Error> {
        let mut request = tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://{}/agent/ws",
            self.addr
        ))
        .expect("要求を組み立てられること");
        if let Some(protocol) = protocol {
            request.headers_mut().insert(
                "sec-websocket-protocol",
                protocol.parse().expect("ヘッダに載る値であること"),
            );
        }
        if let Some(token) = token {
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {token}")
                    .parse()
                    .expect("ヘッダに載る値であること"),
            );
        }
        let (socket, _) = tokio_tungstenite::connect_async(request).await?;
        Ok(SessionHostSocket { socket })
    }

    /// 名乗りまで済ませて繋ぐ（普通の使い方）。
    async fn connect_as(&self, token: &str, name: &str) -> SessionHostSocket {
        let mut socket = self
            .connect(Some(token), Some(A2S_PROTOCOL))
            .await
            .expect("繋げること");
        socket.send(&hello(name)).await;
        socket
    }
}

impl Drop for TestGateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 発行済みのトークンを1本用意する。**帰属の確認に要るのでアカウントIDも返す。**
async fn issue(db: &DatabaseConnection, account: &str) -> (String, Uuid) {
    let account_id = pairing::ensure_account(db, account)
        .await
        .expect("アカウントを用意できること");
    let token = pairing::issue_token(db, account_id, "テスト", pairing::TokenKind::Agent)
        .await
        .expect("トークンを発行できること");
    (token, account_id)
}

/// HTTP の応答コードを取り出す（繋げなかった理由の確認用）。
fn status_of(error: &tungstenite::Error) -> Option<u16> {
    match error {
        tungstenite::Error::Http(response) => Some(response.status().as_u16()),
        _ => None,
    }
}

#[tokio::test]
async fn 知らない版は接続の前に断られる() {
    // セッションホストは利用者の PC にあり更新が遅れがち。**繋がってから黙る**のが一番
    // たちが悪いので、upgrade の前に理由を返す（設計§4-1）
    for backend in common::backends("gw-version").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, _account_id) = issue(&backend.db, "テスト用").await;

        let error = gateway
            .connect(Some(&token), Some("adash-a2s-v0"))
            .await
            .err()
            .unwrap_or_else(|| panic!("[{}] 知らない版で繋がってしまった", backend.name));
        assert_eq!(status_of(&error), Some(400), "[{}]", backend.name);

        // 版を名乗らないものも同じ扱い
        let error = gateway
            .connect(Some(&token), None)
            .await
            .err()
            .unwrap_or_else(|| panic!("[{}] 版なしで繋がってしまった", backend.name));
        assert_eq!(status_of(&error), Some(400), "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn トークンが無い_不正_失効なら繋げない() {
    for backend in common::backends("gw-token").await {
        let gateway = TestGateway::start(backend.db.clone()).await;

        let error = gateway
            .connect(None, Some(A2S_PROTOCOL))
            .await
            .err()
            .unwrap_or_else(|| panic!("[{}] トークン無しで繋がった", backend.name));
        assert_eq!(status_of(&error), Some(401), "[{}]", backend.name);

        let error = gateway
            .connect(Some("adp_でたらめ"), Some(A2S_PROTOCOL))
            .await
            .err()
            .unwrap_or_else(|| panic!("[{}] 知らないトークンで繋がった", backend.name));
        assert_eq!(status_of(&error), Some(401), "[{}]", backend.name);

        // 失効させたトークンは、**それまで有効だったものでも**通らない
        let account_id = pairing::ensure_account(&backend.db, "失効テスト")
            .await
            .expect("アカウントを用意できること");
        let token =
            pairing::issue_token(&backend.db, account_id, "捨てる", pairing::TokenKind::Agent)
                .await
                .expect("発行できること");
        assert!(
            gateway
                .connect(Some(&token), Some(A2S_PROTOCOL))
                .await
                .is_ok(),
            "[{}] 有効なうちは繋がること",
            backend.name
        );

        let row = pairing::resolve_token(&backend.db, &token, pairing::TokenKind::Agent)
            .await
            .expect("引けること")
            .expect("有効であること");
        pairing::revoke_token(&backend.db, row.token_id)
            .await
            .expect("失効させられること");

        let error = gateway
            .connect(Some(&token), Some(A2S_PROTOCOL))
            .await
            .err()
            .unwrap_or_else(|| panic!("[{}] 失効済みで繋がった", backend.name));
        assert_eq!(status_of(&error), Some(401), "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 名乗ると_PC_が登録され同じ名前なら同じIDに戻る() {
    // 再起動のたびに新しい `agent_id` を振ると、**そのPCのカードの帰属が切れる**
    for backend in common::backends("gw-hello").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, _account_id) = issue(&backend.db, "テスト用").await;

        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        let first = socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;
        let ServerToAgent::Hello {
            protocol_version,
            agent_id,
            intervals,
            ..
        } = first
        else {
            unreachable!()
        };
        assert_eq!(protocol_version, A2S_VERSION, "[{}]", backend.name);
        assert_eq!(intervals.sync_secs, 20, "[{}] 既定の同期間隔", backend.name);

        // 繋ぎ直しても同じ ID
        drop(socket);
        let mut again = gateway.connect_as(&token, "仕事用ノート").await;
        let ServerToAgent::Hello { agent_id: same, .. } = again
            .wait_for("2度目の名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await
        else {
            unreachable!()
        };
        assert_eq!(same, agent_id, "[{}] 同じ PC が別物になった", backend.name);

        // 別名の PC は別の ID
        let mut other = gateway.connect_as(&token, "自宅のデスクトップ").await;
        let ServerToAgent::Hello {
            agent_id: different,
            ..
        } = other
            .wait_for("別 PC の名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await
        else {
            unreachable!()
        };
        assert_ne!(different, agent_id, "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 報告は記録層へ入り帰属は接続が決める() {
    for backend in common::backends("gw-report").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "みんとぶるー").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        let ServerToAgent::Hello { agent_id, .. } = socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await
        else {
            unreachable!()
        };

        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(card_id)),
            })
            .await;

        let listed = wait_for_listed(&gateway.registry, account_id, "1枚出る", |listed| {
            listed.len() == 1
        })
        .await;
        assert_eq!(listed[0].card_id, card_id, "[{}]", backend.name);
        assert_eq!(
            listed[0].agent_id,
            Some(agent_id),
            "[{}] 申告した PC ではなく接続の PC に帰属すること",
            backend.name
        );
        assert_eq!(
            listed[0].account.as_deref(),
            Some("みんとぶるー"),
            "[{}] 名乗ったアカウント名が通ってしまった",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 履歴のバッチは書けてから_ack_が返る() {
    // ack は「DB へ入った」の意味（設計§6-1）。ここが緩むと、セッションホストが
    // 書けていないものの位置を進めて履歴が欠ける
    for backend in common::backends("gw-ack").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;

        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(card_id)),
            })
            .await;
        socket
            .send(&AgentMessage::TranscriptBatch {
                batch_id: BatchId(1),
                card_id,
                nodes: vec![protocol::TreeNode {
                    id: protocol::NodeId("n1".to_string()),
                    parent: None,
                    node: protocol::Node::AssistantText {
                        text: "了解".to_string(),
                    },
                    ts: 1,
                    branch: 0,
                }],
            })
            .await;

        socket
            .wait_for("ack", |message| {
                matches!(message, ServerToAgent::BatchAck { batch_id } if *batch_id == BatchId(1))
            })
            .await;

        // ack を受け取った時点で、DB を見るだけの側からも読める
        let page = gateway
            .registry
            .transcript_page(account_id, card_id, None, 10)
            .await
            .expect("読めること");
        assert_eq!(page.nodes.len(), 1, "[{}] DB に入っていない", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 切断すると鮮度の印だけが落ちる() {
    // 「作業中」のまま固まらせない（要件2-3）。**状態は書き換えない**——最後に知って
    // いた状態＋接続断の印、が充足形（設計§6-3）
    for backend in common::backends("gw-offline").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;

        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(card_id)),
            })
            .await;
        let listed = wait_for_listed(
            &gateway.registry,
            account_id,
            "繋がっている",
            |listed| listed.len() == 1 && listed[0].agent_connected,
        )
        .await;
        assert_eq!(
            listed[0].status,
            SessionStatus::Working,
            "[{}]",
            backend.name
        );

        drop(socket);

        let listed = wait_for_listed(
            &gateway.registry,
            account_id,
            "接続断になる",
            |listed| listed.len() == 1 && !listed[0].agent_connected,
        )
        .await;
        assert_eq!(
            listed[0].status,
            SessionStatus::Working,
            "[{}] 状態まで書き換えている",
            backend.name
        );

        assert!(
            gateway.hub.connected().is_empty(),
            "[{}] 接続が残っている",
            backend.name
        );

        backend.finish().await;
    }
}

/// 一覧が条件を満たすまで待つ（報告は待ち行列と DB を通るので即座ではない）。
async fn wait_for_listed(
    registry: &Arc<SessionRegistry>,
    account_id: Uuid,
    what: &str,
    matches: impl Fn(&[SessionMeta]) -> bool,
) -> Vec<SessionMeta> {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let listed = registry.list(account_id);
        if matches(&listed) {
            return listed;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に一覧が {what} になりませんでした（{} 枚）",
            listed.len()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn 画面は種別を移し替えて配られ_見る人が居なくなると止まる() {
    // 設計§4-3・§7-4。サーバがするのは**種別の移し替えと番号を剥がすこと**だけで、
    // 中身（エスケープ列）は一切解釈しない。これが「フロント無改修」の中身にあたる
    for backend in common::backends("gw-screen").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;

        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(card_id)),
            })
            .await;
        wait_for_listed(&gateway.registry, account_id, "1枚出る", |listed| {
            listed.len() == 1
        })
        .await;

        // --- 見る人が現れた -------------------------------------------------
        let browser = server_core::gateway::RemoteSessionHost::new(Arc::clone(&gateway.hub));
        let (blank, mut frames) =
            server_core::session_host::SessionHost::subscribe_pty(&browser, card_id, 1, 100, 30)
                .unwrap_or_else(|| panic!("[{}] 端末を開けること", backend.name));
        assert!(
            protocol::frame::decode(&blank)
                .expect("分解できること")
                .payload
                .is_empty(),
            "[{}] リモートに“いまの生バイト”は無いはず",
            backend.name
        );

        let sub = socket
            .wait_for("画面の購読", |message| {
                matches!(message, ServerToAgent::SubScreen { .. })
            })
            .await;
        assert!(
            matches!(
                sub,
                ServerToAgent::SubScreen {
                    cols: 100,
                    rows: 30,
                    ..
                }
            ),
            "[{}] 端末の大きさが渡っていない: {sub:?}",
            backend.name
        );

        // --- 画面が流れる ---------------------------------------------------
        socket
            .send_screen(protocol::frame::FrameKind::ScreenFull, card_id, 7)
            .await;
        let received = tokio::time::timeout(TIMEOUT, frames.recv())
            .await
            .unwrap_or_else(|_| panic!("[{}] 画面が届きませんでした", backend.name))
            .expect("配信が生きていること");
        let frame = protocol::frame::decode(&received).expect("分解できること");
        assert_eq!(
            frame.kind,
            protocol::frame::FrameKind::PtySnapshot,
            "[{}] 全画面はブラウザ向けに 0x03 へ移し替える",
            backend.name
        );
        assert_eq!(
            frame.payload, b"\x1b[2J\x1b[Hhello",
            "[{}] 番号が剥がれていない（または中身をいじっている）",
            backend.name
        );

        socket
            .send_screen(protocol::frame::FrameKind::ScreenDiff, card_id, 8)
            .await;
        let received = tokio::time::timeout(TIMEOUT, frames.recv())
            .await
            .unwrap_or_else(|_| panic!("[{}] 差分が届きませんでした", backend.name))
            .expect("配信が生きていること");
        assert_eq!(
            protocol::frame::decode(&received)
                .expect("分解できること")
                .kind,
            protocol::frame::FrameKind::PtyOutput,
            "[{}] 差分はブラウザ向けに 0x01 へ移し替える",
            backend.name
        );

        // --- 2人目が入っても、1人残っていれば止めない ----------------------
        let _second =
            server_core::session_host::SessionHost::subscribe_pty(&browser, card_id, 2, 100, 30);
        socket
            .wait_for("2人目ぶんの購読", |message| {
                matches!(message, ServerToAgent::SubScreen { .. })
            })
            .await;
        server_core::session_host::SessionHost::release_client(&browser, card_id, 1);

        // --- 最後の1人が去ったら止める --------------------------------------
        server_core::session_host::SessionHost::release_client(&browser, card_id, 2);
        let stop = socket
            .wait_for("画面の停止", |message| {
                matches!(message, ServerToAgent::UnsubScreen { .. })
            })
            .await;
        assert!(
            matches!(stop, ServerToAgent::UnsubScreen { card_id: stopped } if stopped == card_id),
            "[{}] 別のカードを止めています: {stop:?}",
            backend.name
        );

        backend.finish().await;
    }
}
