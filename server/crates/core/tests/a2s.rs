//! セッションホストとサーバをネットワークで隔てて通す（セルフホスト化設計§4〜§6、テスト計画フェーズ3）。
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
/// テストの画面更新間隔（ミリ秒）。同じ理由で詰める（既定は20秒。設計§13-3）
const SCREEN_MS: u64 = 100;

/// 線の上を覗き見する中継（検収条件「生 JSONL が流れない」の検査用）。
///
/// # なぜ素朴なバイト検査では足りないのか
///
/// WebSocket の**クライアント→サーバ方向は payload がマスクされる**（XOR）。生の
/// バイト列を眺めても平文は現れないので、「JSONL の行が流れていないこと」を素朴な
/// 文字列検索で確かめると、**何も流れていなくても通ってしまう**。ここではフレームを
/// 解いてマスクを外し、**実際に運ばれた中身**を記録する。
mod wire {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::sync::broadcast;

    /// 覗き見しながら中継する相手。
    pub struct Sniffer {
        pub addr: std::net::SocketAddr,
        /// セッションホスト → サーバ方向に流れた文字フレーム
        pub sent: Arc<Mutex<Vec<String>>>,
        cut: broadcast::Sender<()>,
        /// 立っている間は**新しい接続も通さない**（下記）
        blocked: AtomicBool,
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
                blocked: AtomicBool::new(false),
            });

            let accepting = Arc::clone(&sniffer);
            tokio::spawn(async move {
                while let Ok((downstream, _)) = listener.accept().await {
                    // 塞いでいる間は繋がせない。**繋ぎ直しを止められないと、
                    // 「切れている状態」を観測できない**（下記 [`Sniffer::block`]）
                    if accepting.blocked.load(Ordering::SeqCst) {
                        drop(downstream);
                        continue;
                    }
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

        /// 切ったうえで、**繋ぎ直しも通さない**（電波が戻らない状態）。
        ///
        /// # なぜ塞ぐ必要があるのか
        ///
        /// セッションホストは1度目の繋ぎ直しを待たずに試す（設計§6-3 の指数バックオフは
        /// **失敗してから**効く）。切っただけだと数十ミリ秒で戻ってしまい、
        /// 「接続断の印が付く」ことを観測できるかどうかが実行環境の速さ次第になる。
        /// 実際、塞がずに書いていたテストは**単体で走らせると必ず落ちる**状態だった。
        pub fn block(&self) {
            self.blocked.store(true, Ordering::SeqCst);
            self.cut();
        }

        /// また通す（電波が戻る）。
        pub fn unblock(&self) {
            self.blocked.store(false, Ordering::SeqCst);
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
    /// ブラウザ役が REST を叩く先（設定の読み込みなど）
    addr: SocketAddr,
    registry: Arc<SessionRegistry>,
    hub: Arc<AgentHub>,
    /// ブラウザの代わり（`ws.rs` が使うのと同じ口）
    browser: Arc<dyn AgentHost>,
    account_id: uuid::Uuid,
    /// セッションホスト側
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
        let registry = SessionRegistry::load(db.clone(), WINDOW, None)
            .await
            .expect("記録層を立てられること");
        let hub = AgentHub::new(db.clone(), Arc::clone(&registry));

        // **鍵なしの構成が名乗るアカウント**を使う。ブラウザ役が REST を叩くとき、
        // `AuthContext::local` は必ずこの行を名乗るので、別の行を作ると
        // 「設定を書いた先」と「PC が繋がっている先」がずれる
        let account_id = pairing::ensure_account(&db, server_core::db::LOCAL_ACCOUNT_NAME)
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
        // 画面の既定は20秒（§13-3）。無操作で1枚届くのを待てないので詰めておく。
        // **入力があったときの即時配信は間隔と無関係**なので、こちらを詰めても
        // ホットウィンドウの検証は成り立つ
        db_settings::put(
            &db,
            account_id,
            db_settings::SCREEN_INTERVAL_MS,
            serde_json::json!(SCREEN_MS),
        )
        .await
        .expect("画面の間隔を書けること");
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
        // ここはローカルの 127.0.0.1 相当（＝鍵なし）で立てる。認証そのものは
        // `auth.rs` の単体と `tenancy.rs` の総当たりが受け持つ
        let auth = server_core::auth::AuthContext::local(
            db.clone(),
            &server_core::config::ServerConfig::default(),
        );
        let router = server_core::auth::with_sessions(
            server_core::routes(ws_state, Arc::clone(&auth))
                .merge(server_core::gateway::agent_routes(Arc::clone(&hub)))
                // 設定の口も生やす。**読み込んだ間隔が繋がっている PC へ配られるか**は、
                // 実際に PC を繋いだこの土台でしか見られない（持ち出し設計§12）
                .merge(server_core::guard(
                    agentdashboard_core::settings_api::server_routes(Arc::clone(&hub)),
                    Arc::clone(&auth),
                )),
            &auth,
        );
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        // --- セッションホスト側 -------------------------------------------------
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
        // **最初の接続は、時間ではなく繋がったことで待つ。**
        //
        // 固定の待ち時間だと、負荷が高いとき（`make ci` は48個のテストバイナリを同時に
        // 走らせる）に繋がる前を抜ける。そこから先の壊れ方は2通りあり、どちらも実際に
        // 起きた——「PC が1台も居ないので `target: None` の指示が断られる」か、遅れて
        // 繋がった拍子に**溜めていたぶんが一気に届いて**「長い間隔にしたのにすぐ来た」
        // と見えるか。**再実行で通るので、直さないと本物の壊れ方を見落とす側へ倒れる**
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while hub.online_of(account_id).await.is_empty() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{TIMEOUT:?} 以内に PC が繋がりませんでした"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        Self {
            dir,
            addr,
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
            let listed = self.registry.list(self.account_id);
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

    /// セッションホスト側でセッションを1本起こし、トランスクリプトの場所を教える。
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

    /// セッションホスト自身のフック受信口を叩く（**サーバの口ではない**。設計§5-3）。
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
    assert_eq!(
        listed[0].account.as_deref(),
        Some(server_core::db::LOCAL_ACCOUNT_NAME)
    );

    // 繋がっている PC は1台
    assert_eq!(a2s.hub.connected().len(), 1);

    session.kill();
}

#[tokio::test]
async fn ブラウザからの指示が_PC_まで届く() {
    // ブラウザ配信（`ws.rs`）が使うのと同じ口を通して、A2S の向こうまで届くことを見る
    let a2s = A2s::start("relay").await;

    a2s.browser
        .spawn(server_core::agent::SpawnRequest {
            account_id: a2s.account_id,
            // 繋がっているのは1台だけなので、宛先を選ばずに通る
            target: None,
            cwd: &a2s.dir.to_string_lossy(),
            permission_mode: None,
        })
        .await
        .expect("起動の指示を出せること");

    let listed = a2s
        .wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;
    let card_id = listed[0].card_id;
    // **CardId を採番したのはセッションホスト側**（設計§5-2）。サーバは知らない ID の
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
async fn フックはセッションホストの口で受けて状態がサーバまで届く() {
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

    // REST の遡りも DB から返る（パーサはセッションホスト側に居て、サーバは知らない）
    let page = a2s
        .registry
        .transcript_page(a2s.account_id, session.card_id, None, 10)
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

    // **切断中も PC の中では動き続ける。** パーサは読み、セッションホストは手元に溜める
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

    // **繋ぎ直しごと塞ぐ。** 切るだけだと即座に戻ってしまい、印が付いたことを
    // 観測できるかどうかが実行環境の速さ次第になる
    sniffer.block();

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
    sniffer.unblock();
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
    // CLI の版は PC ごとに違う（設計§13-4）。**表はセッションホスト単位のデータ**なので、
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
async fn PC_の版が名乗りから一覧まで運ばれる() {
    // **A2S の形も記録の形も変えていない**（CICD設計§16）。版は名乗りに最初から
    // 載っていて、ログへ出て消えていただけ——運び忘れていないかだけを見る。
    //
    // 見せるのは、危ない組み合わせに気づけるようにするため。サーバのほうが古いと、
    // 必須の項目が1つ増えるだけで報告全体が解けなくなり、カードが1枚も出なくなる
    let a2s = A2s::start("agent-version").await;

    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        let agents = server_core::account::agents_of(&a2s.hub, a2s.account_id)
            .await
            .expect("PC の一覧を読めること");
        if let Some(version) = agents.first().and_then(|agent| agent.version.clone()) {
            assert_eq!(version, env!("CARGO_PKG_VERSION"), "別の版を名乗っている");
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に PC の版が運ばれてきませんでした: {agents:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
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
        let event = tokio::time::timeout(remaining, events.recv())
            .await
            .unwrap_or_else(|_| panic!("{TIMEOUT:?} 以内に中継されませんでした"))
            .expect("配信が閉じていないこと");
        match event.message {
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

// ---------------------------------------------------------------------------
// 画面配信（設計§7、テスト計画フェーズ4）
// ---------------------------------------------------------------------------

/// ブラウザの役で受け取ったフレームを、xterm.js の代わりに vt100 へ書く。
///
/// **フレームの意味論をブラウザと同じに解釈する**のが要点（設計§4-3）。
/// 0x03 は画面を作り直してから書く、0x01 は書き足す——`TerminalPane` の実装と同じ約束で、
/// これが成り立っていることが「フロント無改修」の中身になる。
struct Mirror {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    snapshots: usize,
    outputs: usize,
}

impl Mirror {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 1000),
            cols,
            rows,
            snapshots: 0,
            outputs: 0,
        }
    }

    fn apply(&mut self, framed: &[u8]) {
        let frame = protocol::frame::decode(framed).expect("フレームを分解できること");
        match frame.kind {
            protocol::frame::FrameKind::PtySnapshot => {
                // 「画面をリセットしてから書け」
                self.parser = vt100::Parser::new(self.rows, self.cols, 1000);
                self.parser.process(frame.payload);
                self.snapshots += 1;
            }
            protocol::frame::FrameKind::PtyOutput => {
                self.parser.process(frame.payload);
                self.outputs += 1;
            }
            other => panic!("ブラウザ向けの経路に画面のフレームが漏れています: {other:?}"),
        }
    }

    fn text(&self) -> String {
        self.parser.screen().contents()
    }
}

/// 目印が画面に現れるまでフレームを受け取り続ける。
async fn wait_for_screen(
    frames: &mut tokio::sync::broadcast::Receiver<bytes::Bytes>,
    mirror: &mut Mirror,
    marker: &str,
) {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while !mirror.text().contains(marker) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let received = tokio::time::timeout(remaining, frames.recv())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "{TIMEOUT:?} 以内に {marker:?} が画面へ現れませんでした。実際の画面:\n{}",
                    mirror.text()
                )
            });
        match received {
            Ok(framed) => mirror.apply(&framed),
            Err(err) => panic!("画面の配信が切れました: {err}"),
        }
    }
}

#[tokio::test]
async fn 端末を開くと画面が届き_閉じると止まる() {
    // 検収「配信対象」。**誰も見ていないセッションの画面は1バイトも出ない**（要件5-2）
    let a2s = A2s::start("screen").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;
    let card_id = session.card_id;

    let (blank, mut frames) = a2s
        .browser
        .subscribe_pty(card_id, 1, 100, 30)
        .expect("端末を開けること");

    // 最初に渡されるのは「画面を消せ」だけ。リモートに“いまの生バイト”は存在しない
    let frame = protocol::frame::decode(&blank).expect("フレームを分解できること");
    assert_eq!(frame.kind, protocol::frame::FrameKind::PtySnapshot);
    assert!(frame.payload.is_empty(), "空でない画面が渡されています");

    // PC の中で組み立てられた画面が、ブラウザの意味論のまま再現される
    let mut mirror = Mirror::new(100, 30);
    wait_for_screen(&mut frames, &mut mirror, testkit::fake_claude::READY_MARKER).await;
    assert!(mirror.snapshots > 0, "全画面から始まっていません");

    // 閉じると止まる
    a2s.browser.release_client(card_id, 1);
    tokio::time::sleep(Duration::from_millis(SCREEN_MS * 4)).await;
    while frames.try_recv().is_ok() {}
    common::send_line(&session, "echo とまったはず");
    tokio::time::sleep(Duration::from_millis(SCREEN_MS * 4)).await;
    assert!(
        frames.try_recv().is_err(),
        "閉じたのに画面が流れ続けています"
    );

    session.kill();
}

#[tokio::test]
async fn 入力すると待たずに画面が追いつく() {
    // 設計§7-5 のホットウィンドウ。TUI の描き直しは入力から遅れて届くので、
    // 「入力を受けたら1回だけ返す」では描く前の画面を掴む
    let a2s = A2s::start("screen-hot").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    let (_blank, mut frames) = a2s
        .browser
        .subscribe_pty(session.card_id, 1, 100, 30)
        .expect("端末を開けること");
    let mut mirror = Mirror::new(100, 30);
    wait_for_screen(&mut frames, &mut mirror, testkit::fake_claude::READY_MARKER).await;

    // ブラウザからのキー入力（0x02）と同じ経路で送る
    a2s.browser
        .write_input(session.card_id, "echo ホットウィンドウ\r".as_bytes())
        .expect("端末へ書けること");

    wait_for_screen(&mut frames, &mut mirror, "ホットウィンドウ").await;
    assert!(mirror.outputs > 0, "差分ではなく全画面ばかり送っています");

    session.kill();
}

#[tokio::test]
async fn 大きさを変えると画面が作り直される() {
    // 設計§7-4。PC 側の端末を同じ桁に揃えてから全画面を送り直す
    let a2s = A2s::start("screen-resize").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    let (_blank, mut frames) = a2s
        .browser
        .subscribe_pty(session.card_id, 1, 100, 30)
        .expect("端末を開けること");
    let mut mirror = Mirror::new(100, 30);
    wait_for_screen(&mut frames, &mut mirror, testkit::fake_claude::READY_MARKER).await;
    let before = mirror.snapshots;

    // 開き直し＝新しい大きさでの購読（ブラウザ側の `SubPty` はこの形で届く）
    let (_blank, mut frames) = a2s
        .browser
        .subscribe_pty(session.card_id, 1, 60, 20)
        .expect("端末を開けること");
    let mut mirror = Mirror::new(60, 20);
    wait_for_screen(&mut frames, &mut mirror, testkit::fake_claude::READY_MARKER).await;

    assert!(
        mirror.snapshots > 0,
        "大きさを変えたのに全画面が来ていません（前回 {before} 枚）"
    );
    let (rows, cols) = mirror.parser.screen().size();
    assert_eq!((cols, rows), (60, 20), "画面の大きさが揃っていません");

    session.kill();
}

#[tokio::test]
async fn 画面の設定を変えると動いているセッションにも効く() {
    // 設計§13-3。**次に繋ぎ直すまで古い間隔で送り続けない**のが要点で、動いている
    // セッションの端末を作り直す（遡り行数）ところまで含めて効かせる
    let a2s = A2s::start("screen-intervals").await;
    let (session, _transcript) = a2s.start_session();
    a2s.wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    let screen = session
        .screen()
        .expect("セルフホストなら端末がある")
        .clone();
    assert_eq!(
        screen.scrollback_lines(),
        server_core::db::settings::Intervals::default().scrollback_lines as usize,
        "名乗りの応答で受け取った既定が効いていない"
    );

    a2s.hub
        .set_intervals(
            a2s.account_id,
            server_core::db::settings::Intervals {
                sync_interval_secs: 1,
                screen_interval_ms: 250,
                scrollback_lines: 300,
            },
        )
        .await
        .expect("設定を変えられること");

    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while screen.scrollback_lines() != 300 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に遡り行数が変わりませんでした（{} 行）",
            screen.scrollback_lines()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    session.kill();
}

#[tokio::test]
async fn 読み込んだ間隔は次の接続を待たずに配られる() {
    // **読み込みだけ別の道を作らない**（持ち出し設計§12）。ファイルから入った間隔も
    // `PUT` と同じ経路（`AgentHub::set_intervals`）を通るので、繋がっている PC へ
    // その場で届く。届かないと、次に繋ぎ直すまで古い間隔で送り続ける
    let a2s = A2s::start_full("import-intervals", false, 600).await;
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

    // ファイルを読み込ませる（画面がやることと同じ）
    let addr = a2s.addr;
    let body = format!(
        r#"{{"kind":"{}","format":{},"settings":{{"sync_interval_secs":1}}}}"#,
        server_core::portable::KIND,
        server_core::portable::FORMAT
    );
    let response = tokio::task::spawn_blocking(move || {
        testkit::request(addr, "POST", "/api/settings/import", Some(&body), None)
    })
    .await
    .expect("HTTPスレッドが落ちないこと")
    .expect("応答を読めること");
    assert_eq!(response.status, 200, "{}", response.body);

    let nodes = a2s.wait_for_nodes(session.card_id, 3).await;
    assert_eq!(nodes.len(), 3, "読み込んだ間隔が PC へ配られていない");

    session.kill();
}
