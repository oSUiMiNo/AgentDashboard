//! エージェントとサーバをネットワークで隔てて通す（セルフホスト化設計§4〜§6、テスト計画フェーズ3）。
//!
//! **同じプロセスの中で2つの役を立て、本物の WebSocket で繋ぐ**（§15-2 #1）。ローカル
//! モードのテストが「両方が同じ物を触る」形なのに対し、こちらは経路が
//! `parser → agent → A2S → server → DB → ブラウザ配信` へ伸びる。伸びた区間でしか
//! 起きない壊れ方——ack を待たずに位置が進む、切断で履歴が飛ぶ、指示が届かない——を
//! ここで捕まえる。
//!
//! 本物の claude は起こさない（擬似 claude と JSONL の直書き）。実 CLI 経由の確認は
//! `real_cli.rs` を agent 経由へ改修するフェーズ4 の担当。

#![allow(non_snake_case)]

mod common;

use agent_core::{
    config::AgentConfig,
    events::EventSink,
    link::{AgentLink, LinkConfig},
    offsets::OffsetStore,
    session::SessionManager,
};
use protocol::{CardId, SessionStatus, TreeNode};
use server_core::{
    agent::AgentHost,
    db::{pairing, settings as db_settings},
    gateway::{AgentHub, RemoteAgent},
    registry::SessionRegistry,
};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const WINDOW: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(20);
/// テストの履歴同期間隔（秒）。既定の20秒だと1本ごとにそれだけ待つことになる
const SYNC_SECS: u64 = 1;

/// 線の上を覗き見する中継（検収条件「生 JSONL が流れない」の検査用）。
///
/// # なぜ素朴なバイト検査では足りないのか
///
/// WebSocket の**クライアント→サーバ方向は payload がマスクされる**（XOR）。生の
/// バイト列を眺めても平文は現れないので、「JSONL の行が流れていないこと」を素朴な
/// 文字列検索で確かめると、**何も流れていなくても通ってしまう**。ここではフレームを
/// 解いてマスクを外し、**実際に運ばれた中身**を記録する。
mod wire {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::sync::broadcast;

    /// 覗き見しながら中継する相手。
    pub struct Sniffer {
        pub addr: std::net::SocketAddr,
        /// エージェント → サーバ方向に流れた文字フレーム
        pub sent: Arc<Mutex<Vec<String>>>,
        cut: broadcast::Sender<()>,
    }

    impl Sniffer {
        pub async fn start(upstream: std::net::SocketAddr) -> Arc<Self> {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("空きポートで待ち受けられること");
            let addr = listener.local_addr().expect("待ち受け先を取れること");
            let (cut, _) = broadcast::channel(8);
            let sniffer = Arc::new(Self {
                addr,
                sent: Arc::new(Mutex::new(Vec::new())),
                cut,
            });

            let accepting = Arc::clone(&sniffer);
            tokio::spawn(async move {
                while let Ok((downstream, _)) = listener.accept().await {
                    let Ok(up) = tokio::net::TcpStream::connect(upstream).await else {
                        continue;
                    };
                    let (down_read, down_write) = downstream.into_split();
                    let (up_read, up_write) = up.into_split();
                    let sent = Arc::clone(&accepting.sent);
                    let mut cut_a = accepting.cut.subscribe();
                    let mut cut_b = accepting.cut.subscribe();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = pump(down_read, up_write, Some(sent)) => {}
                            _ = cut_a.recv() => {}
                        }
                    });
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = pump(up_read, down_write, None) => {}
                            _ = cut_b.recv() => {}
                        }
                    });
                }
            });
            sniffer
        }

        /// いま繋がっているものを切る（電波断・スリープの再現）。
        pub fn cut(&self) {
            let _ = self.cut.send(());
        }

        pub fn sent_frames(&self) -> Vec<String> {
            self.sent.lock().expect("ロックが壊れていない").clone()
        }
    }

    /// 片方向を中継しつつ、文字フレームを記録する。
    async fn pump(
        mut from: tokio::net::tcp::OwnedReadHalf,
        mut to: tokio::net::tcp::OwnedWriteHalf,
        record: Option<Arc<Mutex<Vec<String>>>>,
    ) {
        let mut buffer = Vec::new();
        let mut handshake_done = false;
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            let read = match from.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            if to.write_all(&chunk[..read]).await.is_err() {
                return;
            }
            let Some(record) = &record else { continue };

            buffer.extend_from_slice(&chunk[..read]);
            if !handshake_done {
                // 最初は素の HTTP（upgrade の要求）。フレームが始まるのはその後
                let Some(at) = find(&buffer, b"\r\n\r\n") else {
                    continue;
                };
                buffer.drain(..at + 4);
                handshake_done = true;
            }
            while let Some((opcode, payload, consumed)) = take_frame(&buffer) {
                buffer.drain(..consumed);
                if opcode == 0x1 {
                    record
                        .lock()
                        .expect("ロックが壊れていない")
                        .push(String::from_utf8_lossy(&payload).into_owned());
                }
            }
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// 先頭の1フレームを取り出す（マスクを外した payload を返す）。
    fn take_frame(buffer: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
        if buffer.len() < 2 {
            return None;
        }
        let opcode = buffer[0] & 0x0f;
        let masked = buffer[1] & 0x80 != 0;
        let short = (buffer[1] & 0x7f) as usize;

        let (length, mut at) = match short {
            126 => {
                if buffer.len() < 4 {
                    return None;
                }
                (u16::from_be_bytes([buffer[2], buffer[3]]) as usize, 4)
            }
            127 => {
                if buffer.len() < 10 {
                    return None;
                }
                let mut raw = [0u8; 8];
                raw.copy_from_slice(&buffer[2..10]);
                (u64::from_be_bytes(raw) as usize, 10)
            }
            other => (other, 2),
        };

        let mask = if masked {
            if buffer.len() < at + 4 {
                return None;
            }
            let mask = [buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3]];
            at += 4;
            Some(mask)
        } else {
            None
        };

        if buffer.len() < at + length {
            return None;
        }
        let mut payload = buffer[at..at + length].to_vec();
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        Some((opcode, payload, at + length))
    }
}

/// 2つの役を繋いだ一式。
struct A2s {
    dir: PathBuf,
    /// サーバ側
    registry: Arc<SessionRegistry>,
    hub: Arc<AgentHub>,
    /// ブラウザの代わり（`ws.rs` が使うのと同じ口）
    browser: Arc<dyn AgentHost>,
    account_id: uuid::Uuid,
    /// エージェント側
    manager: Arc<SessionManager>,
    link: Arc<AgentLink>,
    parser: Arc<agent_core::parser::ParserSupervisor>,
    sniffer: Option<Arc<wire::Sniffer>>,
    server_task: tokio::task::JoinHandle<()>,
}

impl Drop for A2s {
    fn drop(&mut self) {
        self.server_task.abort();
    }
}

impl A2s {
    async fn start(label: &str) -> Self {
        Self::start_with(label, false).await
    }

    /// `through_sniffer` を立てると、線の上を覗ける中継を間に挟む。
    async fn start_with(label: &str, through_sniffer: bool) -> Self {
        Self::start_full(label, through_sniffer, SYNC_SECS).await
    }

    /// 履歴の同期間隔まで決めて立てる（設定の即時反映を見るテスト用）。
    async fn start_full(label: &str, through_sniffer: bool, sync_secs: u64) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-a2s-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(dir.join("state")).expect("作業ディレクトリを作れること");

        // --- サーバ側 -------------------------------------------------------
        let db =
            server_core::db::connect(&format!("sqlite://{}", dir.join("dashboard.db").display()))
                .await
                .expect("使い捨ての DB へ繋げること");
        let registry = SessionRegistry::load(db.clone(), WINDOW)
            .await
            .expect("記録層を立てられること");
        let hub = AgentHub::new(db.clone(), Arc::clone(&registry));

        let account_id = pairing::ensure_account(&db, "テスト用")
            .await
            .expect("アカウントを用意できること");
        // 既定の20秒だと1本のテストがそれだけ待つ。**設定は DB から配られる**ので、
        // ここへ書けば名乗りの応答（Hello）に乗って届く（設計§13-3）
        db_settings::put(
            &db,
            account_id,
            db_settings::SYNC_INTERVAL_SECS,
            serde_json::json!(sync_secs),
        )
        .await
        .expect("同期間隔を書けること");
        let token = pairing::issue_token(&db, account_id, "テスト")
            .await
            .expect("トークンを発行できること");

        let browser: Arc<dyn AgentHost> = Arc::new(RemoteAgent::new(Arc::clone(&hub)));
        let ws_state = server_core::ws::AppState::new(
            Arc::clone(&browser),
            Arc::clone(&registry),
            Arc::new(server_core::config::ServerConfig::default()),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr: SocketAddr = listener.local_addr().expect("待ち受け先を取れること");
        let router = server_core::routes(ws_state)
            .merge(server_core::gateway::agent_routes(Arc::clone(&hub)));
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        // --- エージェント側 -------------------------------------------------
        let sniffer = if through_sniffer {
            Some(wire::Sniffer::start(addr).await)
        } else {
            None
        };
        let server_url = format!(
            "http://{}",
            sniffer.as_ref().map(|s| s.addr).unwrap_or(addr)
        );

        // **先にポートを確定させてから設定を作る。** 注入する settings にフックの宛先が
        // 焼き込まれるので、後から番号が変わると届かない（設計§5-3）
        let (hook_listener, hook_port) = agent_core::hooks::bind(0)
            .await
            .expect("フックの受信口を開けること");
        let agent_config = Arc::new(AgentConfig {
            state_dir: Some(dir.join("state")),
            claude_settings_path: Some(dir.join("claude-settings.json")),
            hook_port,
            ..AgentConfig::default()
        });
        let offsets = OffsetStore::open(agent_config.resolved_state_dir());
        // 本番と同じ入口（環境変数）でビルド済みのパーサを指す。統合テストは
        // ライブラリとして動くので、`current_exe()` の隣にはパーサが居ない
        unsafe {
            std::env::set_var(agent_core::parser::PARSER_BIN_ENV, common::parser_program());
        }

        let link = AgentLink::new(LinkConfig {
            server_url,
            pairing_token: token,
            agent_name: "テスト用PC".to_string(),
            available_modes: vec![protocol::PermissionMode::new("default")],
            always_bypass_permissions: false,
        });
        let manager = common::build_manager_with(
            Arc::clone(&agent_config),
            common::fake_claude().to_string_lossy().into_owned(),
            Arc::clone(&link) as Arc<dyn EventSink>,
        );
        agent_core::hooks::serve(hook_listener, Arc::clone(&manager));
        let parser = agent_core::parser::ParserSupervisor::start(
            Arc::clone(&manager),
            Arc::clone(&agent_config),
            Arc::clone(&offsets),
        );
        manager.attach_parser(parser.handle());
        link.attach(Arc::clone(&manager), offsets);
        // パーサの立ち上がりと最初の接続を待つ
        tokio::time::sleep(Duration::from_millis(300)).await;

        Self {
            dir,
            registry,
            hub,
            account_id,
            parser,
            browser,
            manager,
            link,
            sniffer,
            server_task,
        }
    }

    /// 一覧が条件を満たすまで待つ。
    async fn wait_for_listed(
        &self,
        what: &str,
        matches: impl Fn(&[protocol::SessionMeta]) -> bool,
    ) -> Vec<protocol::SessionMeta> {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let listed = self.registry.list();
            if matches(&listed) {
                return listed;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{TIMEOUT:?} 以内に一覧が {what} になりませんでした（{} 枚）",
                listed.len()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 記録側の履歴が条件を満たすまで待つ。
    async fn wait_for_nodes(&self, card_id: CardId, at_least: usize) -> Vec<TreeNode> {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let nodes = self
                .registry
                .get(card_id)
                .map(|record| record.transcript_snapshot())
                .unwrap_or_default();
            if nodes.len() >= at_least {
                return nodes;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{TIMEOUT:?} 以内に履歴が {at_least} 件になりませんでした（{} 件）",
                nodes.len()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// エージェント側でセッションを1本起こし、トランスクリプトの場所を教える。
    fn start_session(&self) -> (Arc<agent_core::session::Session>, PathBuf) {
        let cwd = self.dir.join("project");
        std::fs::create_dir_all(&cwd).expect("作業ディレクトリを作れること");
        let session = self
            .manager
            .spawn(&cwd.to_string_lossy())
            .expect("セッションを起動できること");
        (session, cwd.join("session.jsonl"))
    }

    async fn tell_transcript(&self, session: &agent_core::session::Session, transcript: &Path) {
        let payload = serde_json::json!({
            "session_id": "11111111-2222-3333-4444-555555555555",
            "transcript_path": transcript.to_string_lossy(),
            "hook_event_name": "SessionStart",
        });
        self.post_hook(session.token(), "SessionStart", &payload.to_string())
            .await;
    }

    /// エージェント自身のフック受信口を叩く（**サーバの口ではない**。設計§5-3）。
    async fn post_hook(&self, token: &str, event: &str, body: &str) -> u16 {
        let port = self.manager.hook_port();
        let (path, body) = (format!("/hook/{token}/{event}"), body.to_string());
        tokio::task::spawn_blocking(move || {
            testkit::post_json(SocketAddr::from(([127, 0, 0, 1], port)), &path, &body)
        })
        .await
        .expect("送信スレッドが正常に終わること")
        .expect("受信口へ送れること")
    }
}

/// 会話1往復ぶんの最小トランスクリプト（`transcript.rs` と同じ形）。
fn sample_lines() -> Vec<String> {
    vec![
        r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"2.1.220","message":{"role":"user","content":"テストを流して"}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"2026-07-29T00:00:01.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"流します"}]}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u3","parentUuid":"u2","timestamp":"2026-07-29T00:00:02.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]}}"#.to_string(),
    ]
}

fn more_lines() -> Vec<String> {
    vec![
        r#"{"type":"user","uuid":"u4","parentUuid":"u3","timestamp":"2026-07-29T00:00:03.000Z","version":"2.1.220","toolUseResult":{"stdout":"1 passed"},"message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1 passed"}]}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u5","parentUuid":"u4","timestamp":"2026-07-29T00:00:04.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"通りました"}]}}"#.to_string(),
    ]
}

fn append(path: &std::path::Path, lines: &[String]) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("トランスクリプトへ書けること");
    for line in lines {
        writeln!(file, "{line}").expect("行を書けること");
    }
}

#[tokio::test]
async fn 名乗りを交わすと_PC_のカードとしてサーバに現れる() {
    let a2s = A2s::start("hello").await;
    let (session, _transcript) = a2s.start_session();

    let listed = a2s
        .wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;
    assert_eq!(listed[0].card_id, session.card_id);
    assert!(
        listed[0].agent_id.is_some(),
        "どの PC のカードか分からないまま記録されている"
    );
    assert!(listed[0].agent_connected, "繋がっているのに印が落ちている");
    assert_eq!(listed[0].account.as_deref(), Some("テスト用"));

    // 繋がっている PC は1台
    assert_eq!(a2s.hub.connected().len(), 1);

    session.kill();
}

#[tokio::test]
async fn ブラウザからの指示が_PC_まで届く() {
    // ブラウザ配信（`ws.rs`）が使うのと同じ口を通して、A2S の向こうまで届くことを見る
    let a2s = A2s::start("relay").await;

    a2s.browser
        .spawn(&a2s.dir.to_string_lossy(), None)
        .expect("起動の指示を出せること");

    let listed = a2s
        .wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;
    let card_id = listed[0].card_id;
    // **CardId を採番したのはエージェント側**（設計§5-2）。サーバは知らない ID の
    // 報告を新規登録として扱う
    assert!(a2s.manager.get(card_id).is_some(), "PC 側に実体が無い");

    // 指示送信も渡る。**PTY まで届いたこと**を PC 側で確かめる——ここで止まっていると、
    // 画面には出ているのに CLI は何も受け取っていない、という形で壊れる
    a2s.browser
        .send_input(card_id, "こんにちは".to_string())
        .await
        .expect("指示を送れること");
    let session = a2s.manager.get(card_id).expect("実体があること");
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !session.scrollback_text().contains("こんにちは") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に指示が PTY へ届きませんでした"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 外す指示も渡り、一覧から消える
    a2s.browser.archive(card_id).expect("外せること");
    a2s.wait_for_listed("空になる", |listed| listed.is_empty())
        .await;
}

#[tokio::test]
async fn フックはエージェントの口で受けて状態がサーバまで届く() {
    // 実機検証#5 の自動化。分離しても「焼き込み → 127.0.0.1 で受信 → 状態導出 →
    // 即時の報告」が成立すること（設計§5-3・§5-4）
    let a2s = A2s::start("hook").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    a2s.post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;

    let listed = a2s
        .wait_for_listed("作業中になる", |listed| {
            listed.len() == 1 && listed[0].status == SessionStatus::Working
        })
        .await;
    assert!(listed[0].hooks_seen, "フックを受けた印が立っていない");

    session.kill();
}

#[tokio::test]
async fn 履歴はバッチで渡り_DB_に入る() {
    let a2s = A2s::start("transcript").await;
    let (session, transcript) = a2s.start_session();
    a2s.tell_transcript(&session, &transcript).await;

    append(&transcript, &sample_lines());
    let nodes = a2s.wait_for_nodes(session.card_id, 3).await;
    assert_eq!(nodes.len(), 3);

    // REST の遡りも DB から返る（パーサはエージェント側に居て、サーバは知らない）
    let page = a2s
        .registry
        .transcript_page(session.card_id, None, 10)
        .await
        .expect("読めること");
    assert_eq!(page.nodes.len(), 3);

    session.kill();
}

#[tokio::test]
async fn 切断して繋ぎ直しても履歴に欠落も重複も出ない() {
    // 検収条件「復帰後、欠落・重複なく追いつく」。欠落なしは ack が、重複なしは
    // 主キーが担保する（設計§6-1）
    let a2s = A2s::start_with("resume", true).await;
    let sniffer = a2s.sniffer.as_ref().expect("覗き見の中継を挟んである");
    let (session, transcript) = a2s.start_session();
    a2s.tell_transcript(&session, &transcript).await;

    append(&transcript, &sample_lines());
    a2s.wait_for_nodes(session.card_id, 3).await;

    // ここで線を切る（電波断・スリープの再現）
    sniffer.cut();

    // **切断中も PC の中では動き続ける。** パーサは読み、エージェントは手元に溜める
    append(&transcript, &more_lines());
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 繋ぎ直したら、溜めていたぶんが届いて追いつく。
    //
    // 4件なのは、ツールコールの結果（u4）が**同じノード（u3）の上書き**として届くため。
    // 切断を跨いでも上書きが上書きのまま扱われることまで、ここで確かめている
    let nodes = a2s.wait_for_nodes(session.card_id, 4).await;
    assert_eq!(nodes.len(), 4, "重複している: {nodes:?}");
    let ids: Vec<&str> = nodes.iter().map(|node| node.id.0.as_str()).collect();
    // ノードIDは「レコードの uuid ＋ 何番目の中身か」で組み立てられる（パーサの規約）
    assert_eq!(ids, ["u1.0", "u2.0", "u3.0", "u5.0"], "並びが崩れている");
    assert!(
        matches!(
            nodes[2].node,
            protocol::Node::ToolCall {
                status: protocol::ToolStatus::Ok,
                ..
            }
        ),
        "切断を跨いだ上書きが届いていない: {:?}",
        nodes[2].node
    );

    session.kill();
}

#[tokio::test]
async fn 線の上に生の_JSONL_は流れない() {
    // 検収条件「データ」。**運ぶのは構造化されたノードだけ**（設計§5-3）。
    // マスクを外して実際の中身を見ないと、この検査は空振りする
    let a2s = A2s::start_with("no-raw", true).await;
    let sniffer = a2s.sniffer.as_ref().expect("覗き見の中継を挟んである");
    let (session, transcript) = a2s.start_session();
    a2s.tell_transcript(&session, &transcript).await;

    append(&transcript, &sample_lines());
    a2s.wait_for_nodes(session.card_id, 3).await;
    a2s.post_hook(
        session.token(),
        "UserPromptSubmit",
        r#"{"prompt":"フックの生ペイロード"}"#,
    )
    .await;
    a2s.wait_for_listed("作業中になる", |listed| {
        listed.len() == 1 && listed[0].status == SessionStatus::Working
    })
    .await;

    let frames = sniffer.sent_frames();
    assert!(
        !frames.is_empty(),
        "1フレームも観測できていない（検査が空振り）"
    );
    let all = frames.join("\n");

    // JSONL にしかないキー。ノードへ写す時点で落ちるので、線に現れたら生の行が
    // そのまま流れている
    for marker in ["parentUuid", "toolUseResult", r#""version":"2.1.220""#] {
        assert!(
            !all.contains(marker),
            "生の JSONL が流れている（{marker} を含む）"
        );
    }
    // フックの生ペイロードも流れない（状態だけが渡る）
    assert!(
        !all.contains("フックの生ペイロード"),
        "フックの生ペイロードが流れている"
    );

    // 空振りでないことの裏取り：構造化されたノードのほうは確かに流れている
    assert!(
        all.contains("transcript_batch"),
        "履歴のバッチが観測できていない"
    );
    assert!(all.contains("流します"), "ノードの中身が観測できていない");

    session.kill();
}

#[tokio::test]
async fn 切断すると接続断の印が付き_状態は書き換わらない() {
    let a2s = A2s::start_with("offline", true).await;
    let sniffer = a2s.sniffer.as_ref().expect("覗き見の中継を挟んである");
    let (session, _transcript) = a2s.start_session();
    a2s.post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    a2s.wait_for_listed("作業中になる", |listed| {
        listed.len() == 1 && listed[0].status == SessionStatus::Working
    })
    .await;

    sniffer.cut();

    let listed = a2s
        .wait_for_listed("接続断になる", |listed| {
            listed.len() == 1 && !listed[0].agent_connected
        })
        .await;
    assert_eq!(
        listed[0].status,
        SessionStatus::Working,
        "状態まで書き換えている（最後の既知状態を残すのが約束）"
    );

    // 繋ぎ直せば印は戻る（復帰手順で全セッションが送り直される）
    let listed = a2s
        .wait_for_listed("繋がり直す", |listed| {
            listed.len() == 1 && listed[0].agent_connected
        })
        .await;
    assert_eq!(listed[0].status, SessionStatus::Working);

    session.kill();
}

#[tokio::test]
async fn モデルの表は_PC_ごとに保存される() {
    // CLI の版は PC ごとに違う（設計§13-4）。**表はエージェント単位のデータ**なので、
    // サーバは中身を解釈せずそのまま `agents.model_table` へ置く
    let a2s = A2s::start("model-table").await;
    a2s.link.set_model_table(
        "2.1.220".to_string(),
        serde_json::json!([{ "id": "claude-opus-5", "label": "Opus 5" }]),
        serde_json::json!([{ "alias": "opus", "resolved": "claude-opus-5" }]),
    );

    let table = wait_for_model_table(&a2s, |table| table["cli_version"] == "2.1.220").await;
    assert_eq!(table["catalog"][0]["id"], "claude-opus-5");
    assert_eq!(table["aliases"][0]["alias"], "opus");

    // **別名の実測が変わったら送り直す**（§13-4）。実際の契機は「初めて選んだ別名が
    // 何に解決されたか分かったとき」で、そこから呼ばれるのがこの口
    a2s.link.model_aliases_changed(serde_json::json!([
        { "alias": "sonnet", "resolved": "claude-sonnet-5" }
    ]));

    let table = wait_for_model_table(&a2s, |table| table["aliases"][0]["alias"] == "sonnet").await;
    assert_eq!(
        table["cli_version"], "2.1.220",
        "別名だけを差し替えるはずが、表ごと作り直している"
    );
}

/// 保存されたモデルの表が条件を満たすまで待つ。
async fn wait_for_model_table(
    a2s: &A2s,
    matches: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let tables = pairing::model_tables(a2s.hub.db(), a2s.account_id)
            .await
            .expect("読めること");
        if let Some((_, table)) = tables.first()
            && matches(table)
        {
            return table.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内にモデルの表が期待どおりになりませんでした"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn 同期間隔の変更は次の接続を待たずに効く() {
    // 設定を変えたのに「次に繋ぎ直すまで古い間隔で送り続ける」のでは、変えた意味が
    // 半分無くなる（設計§13-3）。**間隔が長い状態から始めて、押し込んだら届く**ことを見る
    let a2s = A2s::start_full("intervals", false, 600).await;
    let (session, transcript) = a2s.start_session();
    a2s.tell_transcript(&session, &transcript).await;
    append(&transcript, &sample_lines());

    // 10分間隔なので、待っても来ない
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        a2s.registry
            .get(session.card_id)
            .map(|record| record.transcript_snapshot().is_empty())
            .unwrap_or(true),
        "長い間隔を指定したのに、すぐ送られてきている"
    );

    a2s.hub
        .set_intervals(
            a2s.account_id,
            server_core::db::settings::Intervals {
                sync_interval_secs: 1,
                ..Default::default()
            },
        )
        .await
        .expect("設定を変えられること");

    let nodes = a2s.wait_for_nodes(session.card_id, 3).await;
    assert_eq!(nodes.len(), 3);

    session.kill();
}

#[tokio::test]
async fn パーサの縮退と自己修復の進みはブラウザまで中継される() {
    // 自己修復は **PC の中で完結する**（設計§10-1）。分離で変わるのは「進み具合が
    // ブラウザまで届くか」だけなので、そこを見る。届かないと、修復が走っていることに
    // 誰も気づけないまま構造化ビューだけが空になる
    let a2s = A2s::start("selfheal-relay").await;
    let mut events = a2s.registry.subscribe_events();

    // パーサの縮退。**自己修復が修復に失敗したときに通る道と同じ**入口を使う
    a2s.parser.degrade("テストのため縮退させました".to_string());
    // 自己修復の進み。`Selfheal::notify` が内部で呼ぶのと同じ経路
    a2s.manager
        .broadcast(protocol::ws::ServerMessage::Selfheal {
            phase: protocol::ws::SelfhealPhase::Repairing,
            detail: Some("パーサを直しています".to_string()),
        });

    let mut saw_parser = false;
    let mut saw_selfheal = false;
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !(saw_parser && saw_selfheal) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let message = tokio::time::timeout(remaining, events.recv())
            .await
            .unwrap_or_else(|_| panic!("{TIMEOUT:?} 以内に中継されませんでした"))
            .expect("配信が閉じていないこと");
        match message {
            protocol::ws::ServerMessage::ParserStatus { state, detail } => {
                assert_eq!(state, protocol::ws::ParserState::Degraded);
                assert!(detail.is_some(), "理由が落ちている（画面に出せない）");
                saw_parser = true;
            }
            protocol::ws::ServerMessage::Selfheal { phase, detail } => {
                assert_eq!(phase, protocol::ws::SelfhealPhase::Repairing);
                assert_eq!(detail.as_deref(), Some("パーサを直しています"));
                saw_selfheal = true;
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn モデル切替の指示が渡り_押した手応えが返る() {
    // 切替そのもの（TUI へのキー送出・グローバル既定の保護）は PC の中で完結していて、
    // ローカルモードのテストが受け持つ。ここで見るのは**指示が渡り、押した手応え
    // （楽観更新）が記録まで戻ってくる**こと（設計§5-6）
    let a2s = A2s::start("set-model").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    a2s.browser
        .set_model(session.card_id, protocol::ModelId::new("opus"))
        .await
        .expect("切替を指示できること");

    let listed = a2s
        .wait_for_listed("切替中の印が付く", |listed| {
            listed
                .first()
                .and_then(|meta| meta.model_requested.as_ref())
                .map(protocol::ModelId::as_str)
                == Some("opus")
        })
        .await;
    assert_eq!(listed[0].card_id, session.card_id);

    session.kill();
}
