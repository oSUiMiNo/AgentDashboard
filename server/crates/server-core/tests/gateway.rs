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
