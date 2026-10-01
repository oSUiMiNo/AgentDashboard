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
    CardId, Node, NodeId, ProjectId, SessionMeta, SessionStatus, TreeNode,
    ws::{ErrorKind, ServerMessage},
};
use server_core::{
    bus::{Bus, memory::MemoryBroker},
    cluster,
    gateway::{RemoteSessionHost, SessionHostHub},
    registry::{AccountEvent, NoticeLimits, ReportOrigin, SessionRegistry},
    session_host::SessionHost as _,
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
        resumed_from: None,
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
        session_title: None,
        position: 0,
        nickname: None,
        branched_from: None,
        context_usage: None,
        rate_limits: None,
        cost: None,
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
            error: false,
        },
        ts: 0,
        branch: 0,
    }
}

/// サーバ1台ぶん。記録層・受け口・セッションホストの待ち受けを1組で持つ。
struct Instance {
    registry: Arc<SessionRegistry>,
    hub: Arc<SessionHostHub>,
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
    let registry = SessionRegistry::load(
        db.clone(),
        WINDOW,
        Some(bus as Arc<dyn Bus>),
        NoticeLimits::default(),
    )
    .await
    .expect("記録層を立てられること");
    let hub = SessionHostHub::new(db.clone(), Arc::clone(&registry));

    // セッションホストの受け口も本当に開ける。**繋ぐ先を選べる**ようにしないと、
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

/// セッションホストとして繋ぎ、名乗りまで済ませる。
async fn connect_agent(addr: SocketAddr, token: &str, name: &str) -> common::SessionHostSocket {
    connect_agent_with(addr, token, common::hello(name)).await
}

/// 名乗りを選んで繋ぐ（古い版の PC を作るため）。
async fn connect_agent_with(
    addr: SocketAddr,
    token: &str,
    hello: protocol::a2s::AgentMessage,
) -> common::SessionHostSocket {
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
    let mut socket = common::SessionHostSocket { socket };
    socket.send(&hello).await;
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

/// しばらく待っても**カードの話が**届かないこと。
///
/// 連絡係の縮退（`BusStatus`）は数えない。切れたこと自体はバナーとして必ず流れるので、
/// 素朴に「1通も来ない」で書くと、**連絡係を切る検証そのものが書けなくなる**。
async fn expect_silence(events: &mut broadcast::Receiver<AccountEvent>, what: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return;
        }
        match tokio::time::timeout(left, events.recv()).await {
            Ok(Ok(event)) => match event.message {
                ServerMessage::BusStatus { .. } => continue,
                other => panic!("{what}: 届いてしまいました: {other:?}"),
            },
            Ok(Err(_)) => return,
            Err(_) => return,
        }
    }
}

#[tokio::test]
async fn 一方が受けた報告はもう一方のブラウザにも届く() {
    // 検収「どこへ接続しても同じ結果」の最小形。セッションホストは A に報告し、
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
    let token = server_core::db::pairing::issue_token(
        db,
        account_id,
        "テスト",
        server_core::db::pairing::TokenKind::Agent,
    )
    .await
    .expect("トークンを発行できること");
    (token, account_id)
}

/// PC は B に、ブラウザは A に、という配置を作る。
async fn split(
    db: &sea_orm::DatabaseConnection,
    broker: &Arc<MemoryBroker>,
) -> (
    Instance,
    Instance,
    common::SessionHostSocket,
    CardId,
    uuid::Uuid,
) {
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
async fn 別のインスタンスに繋がった_PC_の抜け殻も起こし直せる() {
    // **設計§6-1 がひっくり返したところが、本当に落ちるのはここだけ。**
    //
    // 既存の中継（`relay`）は、まず `conn_for_card` で自分の接続表を引く。1台構成なら
    // PC が繋がっている限りそこで当たるので、**カードの鮮度が落ちていても通ってしまう**
    // ——つまり「`Kill` の写経は100%失敗する」は言い過ぎだった（実際に壊し方を当てて
    // 分かった）。落ちるのは接続表に無いときで、それが**この配置**である。
    //
    // ブラウザは A、PC は B、そのうえでカードの鮮度は落ちている。`relay` はここで
    // `remote_agent_of` へ落ち、あれは `agent_connected == true` を要求するので断る。
    for backend in common::backends("cluster-revive").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, account_id) = split(&backend.db, &broker).await;

        // 呼び戻し先を持たせてから、鮮度だけ落とす（＝PC が起き直してカードを失った形）
        let claude_session_id = protocol::ClaudeSessionId::new();
        let mut 抜け殻 = common::meta(card_id);
        抜け殻.claude_session_id = Some(claude_session_id);
        agent
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(抜け殻),
            })
            .await;
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let carried = a
                .registry
                .get(card_id)
                .is_some_and(|record| record.meta().claude_session_id == Some(claude_session_id));
            if carried {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 呼び戻し先が A まで届きませんでした",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let agent_id = a
            .registry
            .get(card_id)
            .expect("記録があること")
            .meta()
            .agent_id
            .expect("PC を名乗っていること");
        a.registry.set_agent_live(agent_id, false);

        // **頼みの番号も落とさない**（実装レビュー第6回。落とすとセルフホストでだけ PC が答えず、
        // CLI の `session revive` が時間切れになる）
        let op = protocol::ws::OpId::new();
        RemoteSessionHost::new(Arc::clone(&a.hub))
            .revive(server_core::session_host::ReviveRequest {
                account_id,
                card_id,
                op: Some(op),
            })
            .await
            .expect("接続表に無い PC の抜け殻でも宛先が解決できること");

        let message = agent
            .wait_for("跨ぎで届く起こし直し", |message| {
                matches!(
                    message,
                    protocol::a2s::ServerToAgent::ReviveSession { card_id: got, .. } if *got == card_id
                )
            })
            .await;
        let protocol::a2s::ServerToAgent::ReviveSession {
            claude_session_id: got,
            op: got_op,
            ..
        } = message
        else {
            unreachable!()
        };
        assert_eq!(
            got, claude_session_id,
            "[{}] 呼び戻し先が渡っていない",
            backend.name
        );
        assert_eq!(
            got_op,
            Some(op),
            "[{}] ★頼みの番号が PC まで渡っていない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 別のインスタンスに繋がった_PC_の実体の無いカードへも終了の頼みが届く() {
    // 実装レビュー第4回 Astra 2。ブラウザは A、PC は B。**カードの実体が無い**（鮮度が
    // 落ちている）とき、PC はその起こし直しの確かめを待っていることがある。起こし直しの頼みは
    // 持ち主の PC への道（`route`）で届くのに、終了の頼みは `relay` → `remote_agent_of` が
    // 「繋がっていません」で断っていたので、起こし直しを止められなかった
    for backend in common::backends("cluster-kill").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, account_id) = split(&backend.db, &broker).await;
        let host = RemoteSessionHost::new(Arc::clone(&a.hub));

        // 生きたカードは、いまどおり連絡係へ回って届く。**頼みの番号も落とさない**（実装レビュー
        // 第6回 Astra 1。落とすとセルフホストでだけ、PC が答えを返さず CLI が時間切れになる）
        let op = protocol::ws::OpId::new();
        host.kill(account_id, card_id, Some(op))
            .await
            .expect("生きたカードへの終了の頼みが届くこと");
        agent
            .wait_for("跨ぎで届く終了（生きたカード・番号付き）", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Kill { card_id: got, op: Some(got_op) } if *got == card_id && *got_op == op)
            })
            .await;

        // 鮮度だけを落とす（＝PC が実体を失った・起こし直しの確かめを待っている形）
        let agent_id = a
            .registry
            .get(card_id)
            .expect("記録があること")
            .meta()
            .agent_id
            .expect("PC を名乗っていること");
        a.registry.set_agent_live(agent_id, false);
        assert!(
            !a.registry
                .get(card_id)
                .expect("記録があること")
                .meta()
                .agent_connected,
            "A から見て実体が無いこと"
        );

        host.kill(account_id, card_id, None)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "[{}] ★実体の無いカードへの終了の頼みが、持ち主の PC へ届かず断られた：{err}",
                    backend.name
                )
            });
        agent
            .wait_for("跨ぎで届く終了（実体の無いカード）", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Kill { card_id: got, .. } if *got == card_id)
            })
            .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 古い_PC_の生きたカードは跨いで止められ実体の無いカードは以前の言葉で断る() {
    // 実装レビュー第4回 Astra 2 の副作用の見張り。実体の無いカードの宛先は起こし直しと同じく
    // 名乗りを見て引くが、**生きたカードの終了は名乗りを見ない**（古い PC も止められる）。
    // 名乗らない PC は起こし直しをしないので、実体の無いカードには止めるものが無い——「版が
    // 古い」と言うと、止めるものが無いのに更新を促すことになる
    for backend in common::backends("cluster-kill-old").await {
        let broker = MemoryBroker::new();
        let (token, account_id) = issue(&backend.db).await;
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        let mut 古い名乗り = common::hello("PC-B");
        if let protocol::a2s::AgentMessage::Hello {
            supports_revive, ..
        } = &mut 古い名乗り
        {
            *supports_revive = false;
        }
        let mut agent = connect_agent_with(b.addr, &token, 古い名乗り).await;
        a.attach_browser(account_id).await;
        let card_id = CardId::new();
        agent
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(common::meta(card_id)),
            })
            .await;
        wait_card(&a.registry, card_id).await;
        let host = RemoteSessionHost::new(Arc::clone(&a.hub));

        host.kill(account_id, card_id, None)
            .await
            .expect("★名乗らない PC の生きたカードを、跨いで止められない");
        agent
            .wait_for("跨ぎで届く終了（名乗らない PC の生きたカード）", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Kill { card_id: got, .. } if *got == card_id)
            })
            .await;

        let agent_id = a
            .registry
            .get(card_id)
            .expect("記録があること")
            .meta()
            .agent_id
            .expect("PC を名乗っていること");
        a.registry.set_agent_live(agent_id, false);
        let err = host
            .kill(account_id, card_id, None)
            .await
            .expect_err("止めるものの無いカードは断ること");
        assert!(
            err.contains("繋がっていません") && !err.contains("版が古い"),
            "[{}] ★止めるものが無いのに、以前と違う言葉で断っている：{err}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 終了の頼みで取り下げた断りは理由を落とさず跨いで届く() {
    // 実装レビュー第4回 Astra 1・2・第6回 Astra 3。PC が B で起こし直しを取り下げた断りは、B が
    // 受けて連絡係で A のブラウザへ回る。**どこかで `withdrawn` や `ops` を落とすと、セルフホスト
    // でだけ**枝分かれが自分の起こし直しの断りを拾えず、上限まで待ち切る
    for backend in common::backends("cluster-withdrawn").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, account_id) = split(&backend.db, &broker).await;
        let mut events = a.subscribe_events();
        let 起こす頼み = protocol::ws::OpId::new();

        agent
            .send(&protocol::a2s::AgentMessage::Error {
                card_id: Some(card_id),
                message: "終了を頼まれたので、起こし直しをやめました".to_string(),
                kind: ErrorKind::Revive,
                busy: Some(false),
                withdrawn: Some(protocol::ws::Withdrawal::Kill),
                ops: vec![起こす頼み],
            })
            .await;

        let message = wait_event(&mut events, "取り下げた断り", |message| {
            matches!(
                message,
                ServerMessage::Error { card_id: Some(got), kind: ErrorKind::Revive, .. } if *got == card_id
            )
        })
        .await;
        let ServerMessage::Error { withdrawn, ops, .. } = &message else {
            unreachable!("断りを待った");
        };
        assert_eq!(
            *withdrawn,
            Some(protocol::ws::Withdrawal::Kill),
            "[{}] ★跨いだ先で、取り下げの理由を落としている：{message:?}",
            backend.name
        );
        assert_eq!(
            server_core::registry::revive_refusal_of(&message).map(|(_, ops, _)| ops.to_vec()),
            Some(vec![起こす頼み]),
            "[{}] ★跨いだ先で、答える頼みの番号を落としている：{ops:?}",
            backend.name
        );
        assert_eq!(
            a.registry
                .revive_refusal_for(account_id, card_id, 起こす頼み)
                .as_deref(),
            Some("終了を頼まれたので、起こし直しをやめました"),
            "[{}] ★跨いだ先の記録から、番号で引き直せない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 終了の答えは跨いだ先で番号付きの状態として届く() {
    // 実装レビュー第6回 Astra 1。ブラウザ（CLI）は A、PC は B。PC の答え（`KillAnswer`）は B が
    // 受けて合否にし、連絡係で A へ回る。**番号を落とすと、セルフホストでだけ CLI が時間切れになる**
    for backend in common::backends("cluster-kill-answer").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account_id) = split(&backend.db, &broker).await;
        let mut events = a.subscribe_events();
        let op = protocol::ws::OpId::new();

        agent
            .send(&protocol::a2s::AgentMessage::KillAnswer {
                card_id,
                op,
                outcome: protocol::a2s::KillOutcome::Stopped,
            })
            .await;

        let message = wait_event(&mut events, "番号付きの状態", |message| {
            matches!(
                message,
                ServerMessage::Status { card_id: got, op: Some(_), .. } if *got == card_id
            )
        })
        .await;
        assert!(
            matches!(message, ServerMessage::Status { op: Some(got), .. } if got == op),
            "[{}] ★跨いだ先で、答えの番号が別物になっている：{message:?}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 手元で外すのが先に済んでも受け付けた頼みの答えは跨いだ先で届く() {
    // 実装レビュー第7回 Astra 3。CLI は A、PC は B。B が完了の答え（番号付きの状態）を作った後に、
    // A で外すのが先に確定すると、A はカードの記録が無いことを持ち主の確かめにして答えを捨てて
    // いた。**CLI は答えが届いているのに時間切れになる**。
    //
    // 順を固定する：A の記録だけを先に外す（他のインスタンスから「外した」が回ってきた形。A の
    // 外した知らせは B へ回らないので、B は記録を持ったまま完了の答えを作る）
    for backend in common::backends("cluster-kill-answer-after-removal").await {
        let broker = MemoryBroker::new();
        let (a, b, mut agent, card_id, account_id) = split(&backend.db, &broker).await;
        let op = protocol::ws::OpId::new();
        // A の `/ws` が持ち主の門を通して受け付けた頼み（`ws.rs` の `handle_request` と同じ控え方）
        a.registry.accept_op(account_id, card_id, op);
        a.registry
            .adopt(account_id, ServerMessage::SessionRemoved { card_id })
            .await;
        assert!(a.registry.get(card_id).is_none(), "A の記録が外れていない");
        assert!(
            b.registry.get(card_id).is_some(),
            "B の記録まで外れている（B が答えを断りにするので、確かめたい形にならない）"
        );
        let mut events = a.subscribe_events();

        agent
            .send(&protocol::a2s::AgentMessage::KillAnswer {
                card_id,
                op,
                outcome: protocol::a2s::KillOutcome::Stopped,
            })
            .await;
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        let mut 届いた = false;
        while let Ok(received) = tokio::time::timeout_at(deadline, events.recv()).await {
            match received {
                Ok(event) => {
                    if matches!(
                        event.message,
                        ServerMessage::Status { card_id: got, op: Some(got_op), .. }
                            if got == card_id && got_op == op
                    ) {
                        届いた = true;
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
        assert!(
            届いた,
            "[{}] ★A で外すのが先に済むと、受け付けた頼みへの完了の答えを捨てている",
            backend.name
        );
        assert!(
            a.registry.op_answer(account_id, op).is_some(),
            "[{}] 外した後に届いた答えを、取りこぼしたときに引き直せない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 跨いで届いた取り下げを約束の列に積めなければ_PC_の接続を畳む() {
    // 寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー第8回 Astra 1
    // （ループの外の道）。外す画面は A、PC は B。外す知らせ（`Forget`）は連絡係で B へ回り、B が PC の
    // 約束の列へ積む。以前は積めなければ1行残して捨て、接続を保った——列が空いた後も PC がその
    // カードを名乗らなければ、取り下げは二度と送られない。
    //
    // **順は目印で固定する。** B は跨ぎの指示を1本の列で順に処理するので、取り下げの後に別の PC へ
    // 回した目印が届けば、取り下げの処理は済んでいる。その後に詰まった PC に読ませて列を空ける
    // ——空いた列では生存確認が積めるので、直す前のコードは畳まない（生存確認に頼らない）
    for backend in common::backends("cluster-removal-full").await {
        let broker = MemoryBroker::new();
        let (token, account_id) = issue(&backend.db).await;
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        b.hub.set_lane_depths(server_core::gateway::LaneDepths {
            promise: 1,
            command: 2,
        });
        let mut 詰まる = connect_agent(b.addr, &token, "PC-詰まる").await;
        let mut 見張り = connect_agent(b.addr, &token, "PC-見張り").await;
        a.attach_browser(account_id).await;
        let (外す, 目印) = (CardId::new(), CardId::new());
        詰まる
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(common::meta(外す)),
            })
            .await;
        見張り
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(common::meta(目印)),
            })
            .await;
        wait_card(&a.registry, 外す).await;
        wait_card(&a.registry, 目印).await;
        let agent_id = a
            .registry
            .get(外す)
            .and_then(|record| record.meta().agent_id)
            .expect("PC を名乗っていること");
        let conn = b.hub.conn(agent_id).expect("B に繋がっていること");

        // B の書き手を止め、約束の列（深さ1）を害の無い取り下げで埋める（Close で埋めない）
        RemoteSessionHost::new(Arc::clone(&b.hub))
            .send_input(外す, "x".repeat(4 * 1024 * 1024), Vec::new(), false)
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
        // 生存確認が先に居ることがある（これも害の無い約束）。積めなくなるまで積む
        for _ in 0..8 {
            if !conn.send(&protocol::a2s::ServerToAgent::Forget {
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

        // A から外す知らせを回し、続けて別の PC へ目印を回す
        let 画面 = RemoteSessionHost::new(Arc::clone(&a.hub));
        画面
            .forget(account_id, 外す, Some(agent_id))
            .await
            .expect("連絡係へ回せること");
        画面
            .kill(account_id, 目印, None)
            .await
            .expect("目印を回せること");
        見張り
            .wait_for("目印", |message| {
                matches!(message, protocol::a2s::ServerToAgent::Kill { card_id, .. } if *card_id == 目印)
            })
            .await;

        // 詰まった PC に読ませて列を空ける。畳まれていれば、読み切った先で閉じる
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let next = tokio::time::timeout_at(
                deadline,
                futures_util::StreamExt::next(&mut 詰まる.socket),
            )
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "[{}] ★跨いで届いた取り下げを約束の列に積めなかったのに、PC の接続を保っている（列が空いても、PC がそのカードを名乗らなければ二度と送られない）",
                        backend.name
                    )
                });
            match next {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                | None
                | Some(Err(_)) => {
                    break;
                }
                Some(Ok(_)) => {}
            }
        }

        backend.finish().await;
    }
}

#[tokio::test]
async fn 切れている間に別のサーバで外したカードは繋ぎ直して名乗ったところで片付けさせる() {
    // 寝ているカードばかりなのに、メモリ不足でセッションを起こせない 実装レビュー第9回 Astra 2。
    // PC がサーバ B から切れている間に、サーバ A でカードを外す。外した知らせはアカウントの知らせに
    // 乗って回るが、**B にそのアカウントのブラウザが居なければ購読しておらず、古い記録が残る**。
    // PC が B へ繋ぎ直して名乗ると、以前は「手元に記録がある」ので DB を見ず、外したカードを一覧へ
    // 配り直し、`Forget` も送らなかった——外したカードのプロセスが残る。
    //
    // 名乗るのは変わらない姿のまま（PC は繋ぎ直すたびに手持ちを全部名乗り直す）
    for backend in common::backends("cluster-stale-record").await {
        let broker = MemoryBroker::new();
        let (token, account_id) = issue(&backend.db).await;
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        // ブラウザは A にだけ居る。B はこのアカウントの知らせを購読していない
        a.attach_browser(account_id).await;
        let card_id = CardId::new();
        let mut agent = connect_agent(b.addr, &token, "PC-B").await;
        agent
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(common::meta(card_id)),
            })
            .await;
        wait_card(&a.registry, card_id).await;
        wait_card(&b.registry, card_id).await;
        let agent_id = b
            .registry
            .get(card_id)
            .and_then(|record| record.meta().agent_id)
            .expect("PC を名乗っていること");

        // PC を B から切り、A で記録の側だけで外す
        drop(agent);
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while b.hub.conn(agent_id).is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "[{}] 切れない",
                backend.name
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        a.registry
            .archive_owned(account_id, card_id)
            .await
            .expect("外せること");
        assert!(
            b.registry.get(card_id).is_some(),
            "[{}] B が外した知らせを受けている（古い記録が残る形を作れていない）",
            backend.name
        );

        // 繋ぎ直して、変わらない姿で名乗り直す
        let mut b_events = b.subscribe_events();
        let mut agent = connect_agent(b.addr, &token, "PC-B").await;
        agent
            .send(&protocol::a2s::AgentMessage::SessionUpsert {
                session: Box::new(common::meta(card_id)),
            })
            .await;
        agent
            .wait_for(
                "★（別のサーバで外したカードを名乗ったのに、外した知らせを送り直さない）Forget",
                |message| {
                    matches!(message, protocol::a2s::ServerToAgent::Forget { card_id: got } if *got == card_id)
                },
            )
            .await;

        let mut 最後の知らせ = None;
        while let Ok(event) = b_events.try_recv() {
            match event.message {
                ServerMessage::SessionUpsert { session } if session.card_id == card_id => {
                    最後の知らせ = Some("SessionUpsert");
                }
                ServerMessage::SessionRemoved { card_id: got } if got == card_id => {
                    最後の知らせ = Some("SessionRemoved");
                }
                _ => {}
            }
        }
        assert!(
            b.registry.get(card_id).is_none(),
            "[{}] ★別のサーバで外したカードの古い記録を、B が持ち続けている",
            backend.name
        );
        assert_eq!(
            最後の知らせ,
            Some("SessionRemoved"),
            "[{}] ★B が外したカードを配り直したまま、外した知らせで締めていない",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 起こし直しの答えは跨いだ先で番号付きの状態として届く() {
    // 実装レビュー第6回（`session revive` の待ち）。CLI は A、PC は B。PC の答え
    // （`ReviveAnswer`）は B が受けて記録の状態に番号を添え、連絡係で A へ回る。**答えか番号を
    // 落とすと、セルフホストでだけ CLI が時間切れになる**
    for backend in common::backends("cluster-revive-answer").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account_id) = split(&backend.db, &broker).await;
        let mut events = a.subscribe_events();
        let op = protocol::ws::OpId::new();

        agent
            .send(&protocol::a2s::AgentMessage::ReviveAnswer { card_id, op })
            .await;
        let message = wait_event(&mut events, "番号付きの状態", |message| {
            matches!(
                message,
                ServerMessage::Status { card_id: got, op: Some(_), .. } if *got == card_id
            )
        })
        .await;
        assert!(
            matches!(message, ServerMessage::Status { op: Some(got), .. } if got == op),
            "[{}] ★跨いだ先で、答えの番号が別物になっている：{message:?}",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 別のインスタンスに繋がった_PC_へ指示が届く() {
    // 検収「別インスタンスに接続していてもターミナル操作が成立」。ブラウザが繋がった
    // 側に PC が居ないという、**1台構成では絶対に起きない配置**を作って確かめる
    for backend in common::backends("cluster-cmd").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        RemoteSessionHost::new(Arc::clone(&a.hub))
            .send_input(card_id, "こんにちは".to_string(), Vec::new(), false)
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

        RemoteSessionHost::new(Arc::clone(&a.hub))
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

        RemoteSessionHost::new(Arc::clone(&a.hub))
            .spawn(server_core::session_host::SpawnRequest {
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
        let err = RemoteSessionHost::new(Arc::clone(&a.hub))
            .send_input(card_id, "届かない".to_string(), Vec::new(), false)
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

// --- 画面（設計§9-2 の `card:{id}:screen`・§9-3・§9-4）------------------------

/// 画面のフレームが1つ来るまで待つ。
async fn wait_frame(
    frames: &mut broadcast::Receiver<bytes::Bytes>,
    what: &str,
) -> protocol::frame::FrameKind {
    let bytes = tokio::time::timeout(TIMEOUT, frames.recv())
        .await
        .unwrap_or_else(|_| panic!("{what} が届きませんでした"))
        .expect("配信が閉じていないこと");
    protocol::frame::decode(&bytes)
        .expect("フレームとして読めること")
        .kind
}

#[tokio::test]
async fn 別のインスタンスに繋がった_PC_の画面が見える() {
    // 検収「別インスタンスに接続していてもターミナル操作が成立」の表示側。
    // ローカルモードでは画面配信の経路を1バイトも通らないので、この配置でしか出ない
    for backend in common::backends("cluster-screen").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        let remote = RemoteSessionHost::new(Arc::clone(&a.hub));
        let (_blank, mut frames) = remote
            .subscribe_pty(card_id, 1, 80, 24)
            .expect("端末を開けること");

        // 開いたことが PC まで届く（跨いで SubScreen が回る）
        agent
            .wait_for("画面の要求", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SubScreen { .. })
            })
            .await;

        agent
            .send_screen(protocol::frame::FrameKind::ScreenFull, card_id, 0)
            .await;
        assert_eq!(
            wait_frame(&mut frames, "全画面").await,
            protocol::frame::FrameKind::PtySnapshot,
            "[{}] ブラウザ向けの種別へ移し替えられていない",
            backend.name
        );

        agent
            .send_screen(protocol::frame::FrameKind::ScreenDiff, card_id, 1)
            .await;
        assert_eq!(
            wait_frame(&mut frames, "差分").await,
            protocol::frame::FrameKind::PtyOutput,
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 画面の番号が飛んだら出し直してもらう() {
    // pub/sub は at-most-once なので途中が消えうる（設計§9-3）。**消えたまま続きを
    // 流すと、画面は動いているのに中身が壊れている**という一番気づきにくい形になる
    for backend in common::backends("cluster-seq").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        let remote = RemoteSessionHost::new(Arc::clone(&a.hub));
        let (_blank, mut frames) = remote
            .subscribe_pty(card_id, 1, 80, 24)
            .expect("端末を開けること");
        agent
            .wait_for("最初の画面の要求", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SubScreen { .. })
            })
            .await;

        agent
            .send_screen(protocol::frame::FrameKind::ScreenFull, card_id, 0)
            .await;
        wait_frame(&mut frames, "全画面").await;

        // 1通落として番号を飛ばす
        broker.drop_next(&server_core::bus::card_screen(card_id));
        agent
            .send_screen(protocol::frame::FrameKind::ScreenDiff, card_id, 1)
            .await;
        agent
            .send_screen(protocol::frame::FrameKind::ScreenDiff, card_id, 2)
            .await;

        // 出し直しを頼むこと
        agent
            .wait_for("出し直しの要求", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SubScreen { .. })
            })
            .await;
        // **飛んだ後の差分は流さない**（届いていたら壊れた画面が出ている）
        assert!(
            tokio::time::timeout(Duration::from_millis(200), frames.recv())
                .await
                .is_err(),
            "[{}] 飛んだ後の差分が流れています",
            backend.name
        );

        // 全画面が来たら再開する
        agent
            .send_screen(protocol::frame::FrameKind::ScreenFull, card_id, 10)
            .await;
        assert_eq!(
            wait_frame(&mut frames, "出し直された全画面").await,
            protocol::frame::FrameKind::PtySnapshot,
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 見ている人が居なくなって初めて画面が止まる() {
    // 視聴リース（設計§9-4）。手元が空になっただけで止めると、**別のインスタンスで
    // 見ている人の画面が黙って止まる**
    for backend in common::backends("cluster-lease").await {
        let broker = MemoryBroker::new();
        let (a, b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        // A と B の両方に視聴者を1人ずつ置く
        RemoteSessionHost::new(Arc::clone(&a.hub))
            .subscribe_pty(card_id, 1, 80, 24)
            .expect("A で端末を開けること");
        RemoteSessionHost::new(Arc::clone(&b.hub))
            .subscribe_pty(card_id, 2, 80, 24)
            .expect("B で端末を開けること");
        agent
            .wait_for("画面の要求", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SubScreen { .. })
            })
            .await;

        // A の視聴者が去っても、B に居るので止めない
        RemoteSessionHost::new(Arc::clone(&a.hub)).release_client(card_id, 1);
        agent
            .expect_none_of(
                Duration::from_millis(500),
                "早すぎる画面の停止",
                |message| matches!(message, protocol::a2s::ServerToAgent::UnsubScreen { .. }),
            )
            .await;
        assert_eq!(
            broker_viewers(&broker, card_id).await,
            1,
            "[{}] 印の数が合わない",
            backend.name
        );

        // 最後の1人が去ったら止める
        RemoteSessionHost::new(Arc::clone(&b.hub)).release_client(card_id, 2);
        agent
            .wait_for("画面の停止", |message| {
                matches!(message, protocol::a2s::ServerToAgent::UnsubScreen { .. })
            })
            .await;

        backend.finish().await;
    }
}

/// いま何人（何インスタンス）が見ていることになっているか。
async fn broker_viewers(broker: &Arc<MemoryBroker>, card_id: CardId) -> u64 {
    let (tx, _rx) = mpsc::unbounded_channel();
    let probe = broker.connect(tx);
    probe
        .lease_sweep(&server_core::bus::screen_viewers(card_id), 0)
        .await
        .expect("数えられること")
}

#[tokio::test]
async fn 連絡係が切れると縮退がブラウザまで届く() {
    // 縮退の症状は「一部だけ古い」という分かりにくい形になる（設計§12）。
    // **何が止まっているのかを言わないと、利用者には読み解けない**
    for backend in common::backends("cluster-banner").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        a.attach_browser(account()).await;
        let mut events = a.subscribe_events();

        broker.cut();
        let message = wait_event(&mut events, "縮退の知らせ", |message| {
            matches!(message, ServerMessage::BusStatus { .. })
        })
        .await;
        assert!(
            matches!(
                message,
                ServerMessage::BusStatus {
                    state: protocol::ws::BusState::Degraded,
                    ..
                }
            ),
            "[{}] 実際: {message:?}",
            backend.name
        );

        broker.restore();
        wait_event(&mut events, "復帰の知らせ", |message| {
            matches!(
                message,
                ServerMessage::BusStatus {
                    state: protocol::ws::BusState::Ok,
                    ..
                }
            )
        })
        .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 知らせは_7_種類とも跨ぐ() {
    // 設計§9-2 の payload 表を**そのまま消し込む**。1つでも配り忘れると、その種別の
    // 更新だけが片方のブラウザに来ないという、症状から原因の分からない形になる
    for backend in common::backends("cluster-kinds").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        b.attach_browser(account()).await;
        let mut events = b.subscribe_events();

        let card_id = CardId::new();
        // 1. SessionUpsert
        a.apply(&local(), upsert(card_id)).await;
        wait_event(&mut events, "SessionUpsert", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;

        // 2. Status
        a.apply(
            &local(),
            ServerMessage::Status {
                card_id,
                status: SessionStatus::WaitingInput,
                subagent_active: 2,
                last_activity_at: 42,
                op: None,
            },
        )
        .await;
        wait_event(&mut events, "Status", |message| {
            matches!(
                message,
                ServerMessage::Status {
                    status: SessionStatus::WaitingInput,
                    subagent_active: 2,
                    ..
                }
            )
        })
        .await;

        // 3・4. TranscriptAppend / TranscriptReset は購読しているカードへ流れる
        let record = b.get(card_id).expect("B にも記録があること");
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
        for what in ["TranscriptAppend", "TranscriptReset"] {
            tokio::time::timeout(TIMEOUT, transcript.recv())
                .await
                .unwrap_or_else(|_| panic!("{what} が届きませんでした"))
                .expect("配信が閉じていないこと");
        }

        // 5・6・7. 揮発の知らせ（DB へ書かずに素通しするもの）
        a.apply(
            &local(),
            ServerMessage::ParserStatus {
                state: protocol::ws::ParserState::Degraded,
                detail: None,
            },
        )
        .await;
        wait_event(&mut events, "ParserStatus", |message| {
            matches!(message, ServerMessage::ParserStatus { .. })
        })
        .await;

        a.apply(
            &local(),
            ServerMessage::Selfheal {
                phase: protocol::ws::SelfhealPhase::Detected,
                detail: None,
            },
        )
        .await;
        wait_event(&mut events, "Selfheal", |message| {
            matches!(message, ServerMessage::Selfheal { .. })
        })
        .await;

        a.apply(
            &local(),
            ServerMessage::Error {
                card_id: Some(card_id),
                message: "しくじりました".to_string(),
                kind: ErrorKind::Other,
                busy: None,
                withdrawn: None,
                ops: Vec::new(),
            },
        )
        .await;
        wait_event(&mut events, "Error", |message| {
            matches!(message, ServerMessage::Error { .. })
        })
        .await;

        backend.finish().await;
    }
}

#[tokio::test]
async fn 連絡係が切れても自分のブラウザへの配信は続く() {
    // 設計§12 の Valkey 断の行。**止まるのは跨ぎの更新だけ**で、そのインスタンスの
    // 中で完結する配信は動き続ける——ここが止まると「片方だけ古い」ではなく
    // 「全部止まった」になり、縮退として成立しない
    for backend in common::backends("cluster-inner").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        a.attach_browser(account()).await;
        let mut events = a.subscribe_events();

        broker.cut();
        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;

        wait_event(&mut events, "手元への配信", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;
        assert_eq!(
            a.list(account()).len(),
            1,
            "[{}] 手元の一覧が止まっている",
            backend.name
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn モデルの切替も跨いで届く() {
    // 指示は種別ごとに別の道を通らない（すべて `relay` を通る）が、テスト計画が
    // 名指ししているので消し込んでおく
    for backend in common::backends("cluster-model").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, card_id, _account) = split(&backend.db, &broker).await;

        RemoteSessionHost::new(Arc::clone(&a.hub))
            .set_model(card_id, protocol::ModelId::new("opus"))
            .await
            .expect("指示を出せること");

        let message = agent
            .wait_for("跨ぎで届く切替", |message| {
                matches!(message, protocol::a2s::ServerToAgent::SetModel { .. })
            })
            .await;
        match message {
            protocol::a2s::ServerToAgent::SetModel { model, .. } => {
                assert_eq!(model.as_str(), "opus", "[{}]", backend.name)
            }
            other => panic!("[{}] 実際: {other:?}", backend.name),
        }

        backend.finish().await;
    }
}

#[tokio::test]
async fn 外したカードは跨ぎの知らせでも戻らない() {
    // **回帰テスト。** 外した直後に他インスタンスから流れてきたぶんや、名乗り直しと
    // 行き違ったぶんを素直に取り込むと、記録が作り直されて一覧へ戻ってくる。しかも
    // 一覧はメモリの記録を見るので、**DB では外れているのに画面には出続ける**という
    // 食い違いになる（compose で PC を落として起こし直したときに実際に踏んだ）
    for backend in common::backends("cluster-resurrect").await {
        let broker = MemoryBroker::new();
        let a = instance(&backend.db, &broker).await;
        let b = instance(&backend.db, &broker).await;
        a.attach_browser(account()).await;
        b.attach_browser(account()).await;
        let mut events = b.subscribe_events();

        let card_id = CardId::new();
        a.apply(&local(), upsert(card_id)).await;
        wait_event(&mut events, "B へのカードの到着", |message| {
            matches!(message, ServerMessage::SessionUpsert { session } if session.card_id == card_id)
        })
        .await;

        // 外したあとに、行き違いの知らせが1通届く
        a.apply(&local(), ServerMessage::SessionRemoved { card_id })
            .await;
        wait_event(&mut events, "B での取り下げ", |message| {
            matches!(message, ServerMessage::SessionRemoved { card_id: id } if *id == card_id)
        })
        .await;
        b.adopt(account(), upsert(card_id)).await;

        assert!(
            b.get(card_id).is_none(),
            "[{}] 外したカードが跨ぎの知らせで戻っている",
            backend.name
        );
        assert!(
            b.list(account()).is_empty(),
            "[{}] 一覧にも戻っている",
            backend.name
        );

        backend.finish().await;
    }
}

// --- フォルダの問いと答え（イシューグループ_2026_0805_0514 設計§7）--------------

/// その PC が繋がっていると、跨いだ側からも見えるようになるまで待つ。
async fn wait_online(
    hub: &Arc<server_core::gateway::SessionHostHub>,
    account_id: uuid::Uuid,
) -> protocol::AgentId {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if let Some(id) = hub.online_of(account_id).await.first().copied() {
            return id;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に PC が跨いで見えるようになりませんでした"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn 跨いだ配置でもフォルダの答えが問うた側へ戻る() {
    // **この経路は1台構成では何も保証されない。** 行きの道（`agent:{id}:cmd`）は
    // 元からあるが、**帰りの道は無かった**——答えはアカウントの知らせに相乗りして
    // 問うた側のインスタンスへ戻る（設計§7）
    for backend in common::backends("cluster-hostfs").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, _card_id, account_id) = split(&backend.db, &broker).await;
        let target = wait_online(&a.hub, account_id).await;

        let host = RemoteSessionHost::new(Arc::clone(&a.hub));
        // 問いは待つので、別のタスクへ逃がして**その間に PC 役が答える**
        let asking = tokio::spawn(async move {
            host.list_dir(
                server_core::session_host::HostAskRequest {
                    account_id,
                    target: Some(target),
                },
                Some("/home/example/dev/app"),
            )
            .await
        });

        let message = agent
            .wait_for("跨ぎで届くフォルダの問い", |message| {
                matches!(message, protocol::a2s::ServerToAgent::ListDir { .. })
            })
            .await;
        let protocol::a2s::ServerToAgent::ListDir { request_id, path } = message else {
            panic!("[{}] フォルダの問いであること", backend.name);
        };
        // 省略なしで問うたので、そのまま載っていること（§26-2 の `None` は別の道）
        let path = path.expect("パスが載っていること");
        assert_eq!(path, "/home/example/dev/app");

        agent
            .send(&protocol::a2s::AgentMessage::HostReply {
                request_id,
                reply: protocol::a2s::HostReply::Dir(protocol::fs::DirListing {
                    path: path.clone(),
                    entries: vec![protocol::fs::DirEntry {
                        name: "src".to_string(),
                        kind: protocol::fs::EntryKind::Dir,
                        is_project: false,
                    }],
                    truncated: false,
                }),
            })
            .await;

        let listing = asking
            .await
            .expect("問いのタスクが畳まれないこと")
            .unwrap_or_else(|err| panic!("[{}] 答えが戻ること: {err:?}", backend.name));
        assert_eq!(listing.entries.len(), 1, "[{}]", backend.name);
        assert_eq!(listing.entries[0].name, "src", "[{}]", backend.name);

        backend.finish().await;
    }
}

#[tokio::test]
async fn 連絡係が切れている間のフォルダの問いは理由を返す() {
    // 時間切れの「応じません」と混ぜない。**届けられないのはこちら側の事情**で、
    // 利用者が PC を疑っても何も直らない（設計§17）
    for backend in common::backends("cluster-hostfs-cut").await {
        let broker = MemoryBroker::new();
        let (a, _b, _agent, _card_id, account_id) = split(&backend.db, &broker).await;
        let target = wait_online(&a.hub, account_id).await;

        broker.cut();

        let err = RemoteSessionHost::new(Arc::clone(&a.hub))
            .list_dir(
                server_core::session_host::HostAskRequest {
                    account_id,
                    target: Some(target),
                },
                Some("/home/example/dev/app"),
            )
            .await
            .expect_err("断られること");

        // 503 へ写る側であること（写し方そのものは `hosts.rs` の単体が固定している）
        assert!(
            matches!(err, server_core::session_host::HostAskError::Unreachable(_)),
            "[{}] 届かないことが理由として返ること: {err:?}",
            backend.name
        );
        assert!(
            err.message().contains("連絡係"),
            "[{}] 理由が分からない: {}",
            backend.name,
            err.message()
        );

        backend.finish().await;
    }
}

#[tokio::test]
async fn 跨いだ配置でもログの答えが問うた側へ戻る() {
    // フォルダと**同じ道に相乗りしている**ことをここで固定する（ログ設計§13-1）。
    // 新しいチャネルを作っていれば、この検査は通らない
    for backend in common::backends("cluster-logs").await {
        let broker = MemoryBroker::new();
        let (a, _b, mut agent, _card_id, account_id) = split(&backend.db, &broker).await;
        let target = wait_online(&a.hub, account_id).await;

        let host = RemoteSessionHost::new(Arc::clone(&a.hub));
        let query = protocol::logs::LogQuery {
            since: "2026-08-08T00:00:00.000Z".to_string(),
            level: "INFO".to_string(),
            card: None,
            proc: Some("session-host".to_string()),
            grep: None,
            grep_on_raw: false,
            sanitize: false,
        };
        let asked = query.clone();
        // 問いは待つので、別のタスクへ逃がして**その間に PC 役が答える**
        let asking = tokio::spawn(async move {
            host.read_log(
                server_core::session_host::HostAskRequest {
                    account_id,
                    target: Some(target),
                },
                &asked,
            )
            .await
        });

        let message = agent
            .wait_for("跨ぎで届くログの問い", |message| {
                matches!(message, protocol::a2s::ServerToAgent::ReadLog { .. })
            })
            .await;
        let protocol::a2s::ServerToAgent::ReadLog {
            request_id,
            query: got,
        } = message
        else {
            panic!("[{}] ログの問いであること", backend.name);
        };
        // **絞り込みはそのまま相手へ渡る。** ここで削ると PC 側が全部を返そうとする
        assert_eq!(got, query, "[{}]", backend.name);

        agent
            .send(&protocol::a2s::AgentMessage::HostReply {
                request_id,
                reply: protocol::a2s::HostReply::Log(protocol::logs::LogChunk {
                    host: String::new(),
                    host_now: "2026-08-08T01:00:00.000Z".to_string(),
                    lines: vec!["{\"ts\":\"2026-08-08T00:30:00.000Z\"}".to_string()],
                    truncated: false,
                    broken: 0,
                    leaks: 0,
                }),
            })
            .await;

        let chunk = asking
            .await
            .expect("問いのタスクが畳まれないこと")
            .unwrap_or_else(|err| panic!("[{}] 答えが戻ること: {err:?}", backend.name));
        assert_eq!(chunk.lines.len(), 1, "[{}]", backend.name);
        assert_eq!(
            chunk.host_now, "2026-08-08T01:00:00.000Z",
            "[{}]",
            backend.name
        );

        backend.finish().await;
    }
}
