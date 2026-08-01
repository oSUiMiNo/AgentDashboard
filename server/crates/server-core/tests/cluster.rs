//! インスタンスを跨いだときの見え方（セルフホスト化設計§9、テスト計画フェーズ6）。
//!
//! # 何を1プロセスの中に立てているのか
//!
//! **記録層を2つ**立てて、同じ DB と1つの連絡係へ繋ぐ。これが「サーバを2台並べた」の
//! 最小形にあたる——真実は共有の DB にあり、揮発の知らせだけが連絡係を通る、という
//! 分け方（§9-1）はインスタンスが本当に別プロセスかどうかに依存しない。
//!
//! 本物の Valkey・PostgreSQL・2プロセスで通す版は `make e2e-compose` が受け持つ。
//! ここで守るのは**判断のロジック**（誰に配るか・何を取り込むか・戻ったときに何をするか）で、
//! それは docker が無くても確かめられる。
//!
//! # 分かっている限界
//!
//! 2つの記録層は**同じ DB 接続**を共有している（1プロセスなので分ける意味が薄い）。
//! 別プロセスが同じ DB を掴んだときの食い違いは、ここでは出ない——それは compose 側の
//! PostgreSQL が受け持つ。

#![allow(non_snake_case)]

mod common;

use protocol::{
    CardId, Node, NodeId, ProjectId, SessionMeta, SessionStatus, TreeNode, ws::ServerMessage,
};
use server_core::{
    agent::AgentHost as _,
    bus::{Bus, memory::MemoryBroker},
    cluster,
    gateway::{AgentHub, RemoteAgent},
    registry::{AccountEvent, ReportOrigin, SessionRegistry},
};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc};

const WINDOW: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(5);

fn local() -> ReportOrigin {
    ReportOrigin::local()
}

fn account() -> uuid::Uuid {
    server_core::db::LOCAL_ACCOUNT_ID
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

/// サーバ1台ぶん。記録層・受け口・エージェントの待ち受けを1組で持つ。
struct Instance {
    registry: Arc<SessionRegistry>,
    hub: Arc<AgentHub>,
    addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 記録層をそのまま呼べるようにする（`node.list(..)` のように書けるほうが読みやすい）。
impl std::ops::Deref for Instance {
    type Target = SessionRegistry;

    fn deref(&self) -> &Self::Target {
        &self.registry
    }
}

/// インスタンスを1台立てて、連絡係へ繋ぐ。
async fn instance(db: &sea_orm::DatabaseConnection, broker: &Arc<MemoryBroker>) -> Instance {
    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
    let bus = broker.connect(incoming_tx);
    let state = bus.state();
    let registry = SessionRegistry::load(db.clone(), WINDOW, Some(bus as Arc<dyn Bus>))
        .await
        .expect("記録層を立てられること");
    let hub = AgentHub::new(db.clone(), Arc::clone(&registry));

    // エージェントの受け口も本当に開ける。**繋ぐ先を選べる**ようにしないと、
    // 「ブラウザは A・PC は B」という配置そのものが作れない
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("空きポートで待ち受けられること");
    let addr = listener.local_addr().expect("待ち受け先を取れること");
    let router = server_core::gateway::agent_routes(Arc::clone(&hub));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    cluster::start(Arc::clone(&registry), Arc::clone(&hub), incoming_rx, state);
    Instance {
        registry,
        hub,
        addr,
        task,
    }
}

/// エージェントとして繋ぎ、名乗りまで済ませる。
async fn connect_agent(addr: SocketAddr, token: &str, name: &str) -> common::AgentSocket {
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://{addr}/agent/ws"
        ))
        .expect("要求を組み立てられること");
    request.headers_mut().insert(
        "sec-websocket-protocol",
        protocol::a2s::A2S_PROTOCOL
            .parse()
            .expect("ヘッダに載る値であること"),
    );
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .expect("ヘッダに載る値であること"),
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("繋げること");
    let mut socket = common::AgentSocket { socket };
    socket.send(&common::hello(name)).await;
    socket
}

/// カードの記録がそのインスタンスへ届くまで待つ。
async fn wait_card(registry: &Arc<SessionRegistry>, card_id: CardId) {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while registry.get(card_id).is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "カードが届きませんでした"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 条件を満たす知らせが届くまで待つ。
async fn wait_event(
    events: &mut broadcast::Receiver<AccountEvent>,
    what: &str,
    mut ok: impl FnMut(&ServerMessage) -> bool,
) -> ServerMessage {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, events.recv()).await {
            Ok(Ok(event)) if ok(&event.message) => return event.message,
            Ok(Ok(_)) => continue,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(err)) => panic!("配信が閉じました（{what} を待っていた）: {err}"),
            Err(_) => panic!("{what} が届きませんでした"),
        }
    }
}

/// しばらく待っても何も届かないこと。
async fn expect_silence(events: &mut broadcast::Receiver<AccountEvent>, what: &str) {
    match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
        Ok(Ok(event)) => panic!("{what}: 届いてしまいました: {:?}", event.message),
        _ => { /* 何も来ない＝期待どおり */ }
    }
}

#[tokio::test]
async fn 一方が受けた報告はもう一方のブラウザにも届く() {
    // 検収「どこへ接続しても同じ結果」の最小形。エージェントは A に報告し、
    // 利用者のブラウザは B に繋がっている、という配置にあたる
    for backend in common::backends("cluster-fanout").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;

        // B にブラウザが1人来た（＝ここで初めて知らせを購読する）
        b.attach_browser(account()).await;
        let mut events = b.subscribe_events();

        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;

        wait_event(&mut events, "跨ぎの SessionUpsert", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;
        assert_eq!(
            b.list(account()).len(),
            1,
            "[{}] B の一覧に出ていない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn ブラウザが居ないインスタンスは知らせを受け取らない() {
    // 購読を**ブラウザの数で開け閉めする**ことの確認（設計§9-2）。全アカウントを
    // まとめて購読すると、チャネル名でアカウントを分けた意味が無くなる
    for backend in common::backends("cluster-idle").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;

        let mut events = b.subscribe_events();
        a.apply(&local(), upsert(CardId::new())).await;

        expect_silence(&mut events, "ブラウザの居ないインスタンス").await;

        // 開けた瞬間に DB から埋まる（購読より前に流れたぶんは pub/sub では届かない）
        b.attach_browser(account()).await;
        wait_event(&mut events, "読み直しでの SessionUpsert", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 自分が出した知らせを取り込み直さない() {
    // pub/sub は購読していれば**自分の publish も返ってくる**。取り込むと二重に配られ、
    // 配り直したものがまた返ってきて止まらなくなる
    for backend in common::backends("cluster-echo").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        a.attach_browser(account()).await;
        let mut events = a.subscribe_events();

        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;

        wait_event(&mut events, "自分の SessionUpsert", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;
        // 2通目が来ないこと（＝跳ね返りを取り込んでいない）
        expect_silence(&mut events, "跳ね返り").await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 履歴は跨いでも作り直しが追い越されない() {
    // 設計§6-2。作り直しの後に続きが積まれる順序が崩れると、消したはずの履歴が
    // 残ったまま新しいノードが乗る
    for backend in common::backends("cluster-transcript").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        b.attach_browser(account()).await;

        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;

        // B 側にカードの記録ができるまで待ってから、その履歴を購読する
        let mut events = b.subscribe_events();
        let record = loop {
            if let Some(record) = b.get(card_id) {
                break record;
            }
            wait_event(&mut events, "B へのカードの到着", |_| true).await;
        };
        let (_, mut transcript) = record.subscribe_transcript();

        a.apply(
            &local(),
            ServerMessage::TranscriptAppend {
                card_id,
                nodes: vec![text_node("1")],
            },
        )
        .await;
        a.apply(&local(), ServerMessage::TranscriptReset { card_id })
            .await;
        a.apply(
            &local(),
            ServerMessage::TranscriptAppend {
                card_id,
                nodes: vec![text_node("2")],
            },
        )
        .await;

        let mut seen = Vec::new();
        for _ in 0..3 {
            let text = tokio::time::timeout(TIMEOUT, transcript.recv())
                .await
                .expect("履歴が届くこと")
                .expect("配信が閉じていないこと");
            seen.push(text.as_str().to_string());
        }
        assert!(seen[0].contains("transcript_append"), "実際: {:?}", seen);
        assert!(seen[1].contains("transcript_reset"), "実際: {:?}", seen);
        assert!(seen[2].contains("transcript_append"), "実際: {:?}", seen);
        assert_eq!(
            record.transcript_snapshot().len(),
            1,
            "[{}] 作り直しが効いていない（消したはずの履歴が残っている）",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 連絡係が戻ると記録を読み直す() {
    // 自動再購読は購読を張り直すだけで、**切れている間に流れたものは埋めてくれない**
    // （設計§9-1）。真実は DB にあるので、戻ったら読み直すのが唯一の追いつき方
    for backend in common::backends("cluster-resnapshot").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        b.attach_browser(account()).await;
        let mut events = b.subscribe_events();

        broker.cut();
        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;
        // 切れている間は届かない（DB には入っている）
        expect_silence(&mut events, "連絡係が切れている間").await;
        assert!(
            b.get(card_id).is_none(),
            "[{}] 届かないはずの知らせが入っている",
            backend.name
        );

        broker.restore();
        wait_event(&mut events, "読み直しでの SessionUpsert", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 切れている間に外されたカードは戻ったときに消える() {
    // 読み直しは「足りないものを足す」だけでは足りない。**手元にだけ残ったカード**が
    // このインスタンスのブラウザにだけ出続ける
    for backend in common::backends("cluster-stale").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        b.attach_browser(account()).await;
        let mut events = b.subscribe_events();

        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;
        wait_event(&mut events, "B へのカードの到着", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;

        broker.cut();
        a.apply(&local(), ServerMessage::SessionRemoved { card_id })
            .await;
        assert!(
            b.get(card_id).is_some(),
            "[{}] 切れている間に消えている（届かないはず）",
            backend.name
        );

        broker.restore();
        wait_event(&mut events, "読み直しでの SessionRemoved", |message| {
            matches!(message, ServerMessage::SessionRemoved { card_id: id } if *id == card_id)
        })
        .await;
        assert!(
            b.get(card_id).is_none(),
            "[{}] 外したカードが手元に残っている",
            backend.name
        );

        backend.finish().await;
    }
}

// --- ここから、PC を本当に繋いだうえでの跨ぎ（設計§9-2 の `agent:{id}:cmd`）------

/// アカウントを1つ作り、ペアリングトークンを1本発行する。
async fn issue(db: &sea_orm::DatabaseConnection) -> (String, uuid::Uuid) {
    let account_id = server_core::db::pairing::ensure_account(db, "テスト")
        .await
        .expect("アカウントを用意できること");
    let token = server_core::db::pairing::issue_token(db, account_id, "テスト")
        .await
        .expect("トークンを発行できること");
    (token, account_id)
}

/// PC は B に、ブラウザは A に、という配置を作る。
async fn split(
    db: &sea_orm::DatabaseConnection,
    broker: &Arc<MemoryBroker>,
) -> (Instance, Instance, common::AgentSocket, CardId, uuid::Uuid) {
    let (token, account_id) = issue(db).await;
    let a = instance(db, broker).await;
    let b = instance(db, broker).await;

    let mut agent = connect_agent(b.addr, &token, "PC-B").await;
    // ブラウザは A に居る。**PC が繋がっているのは B** なので、A の接続表は空のまま
    a.attach_browser(account_id).await;

    let card_id = CardId::new();
    agent
        .send(&protocol::a2s::AgentMessage::SessionUpsert {
            session: Box::new(common::meta(card_id)),
        })
        .await;
    wait_card(&a.registry, card_id).await;

    (a, b, agent, card_id, account_id)
}

#[tokio::test]
async fn 別のインスタンスに繋がった_PC_へ指示が届く() {
    // 検収「別インスタンスに接続していてもターミナル操作が成立」。ブラウザが繋がった
    // 側に PC が居ないという、**1台構成では絶対に起きない配置**を作って確かめる
    for backend in common::backends("cluster-cmd").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        RemoteAgent::new(Arc::clone(&a.hub))
            .send_input(card_id, "こんにちは".to_string())
            .await
            .expect("指示を出せること");

        let message = agent
            .wait_for("跨ぎで届く指示", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SendInput { .. })
            })
            .await;
        match message {
            protocol::a2s::ServerToAgent::SendInput { text, .. } => {
                assert_eq!(text, "こんにちは", "[{}]", backend.name)
            }
            other => panic!("[{}] 実際: {other:?}", backend.name),
        }

        backend.finish().await;
    }
}

#[tokio::test]
async fn 跨いでもキー入力はバイナリのまま届く() {
    // 生入力は跨ぐときだけ base64 で包む（設計§9-2）。**包みを解いた結果が
    // 元のフレームと1バイトも違わない**ことを見る——ここがずれると、端末に
    // 化けた文字が入る形でしか気づけない
    for backend in common::backends("cluster-input").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        RemoteAgent::new(Arc::clone(&a.hub))
            .write_input(card_id, b"\x1b[A")
            .expect("入力を出せること");

        let bytes = agent.wait_for_binary("跨ぎで届く入力").await;
        let frame = protocol::frame::decode(&bytes).expect("フレームとして読めること");
        assert_eq!(frame.kind, protocol::frame::FrameKind::PtyInput);
        assert_eq!(frame.card_id, card_id);
        assert_eq!(frame.payload, b"\x1b[A", "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 別のインスタンスに繋がった_PC_でもセッションを起こせる() {
    // 起動はカードを名指ししない（まだ無い）ので、**繋がっている PC を数える**
    // ところから跨ぐ必要がある（設計§9-4 の在席）
    for backend in common::backends("cluster-spawn").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, _card_id, account_id) = split(&backend.db, &broker).await;

        RemoteAgent::new(Arc::clone(&a.hub))
            .spawn(server_core::agent::SpawnRequest {
                account_id,
                // 繋がっているのは1台だけなので、宛先を選ばずに通る
                target: None,
                cwd: "/tmp",
                permission_mode: None,
            })
            .await
            .expect("起動の指示を出せること");

        agent
            .wait_for("跨ぎで届く起動", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Spawn { .. })
            })
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 連絡係が切れている間の跨ぎの指示は理由を返す() {
    // **黙って落とさない。** 押したのに何も起きない状態が一番たちが悪いので、
    // 届けられないことを画面に出せる形で返す（設計§12）
    for backend in common::backends("cluster-cmd-cut").await {
        let broker = MemoryBroker::new();
        let (a, _b, _agent, card_id, _account) = split(&backend.db, &broker).await;

        broker.cut();
        let err = RemoteAgent::new(Arc::clone(&a.hub))
            .send_input(card_id, "届かない".to_string())
            .await
            .expect_err("断られること");
        assert!(
            err.contains("連絡係"),
            "[{}] 理由が分からない: {err}",
            backend.name
        );

        backend.finish().await;
    }
}
