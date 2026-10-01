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
use server_core::{
    db::pairing,
    gateway::SessionHostHub,
    registry::{NoticeLimits, SessionRegistry},
    session_host::SessionHost as _,
};
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
        let registry = SessionRegistry::load(db.clone(), WINDOW, None, NoticeLimits::default())
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

/// **軽い便が A2S を通って記録層まで届くこと**（レビュー対応 対応10）。
///
/// `gateway.rs` の `AgentMessage::ContextUsage` の腕には**テストが1本も無かった**。
/// 腕を空へ戻しても `make ci` は通り、**セルフホストの利用者だけが「出ない」と言う**
/// 状態だった——ローカルモードはこの経路を通らないので、開発中は気づけない。
#[tokio::test]
async fn 残量の軽い便はサーバまで届く() {
    for backend in common::backends("gw-ctx").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "みんとぶるー").await;
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

        socket
            .send(&AgentMessage::ContextUsage {
                card_id,
                usage: Some(protocol::ContextUsage {
                    used_percentage: 42,
                    total_input_tokens: 420_000,
                    context_window_size: 1_000_000,
                }),
            })
            .await;

        let listed = wait_for_listed(&gateway.registry, account_id, "残量が載る", |listed| {
            listed.first().is_some_and(|m| m.context_usage.is_some())
        })
        .await;
        assert_eq!(
            listed[0].context_usage.map(|u| u.used_percentage),
            Some(42),
            "[{}] 軽い便が記録層まで届いていない（腕が空）",
            backend.name
        );

        // **消える向きも通ること。** `/compact` の経路
        socket
            .send(&AgentMessage::ContextUsage {
                card_id,
                usage: None,
            })
            .await;
        let listed = wait_for_listed(
            &gateway.registry,
            account_id,
            "残量が消える",
            |listed| listed.first().is_some_and(|m| m.context_usage.is_none()),
        )
        .await;
        assert_eq!(listed[0].context_usage, None, "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 知らない種別が来ても線は切れない() {
    // **新しい PC ＋ 古いサーバ**の噛み合わせ（コンテキスト残量設計§2）。
    //
    // 版を上げずに種別を足せるのは、この耐性があるからである。ここが崩れると、
    // **PC を先に更新した利用者の線が切れ続ける**——しかも版交渉は通っているので、
    // 画面からは理由が分からない。
    //
    // 逆向き（古い PC ＋ 新しいサーバ）は、古い PC が新しい種別を**送らない**だけなので
    // 値が来ないまま「まだ分からない」で成立する。試すものが無い。
    for backend in common::backends("gw-unknown-kind").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "みんとぶるー").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;

        // 未来のセッションホストが増やした知らせ。**解釈できないが、落とさない**
        socket
            .send_raw(r#"{"t":"まだ知らない種別","card_id":"x"}"#)
            .await;

        // 線が生きている証拠は「**次の報告が普通に効くこと**」で見る。
        // 落としていたら、この報告はどこにも届かない
        let card_id = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(card_id)),
            })
            .await;

        let listed = wait_for_listed(
            &gateway.registry,
            account_id,
            "知らない種別のあとでも報告が通る",
            |listed| listed.len() == 1,
        )
        .await;
        assert_eq!(listed[0].card_id, card_id, "[{}]", backend.name);

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
                        error: false,
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

/// 受け取った指示を、届いた順に集める。
///
/// `wait_for` は条件に合わないものを読み飛ばすので、**順序を見る用には使えない**。
/// ここが見たいのは「約束が指示を追い越したか」なので、並びごと持って帰る。
async fn collect_in_order(
    socket: &mut SessionHostSocket,
    window: Duration,
    until: impl Fn(&[ServerToAgent]) -> bool,
) -> Vec<ServerToAgent> {
    use futures_util::StreamExt as _;

    let deadline = tokio::time::Instant::now() + window;
    let mut received = Vec::new();
    while !until(&received) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, socket.socket.next()).await {
            Ok(Some(Ok(tungstenite::Message::Text(text)))) => {
                if let Ok(message) = serde_json::from_str::<ServerToAgent>(&text) {
                    received.push(message);
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => break,
        }
    }
    received
}

/// カードが接続表へ載るまで待つ。載る前に指示を積んでも宛先が引けない。
async fn wait_for_conn(
    gateway: &TestGateway,
    card_id: CardId,
) -> Arc<server_core::gateway::SessionHostConn> {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if let Some(conn) = gateway.hub.conn_for_card(card_id) {
            return conn;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内にカードが接続表へ載りませんでした"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn 指示が詰まっても_ack_は捨てられず先に出て線も切れない() {
    // このイシューそのもの（設計§5）。実機では ack が指示と同じ列に載っており、
    // 詰まった瞬間に捨てられて、セッションホストは同じ 1055 件を239回送り直した。
    //
    // **件数だけでは書き手を止められない。** 枠の19倍を送っても直す前のコードで
    // 全部 ack が返る（OS の送信バッファが吸うため。設計§8-2 の訂正）ので、
    // レーンを浅くしたうえで、**読まない相手へ大きな指示を積んで**実際に止める。
    for backend in common::backends("gw-lane").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        // **繋ぐ前に**浅くする。チャネルは接続ごとに1度だけ作られる
        gateway
            .hub
            .set_lane_depths(server_core::gateway::LaneDepths {
                promise: 8,
                command: 2,
            });

        let (token, _) = issue(&backend.db, "テスト用").await;
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
        let conn = wait_for_conn(&gateway, card_id).await;

        // --- 1. 読まない相手へ大きな指示を1通積んで、書き手を止める ---------
        //
        // **細切れに何通も積んでも止まらない。** 送信バッファが吸ってしまい、落ちるのは
        // 「レーンが埋まるほど書き手が遅い」だけになる（最初に書いた形がそれで、
        // ack は詰まりを一度も通らずに返っていた）。**1通をバッファより大きくする。**
        let browser = server_core::gateway::RemoteSessionHost::new(Arc::clone(&gateway.hub));
        server_core::session_host::SessionHost::send_input(
            &browser,
            card_id,
            "x".repeat(4 * 1024 * 1024),
            Vec::new(),
            false,
        )
        .await
        .expect("宛先が引けること");
        // 書き手がそれを掴む（＝レーンから消える）まで待つ。掴んだ時点で、相手が
        // 読み始めるまで書き終われない
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while conn.queued_command() > 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 書き手が大きな指示を掴みませんでした",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // 書き手が止まっている間に、指示のレーンを埋める。
        //
        // **印を付けて積む。** 追い越しを見るには「詰まっている最中に並んでいた指示」を
        // 名指しできないといけない——大きな指示（既に書き手が掴んだもの）と区別せずに
        // 「最後の指示」で測ると、**順序を決めている指定を外しても落ちない**（実際に
        // 落ちなかった）
        const NOKORI: &str = "のこり";
        const PUSHED: usize = 16;
        for _ in 0..PUSHED {
            server_core::session_host::SessionHost::send_input(
                &browser,
                card_id,
                NOKORI.to_string(),
                Vec::new(),
                false,
            )
            .await
            .expect("宛先が引けること");
        }
        assert_eq!(
            conn.queued_command(),
            2,
            "[{}] 指示のレーンが埋まっていない＝書き手が止まっていない。この形では何も確かめられない",
            backend.name
        );

        // --- 2. 詰まっている最中に履歴を送る --------------------------------
        for n in 1..=3u64 {
            socket
                .send(&AgentMessage::TranscriptBatch {
                    batch_id: BatchId(n),
                    card_id,
                    nodes: vec![protocol::TreeNode {
                        id: protocol::NodeId(format!("n{n}")),
                        parent: None,
                        node: protocol::Node::AssistantText {
                            text: format!("{n} 件目"),
                            error: false,
                        },
                        ts: n as i64,
                        branch: 0,
                    }],
                })
                .await;
        }

        // --- 3. 読む前に、ack が約束のレーンへ載ったことを確かめる ----------
        //
        // **ここがこの試験の要**である。指示のレーンが満杯（2件）のまま ack が3件
        // 積まれている——これが「約束は捨てられない」の実体で、直す前はここで
        // 捨てられていた。**確かめずに読み始めると、載る前に書き手が動き出して
        // 並びが競う**（実際に競って、順序の判定が実行のたびに変わった）。
        let acked = tokio::time::Instant::now() + TIMEOUT;
        while conn.queued_promise() < 3 {
            assert!(
                tokio::time::Instant::now() < acked,
                "[{}] ack が約束のレーンへ載りません（載っているのは {} 件）。捨てられている",
                backend.name,
                conn.queued_promise()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            conn.queued_command(),
            2,
            "[{}] 指示のレーンが空いた＝書き手が動き出している。追い越しを確かめられない",
            backend.name
        );

        // --- 4. ここで初めて読む。並びごと持って帰る ------------------------
        // **3件揃ったところで読むのをやめない。** 追い越しの証拠は「ack の**後ろ**に
        // 詰まっていた指示が残っていること」なので、そこまで読まないと並びが見えない
        let 残りか = |message: &ServerToAgent| matches!(message, ServerToAgent::SendInput { text, .. } if text == NOKORI);
        let received = collect_in_order(&mut socket, TIMEOUT, |so_far| {
            let all_acked = so_far
                .iter()
                .filter(|message| matches!(message, ServerToAgent::BatchAck { .. }))
                .count()
                == 3;
            all_acked && so_far.iter().any(残りか)
        })
        .await;

        let acks: Vec<usize> = received
            .iter()
            .enumerate()
            .filter(|(_, message)| matches!(message, ServerToAgent::BatchAck { .. }))
            .map(|(at, _)| at)
            .collect();
        let inputs: Vec<usize> = received
            .iter()
            .enumerate()
            .filter(|(_, message)| matches!(message, ServerToAgent::SendInput { .. }))
            .map(|(at, _)| at)
            .collect();
        let 残り: Vec<usize> = received
            .iter()
            .enumerate()
            .filter(|(_, message)| 残りか(message))
            .map(|(at, _)| at)
            .collect();

        // 約束は捨てられない（送った3件ぶんが揃う）
        assert_eq!(
            acks.len(),
            3,
            "[{}] ack が {} 件しか返っていない。詰まったときに捨てられている",
            backend.name,
            acks.len()
        );
        // 指示は従来どおり捨てられる（約束と入れ替わっていない）
        assert!(
            inputs.len() < PUSHED,
            "[{}] 指示が1件も捨てられていない（{} 件全部届いた）。書き手が止まっていないので、この試験は空振りしている",
            backend.name,
            inputs.len()
        );
        // 約束が先に出る（詰まっていた指示を**3件とも**追い越している）
        //
        // **「最初の ack が最後の指示より前」では弱い。** 順序を決めている指定を
        // 外しても、たまたま ack が1つ先に出れば通ってしまう（実際に通った）。
        // 詰まっていた指示の**先頭**より、**最後の ack** が前に出ていることを見る
        let first_left = *残り.first().unwrap_or_else(|| {
            panic!(
                "[{}] 詰まっていた指示が1件も届いていない。追い越しを確かめられない",
                backend.name
            )
        });
        let last_ack = *acks.last().expect("ack が1件も届いていない");
        assert!(
            last_ack < first_left,
            "[{}] 約束が指示に追い越されている（最後の ack {last_ack} / 詰まっていた指示の先頭 {first_left}）。約束のレーンが先に見られていない: {received:#?}",
            backend.name
        );

        // --- 5. 線は切れていない --------------------------------------------
        socket
            .send(&AgentMessage::TranscriptBatch {
                batch_id: BatchId(99),
                card_id,
                nodes: vec![protocol::TreeNode {
                    id: protocol::NodeId("n99".to_string()),
                    parent: None,
                    node: protocol::Node::AssistantText {
                        text: "まだ生きている".to_string(),
                        error: false,
                    },
                    ts: 99,
                    branch: 0,
                }],
            })
            .await;
        socket
            .wait_for("詰まりの後の ack", |message| {
                matches!(message, ServerToAgent::BatchAck { batch_id } if *batch_id == BatchId(99))
            })
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 照合のときだけ約束の列が満杯でも外したカードの取り下げは名乗り直しで届く() {
    // 寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー第8回 Astra 1。
    // PC が一覧から外したカードを名乗ると、サーバは照合して取り下げ（`Forget`）を送り直す。以前は
    // 約束の列が満杯だと送れずに**接続を保った**。次の生存確認より前に列が空けば接続は切れず、
    // そのカードが入力待ちで以後名乗らなければ、取り下げは二度と送られない——一覧に出ない
    // プロセスが残る。
    //
    // **偽の PC で作る。** 本物の PC は見張りが状態を変えて名乗り直すことがあり、壊れ方が隠れる。
    // 生存確認（10 秒ごと）にも頼らない：照合の直後に畳んだかを、次の報告を処理したかで見る
    for backend in common::backends("gw-reconcile-full").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        gateway
            .hub
            .set_lane_depths(server_core::gateway::LaneDepths {
                promise: 1,
                command: 2,
            });
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;
        let 外す = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(外す)),
            })
            .await;
        let conn = wait_for_conn(&gateway, 外す).await;
        let agent_id = conn.agent_id;

        // --- 1. 読まない PC へ大きな指示を積んで、書き手を止める ---------------
        let browser = server_core::gateway::RemoteSessionHost::new(Arc::clone(&gateway.hub));
        server_core::session_host::SessionHost::send_input(
            &browser,
            外す,
            "x".repeat(4 * 1024 * 1024),
            Vec::new(),
            false,
        )
        .await
        .expect("宛先が引けること");
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while conn.queued_command() > 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 書き手が大きな指示を掴みませんでした",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // --- 2. 約束の列（深さ1）を、害の無い取り下げ（PC に無いカード）で埋める ----
        // **Close で埋めない。** 列が空いたときに Close が出て接続が畳まれ、直す前のコードでも
        // 名乗り直しが起きる
        // **生存確認が先に居ることがある**（これも害の無い約束）。積めなくなるまで積む——書き手は
        // 止まっているので、深さぶんで止まる
        for _ in 0..8 {
            if !conn.send(&ServerToAgent::Forget {
                card_id: CardId::new(),
            }) {
                break;
            }
        }
        assert_eq!(
            conn.queued_promise(),
            1,
            "[{}] 約束の列が埋まっていない",
            backend.name
        );

        // --- 3. 記録の側だけで外す（外す知らせが PC へ届かなかった形） --------------
        gateway
            .registry
            .archive_owned(account_id, 外す)
            .await
            .expect("外せること");

        // --- 4. PC が外したカードを名乗り、続けて別のカードを名乗る -----------------
        // 報告は1本の接続で順に処理されるので、後のカードが載れば、前の照合は済んでいる
        let 後 = CardId::new();
        for card_id in [外す, 後] {
            socket
                .send(&AgentMessage::SessionUpsert {
                    session: Box::new(meta(card_id)),
                })
                .await;
        }
        let 畳んだ = || {
            gateway
                .hub
                .conn(agent_id)
                .is_none_or(|now| !Arc::ptr_eq(&now, &conn))
        };
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while gateway.registry.get(後).is_none() && !畳んだ() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 後のカードも載らず、接続も畳まれない",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            畳んだ(),
            "[{}] ★照合で取り下げを積めなかったのに接続を保っている（列が空いても、PC がそのカードを名乗らなければ二度と送られない）",
            backend.name
        );
        assert!(
            gateway.registry.get(後).is_none(),
            "[{}] 畳むと決めた後に、次の報告を処理している",
            backend.name
        );

        // --- 5. PC は繋ぎ直して手持ちを名乗り直す。空いた列から取り下げが届く ----------
        // 深さは既定へ戻す。深さ1のままだと、繋いだ直後の生存確認が列に居る間に照合の知らせが
        // 来て、それだけで満杯になる
        gateway
            .hub
            .set_lane_depths(server_core::gateway::LaneDepths::default());
        drop(socket);
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(外す)),
            })
            .await;
        socket
            .wait_for(
                "外したカードの取り下げ",
                |message| matches!(message, ServerToAgent::Forget { card_id } if *card_id == 外す),
            )
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 外したかを確かめられなかったカードはその後名乗らなくても確かめ直して片付ける() {
    確かめられなかったカードを片付ける(true).await;
}

#[tokio::test]
async fn 外したかを確かめられなかったカードは生存確認のたびに確かめ直す() {
    // 本番で確かめ直しを起こすのは生存確認の周期。急かす口と同じ確かめ直しを通るが、周期の側を
    // 外すと本番では二度と確かめ直さない。**時間で「来ない」とは言わない**——届くのを待つ
    確かめられなかったカードを片付ける(false).await;
}

async fn 確かめられなかったカードを片付ける(急かす: bool) {
    // 寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー第9回 Astra 3。
    // 照合（PC が外したカードを名乗ったときに `Forget` を送り直す所）で DB を読めないと、以前は
    // 「外していない」と同じに扱って何もしなかった。入力待ちのカードは以後名乗り直すとは限らない
    // ので、**DB が戻っても照合されず、外したカードのプロセスが残る**。
    //
    // DB の失敗は照合の読み取りにだけ1回差し込む。その後このカードは二度と名乗らない。確かめ直しは
    // 生存確認（10 秒ごと）の度に行うが、時間には頼らず急かす口で1回進める
    for backend in common::backends("gw-reconcile-db-error").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let mut socket = gateway.connect_as(&token, "仕事用ノート").await;
        socket
            .wait_for("名乗りの応答", |message| {
                matches!(message, ServerToAgent::Hello { .. })
            })
            .await;
        let 外す = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(外す)),
            })
            .await;
        let conn = wait_for_conn(&gateway, 外す).await;
        gateway
            .registry
            .archive_owned(account_id, 外す)
            .await
            .expect("外せること");

        gateway.registry.照合の読みを1回失敗させる();
        // 外したカードを名乗り、続けて別のカードを名乗る。後のカードが載れば、前の照合は済んでいる
        let 後 = CardId::new();
        for card_id in [外す, 後] {
            socket
                .send(&AgentMessage::SessionUpsert {
                    session: Box::new(meta(card_id)),
                })
                .await;
        }
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while gateway.registry.get(後).is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 後のカードが載らない",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            gateway.registry.照合の読みの失敗が使われた(),
            "[{}] 差し込んだ失敗が照合で使われていない（形を作れていない）",
            backend.name
        );

        // このカードはもう名乗らない。確かめ直しで片付く
        if 急かす {
            conn.確かめ直しを急かす();
        }
        let 期限 = if 急かす {
            TIMEOUT
        } else {
            // 生存確認は 10 秒ごと。1周ぶんと余裕を待つ
            Duration::from_secs(25)
        };
        // **待ち手の上限（10 秒）を使わない。** 生存確認の周期と同じ長さなので、負荷で揺れる
        let 期限 = tokio::time::Instant::now() + 期限;
        let mut 届いた = false;
        while let Ok(Some(Ok(frame))) =
            tokio::time::timeout_at(期限, futures_util::StreamExt::next(&mut socket.socket)).await
        {
            if let tungstenite::Message::Text(text) = frame
                && let Ok(ServerToAgent::Forget { card_id }) =
                    serde_json::from_str::<ServerToAgent>(&text)
                && card_id == 外す
            {
                届いた = true;
                break;
            }
        }
        assert!(
            届いた,
            "[{}] ★照合で一度 DB を読めなかったカードを、その後確かめ直していない（{}）",
            backend.name,
            if 急かす {
                "急かした"
            } else {
                "生存確認の周期"
            }
        );

        backend.finish().await;
    }
}

/// 外したカードを名乗らせ、照合の DB の読み取りを1回失敗させて、**確かめられなかったカード**
/// としてその接続に持たせる（実装レビュー第9回 Astra 3 の形）。
async fn 確かめられないカードを持たせる(
    gateway: &TestGateway,
    socket: &mut common::SessionHostSocket,
    account_id: Uuid,
) -> CardId {
    let card_id = CardId::new();
    socket
        .send(&AgentMessage::SessionUpsert {
            session: Box::new(meta(card_id)),
        })
        .await;
    wait_for_conn(gateway, card_id).await;
    gateway
        .registry
        .archive_owned(account_id, card_id)
        .await
        .expect("外せること");
    gateway.registry.照合の読みを1回失敗させる();
    socket
        .send(&AgentMessage::SessionUpsert {
            session: Box::new(meta(card_id)),
        })
        .await;
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !gateway.registry.照合の読みの失敗が使われた() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "差し込んだ失敗が照合で使われない（形を作れていない）"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    card_id
}

/// 繋いで名乗りの応答まで受け取り、生きたカードを1枚名乗らせる。
async fn 繋いで1枚名乗る(
    gateway: &TestGateway,
    token: &str,
) -> (
    common::SessionHostSocket,
    CardId,
    Arc<server_core::gateway::SessionHostConn>,
) {
    let mut socket = gateway.connect_as(token, "仕事用ノート").await;
    socket
        .wait_for("名乗りの応答", |message| {
            matches!(message, ServerToAgent::Hello { .. })
        })
        .await;
    let 生きている = CardId::new();
    socket
        .send(&AgentMessage::SessionUpsert {
            session: Box::new(meta(生きている)),
        })
        .await;
    let conn = wait_for_conn(gateway, 生きている).await;
    (socket, 生きている, conn)
}

/// 条件が満たされるまで待つ。満たされなければ `what` で落とす。
async fn 満ちるまで待つ(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !ok() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn 確かめ直しの_DB_の答えが遅くてもふだんの受信は続く() {
    // 寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー第10回 Astra 1。
    // 照合で確かめられなかったカードの確かめ直しを、接続の受信のループの中で1枚ずつ待っていた。
    // DB の答えが遅いと、その間この接続の生存確認も報告も止まり、**DB の不調が正常な PC の切断へ
    // 広がる**。確かめ直しの読み取りを止めた間も、ふだんの報告が処理されることを見る
    for backend in common::backends("gw-recheck-slow-db").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        // 止めている間に上限を過ぎないようにする（過ぎると、この試験が見たいものとは別の道へ行く）
        gateway
            .hub
            .set_recheck_limits(server_core::gateway::RecheckLimits {
                timeout: Duration::from_secs(60),
                parallel: 4,
            });
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let (mut socket, 生きている, conn) = 繋いで1枚名乗る(&gateway, &token).await;
        let 外す = 確かめられないカードを持たせる(&gateway, &mut socket, account_id).await;

        let 止め所 = gateway.registry.照合の読みを止める();
        conn.確かめ直しを急かす();
        満ちるまで待つ(
            "確かめ直しが DB の読み取りまで来ない（形を作れていない）",
            || 止め所.来た数() >= 1,
        )
        .await;

        // DB を使わない便（残量）と、DB に書いて ack を返す便（履歴）
        socket
            .send(&AgentMessage::ContextUsage {
                card_id: 生きている,
                usage: Some(protocol::ContextUsage {
                    used_percentage: 42,
                    total_input_tokens: 420_000,
                    context_window_size: 1_000_000,
                }),
            })
            .await;
        満ちるまで待つ(
            &format!(
                "[{}] ★確かめ直しの DB の答えを待つ間、接続の報告を処理していない（残量の便が届かない）",
                backend.name
            ),
            || {
                gateway
                    .registry
                    .get(生きている)
                    .is_some_and(|record| record.meta().context_usage.is_some())
            },
        )
        .await;
        socket
            .send(&AgentMessage::TranscriptBatch {
                batch_id: BatchId(1),
                card_id: 生きている,
                nodes: vec![protocol::TreeNode {
                    id: protocol::NodeId("n1".to_string()),
                    parent: None,
                    node: protocol::Node::AssistantText {
                        text: "まだ生きている".to_string(),
                        error: false,
                    },
                    ts: 1,
                    branch: 0,
                }],
            })
            .await;
        socket
            .wait_for("★（確かめ直しの DB の答えを待つ間、履歴の ack が返らない）BatchAck", |message| {
                matches!(message, ServerToAgent::BatchAck { batch_id } if *batch_id == BatchId(1))
            })
            .await;

        止め所.開ける();
        socket
            .wait_for(
                "DB が答えた後の取り下げ",
                |message| matches!(message, ServerToAgent::Forget { card_id } if *card_id == 外す),
            )
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 確かめ直しは同時に走らせる数に上限がある() {
    // 実装レビュー第10回 Astra 1。DB が遅い間に持っているカードを全部同時に問い合わせると、DB の
    // 接続を取り合ってふだんの報告の書き込みまで待たせる。同時に走らせる数を絞る
    for backend in common::backends("gw-recheck-parallel").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        gateway
            .hub
            .set_recheck_limits(server_core::gateway::RecheckLimits {
                timeout: Duration::from_secs(60),
                parallel: 2,
            });
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let (mut socket, _, conn) = 繋いで1枚名乗る(&gateway, &token).await;
        let mut 外す = Vec::new();
        for _ in 0..5 {
            外す.push(確かめられないカードを持たせる(&gateway, &mut socket, account_id).await);
        }

        let 止め所 = gateway.registry.照合の読みを止める();
        conn.確かめ直しを急かす();
        満ちるまで待つ(
            "確かめ直しが DB の読み取りまで来ない（形を作れていない）",
            || 止め所.来た数() >= 2,
        )
        .await;
        // 同時に始めるものは1回の巡りでまとめて門まで来る（試験は1本のスレッドで回る）。門が
        // 閉じている間は1つも終わらないので、3つ目が来るなら上限が効いていない
        assert_eq!(
            止め所.来た数(),
            2,
            "[{}] ★確かめ直しを上限（2）を超えて同時に走らせている",
            backend.name
        );

        止め所.開ける();
        let mut 届いた = std::collections::HashSet::new();
        while 届いた.len() < 外す.len() {
            if let ServerToAgent::Forget { card_id } = socket
                .wait_for("確かめ直した後の取り下げ", |message| {
                    matches!(message, ServerToAgent::Forget { card_id } if 外す.contains(card_id))
                })
                .await
            {
                届いた.insert(card_id);
            }
        }

        backend.finish().await;
    }
}

#[tokio::test]
async fn 確かめ直しが時間の上限を過ぎたら持ち続けて次の周で確かめる() {
    // 実装レビュー第10回 Astra 1。答えない DB を待ち続けると、確かめ直しの周が終わらず、次の周も
    // 始まらない。上限を過ぎたら「確かめられなかった」として持ち続け、次の周で確かめる
    for backend in common::backends("gw-recheck-timeout").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        gateway
            .hub
            .set_recheck_limits(server_core::gateway::RecheckLimits {
                timeout: Duration::from_millis(300),
                parallel: 4,
            });
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let (mut socket, _, conn) = 繋いで1枚名乗る(&gateway, &token).await;
        let 外す = 確かめられないカードを持たせる(&gateway, &mut socket, account_id).await;

        let 止め所 = gateway.registry.照合の読みを止める();
        conn.確かめ直しを急かす();
        満ちるまで待つ(
            "確かめ直しが DB の読み取りまで来ない（形を作れていない）",
            || 止め所.来た数() >= 1,
        )
        .await;
        // 次の周を急かす。上限を過ぎて前の周が終われば、もう一度読み取りまで来る
        conn.確かめ直しを急かす();
        満ちるまで待つ(
            &format!(
                "[{}] ★答えない DB を上限を過ぎても待ち続け、次の周の確かめ直しが始まらない",
                backend.name
            ),
            || 止め所.来た数() >= 2,
        )
        .await;

        止め所.開ける();
        conn.確かめ直しを急かす();
        socket
            .wait_for(
                "DB が答えた後の取り下げ",
                |message| matches!(message, ServerToAgent::Forget { card_id } if *card_id == 外す),
            )
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 名乗りの照合の_DB_の答えが遅くても時間の上限で受信へ戻る() {
    // 実装レビュー第10回 Astra 1。名乗りの照合は、名乗りの順を守るために接続の受信の中で行う
    // （畳むと決めたら次の報告を読まない。第8回 Astra 1）。ここで答えない DB を待ち続けると、この
    // 接続の受信が止まる。上限を過ぎたら確かめられなかったとして持ち続け、受信へ戻る
    for backend in common::backends("gw-reconcile-timeout").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        gateway
            .hub
            .set_recheck_limits(server_core::gateway::RecheckLimits {
                timeout: Duration::from_millis(300),
                parallel: 4,
            });
        let (token, account_id) = issue(&backend.db, "テスト用").await;
        let (mut socket, 生きている, conn) = 繋いで1枚名乗る(&gateway, &token).await;
        let 外す = CardId::new();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(外す)),
            })
            .await;
        wait_for_conn(&gateway, 外す).await;
        gateway
            .registry
            .archive_owned(account_id, 外す)
            .await
            .expect("外せること");

        let 止め所 = gateway.registry.照合の読みを止める();
        socket
            .send(&AgentMessage::SessionUpsert {
                session: Box::new(meta(外す)),
            })
            .await;
        満ちるまで待つ(
            "名乗りの照合が DB の読み取りまで来ない（形を作れていない）",
            || 止め所.来た数() >= 1,
        )
        .await;
        socket
            .send(&AgentMessage::ContextUsage {
                card_id: 生きている,
                usage: Some(protocol::ContextUsage {
                    used_percentage: 7,
                    total_input_tokens: 70_000,
                    context_window_size: 1_000_000,
                }),
            })
            .await;
        満ちるまで待つ(
            &format!(
                "[{}] ★名乗りの照合の DB の答えを上限を過ぎても待ち続け、次の報告を処理していない",
                backend.name
            ),
            || {
                gateway
                    .registry
                    .get(生きている)
                    .is_some_and(|record| record.meta().context_usage.is_some())
            },
        )
        .await;

        止め所.開ける();
        // 上限を過ぎた照合は確かめ直しへ回っている。生存確認の周期を待たずに進める
        conn.確かめ直しを急かす();
        socket
            .wait_for(
                "DB が答えた後の取り下げ",
                |message| matches!(message, ServerToAgent::Forget { card_id } if *card_id == 外す),
            )
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 答えない_PC_への問いは時間切れになる() {
    // **「確かめられなかった」の3つ目**（名前付け設計§8-5）。寝ている・版が古いは
    // 投げる前に断るが、**繋がっているのに黙る**相手には投げてから待つしかない。
    //
    // ここが `Ok(空)` を返すようになると、上の層（`api_sessions_past`）は「無い」と
    // 読んで**選択肢から消す**。回線が重い日だけ過去のセッションが消える、という
    // 再現しにくい壊れ方になる。
    for backend in common::backends("gw-ask-timeout").await {
        let gateway = TestGateway::start(backend.db.clone()).await;
        let (token, account_id) = issue(&backend.db, "利用者").await;

        // **受け取るだけで答えない PC。** `_socket` を持ち続けるのが要点で、落とすと
        // 「繋がっていません」になり、確かめたい枝を通らない
        let _socket = gateway.connect_as(&token, "黙る PC").await;
        let target = 名乗るまで待つ(&gateway, account_id).await;

        let host = server_core::gateway::RemoteSessionHost::new(Arc::clone(&gateway.hub));
        let started = tokio::time::Instant::now();
        let error = host
            .sessions_exist(
                server_core::session_host::HostAskRequest {
                    account_id,
                    target: Some(target),
                },
                &[protocol::ClaudeSessionId::new()],
            )
            .await
            .unwrap_err();

        assert!(
            matches!(error, server_core::session_host::HostAskError::Timeout),
            "[{}] 時間切れとして扱われていない: {error:?}",
            backend.name
        );
        // **待ってから諦めていること。** 即座に返るなら、投げる前に断る枝を通っている
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "[{}] 待たずに諦めている（{:?}）",
            backend.name,
            started.elapsed()
        );

        backend.finish().await;
    }
}

/// PC が接続表へ載るまで待って、その `AgentId` を返す。
async fn 名乗るまで待つ(gateway: &TestGateway, account_id: Uuid) -> protocol::AgentId {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let online = gateway.hub.online_of(account_id).await;
        if let Some(agent_id) = online.first() {
            return *agent_id;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に PC が接続表へ載りませんでした"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
