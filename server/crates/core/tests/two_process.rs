//! 2つの実行ファイルを本当に起こして繋ぐ（セルフホスト化設計§1-1・§14-4、テスト計画フェーズ3）。
//!
//! `a2s.rs` は同じプロセスの中に2つの役を立てていて、**配線の正しさ**を見る。こちらは
//! `agentdashboard --mode server` と `agentdashboard-agent` を**別々のプロセスとして
//! 起動する**ので、そこでしか出ない食い違い——設定の読み方、トークンの受け渡し、
//! フックの宛先ポート、起動の順序——を捕まえる。
//!
//! 検収条件「エージェント：ペアリング接続」と、5分セットアップ（§14-4）の手順3〜4を
//! 機械で通す形にあたる。
//!
//! 本物の claude は起こさない（`AGENTDASHBOARD_CLAUDE_BIN` で擬似 claude を指す）。

#![allow(non_snake_case)]

mod common;

use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    SessionMeta, SessionStatus,
    ws::{ClientMessage, ServerMessage},
};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(30);

/// 起こした2つのプロセス。
struct Pair {
    dir: PathBuf,
    addr: SocketAddr,
    server: Child,
    agent: Option<Child>,
    /// ログイン後の入館証。REST も `/ws` も同じ Cookie で通す（設計§8-2）
    cookie: Option<String>,
}

/// セットアップで作る管理者。**テストの中だけの値**なので伏せる意味は無い。
const ACCOUNT: &str = "テスト管理者";
const PASSWORD: &str = "つよいあいことば";

impl Drop for Pair {
    fn drop(&mut self) {
        // **必ず畳む。** 残すと次のテストが同じポートで待ち受けられない
        if let Some(agent) = &mut self.agent {
            let _ = agent.kill();
            let _ = agent.wait();
        }
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 空いているポートを1つ選ぶ。
///
/// 掴んで離すので厳密には競合しうるが、**子プロセスへは番号でしか渡せない**
/// （待ち受けそのものを渡せない）。使い捨ての DB と同じく、番号がぶつかったら
/// そのテストが落ちるだけで、他へは波及しない。
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
    listener.local_addr().expect("番号を読めること").port()
}

impl Pair {
    /// サーバとエージェントを両方起こす。
    async fn start(label: &str) -> Self {
        let (mut pair, token) = Self::start_server_only(label).await;
        pair.start_agent(&token).await;
        pair
    }

    /// サーバだけ起こす（発行したトークンも返す）。
    async fn start_server_only(label: &str) -> (Self, String) {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-2p-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(dir.join("state")).expect("作業ディレクトリを作れること");

        let port = free_port();
        let addr: SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .expect("番号を読めること");
        let config_path = dir.join("config.toml");
        std::fs::write(
            &config_path,
            format!(
                "port = {port}\nstate_dir = \"{state}\"\ndatabase_url = \"sqlite://{db}\"\n",
                state = dir.join("state").display(),
                db = dir.join("dashboard.db").display(),
            ),
        )
        .expect("サーバの設定を書けること");

        // 1. トークンを発行する（5分セットアップの手順3）。**平文はここでしか手に入らない**
        let issued = Command::new(testkit::binary_path("agentdashboard"))
            .arg("--config")
            .arg(&config_path)
            .arg("pair-token")
            .arg("--account")
            .arg("テスト用")
            .output()
            .expect("トークンを発行できること");
        assert!(
            issued.status.success(),
            "発行に失敗しました: {}",
            String::from_utf8_lossy(&issued.stderr)
        );
        let token = String::from_utf8_lossy(&issued.stdout).trim().to_string();
        assert!(token.starts_with("adp_"), "実際: {token}");

        // 2. サーバを起こす
        let server = Command::new(testkit::binary_path("agentdashboard"))
            .arg("--config")
            .arg(&config_path)
            .arg("--mode")
            .arg("server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("サーバを起動できること");

        let mut pair = Self {
            dir: dir.clone(),
            addr,
            server,
            agent: None,
            cookie: None,
        };
        // 認証は「認証が要るかどうか」を答える口だけ素通し（設計§8-2）。
        // 起動待ちにはこちらを使う——`/api/sessions` は鍵の向こうなので、
        // 待ちに使うと「まだ起きていない」と「ログインしていない」が同じ 401 になる
        wait_for("サーバが応答する", || async {
            pair.get("/api/me")
                .await
                .is_some_and(|(code, _)| code == 200)
        })
        .await;
        // 3. 管理者を作って入る（5分セットアップの手順2）。**開いているのは最初の一度きり**
        pair.setup_admin().await;

        (pair, token)
    }

    /// エージェントを起こす（手順4）。**設定はファイルで渡す**——実運用と同じ形で
    /// 読めることまで確かめたいので、環境変数だけで済ませない。
    async fn start_agent(&mut self, token: &str) {
        let dir = self.dir.clone();
        let port = self.addr.port();
        let agent_config = dir.join("agent.toml");
        std::fs::write(
            &agent_config,
            format!(
                "server_url = \"http://127.0.0.1:{port}\"\n\
                 pairing_token = \"{token}\"\n\
                 agent_name = \"テスト用PC\"\n\
                 state_dir = \"{state}\"\n\
                 claude_settings_path = \"{settings}\"\n\
                 selfheal_enabled = false\n",
                state = dir.join("agent-state").display(),
                settings = dir.join("claude-settings.json").display(),
            ),
        )
        .expect("エージェントの設定を書けること");

        self.agent = Some(spawn_agent(&agent_config));
        // **繋がったことは「この PC が名乗った能力」で分かる。** 権限モードは
        // 起動している CLI にしか聞けないので、空でなくなった時点で Hello が渡っている
        let here = &*self;
        wait_for("エージェントが名乗る", || async {
            !here.available_modes().await.is_empty()
        })
        .await;
    }

    /// 繋がっている PC が名乗った権限モード（誰も繋がっていなければ空）。
    async fn available_modes(&self) -> Vec<String> {
        let Some((_, body)) = self.get("/api/settings").await else {
            return Vec::new();
        };
        let view: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        view["available_modes"]
            .as_array()
            .map(|modes| {
                modes
                    .iter()
                    .filter_map(|mode| mode.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 最初の管理者を作り、その入館証を持ち回る。
    ///
    /// セルフホストは**ログインしないと何も見えない**（§8-6）ので、ブラウザの役をする
    /// テストはここを通る必要がある。素通しにすると、認証の入った経路を一度も踏まないまま
    /// 緑になる。
    async fn setup_admin(&mut self) {
        let addr = self.addr;
        let body = serde_json::json!({ "name": ACCOUNT, "password": PASSWORD }).to_string();
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "POST", "/api/setup", Some(&body), None)
        })
        .await
        .expect("スレッドが落ちないこと")
        .expect("セットアップの応答を読めること");
        assert_eq!(response.status, 200, "管理者を作れない: {}", response.body);
        self.cookie = response.cookie;
        assert!(self.cookie.is_some(), "入館証が発行されていない");
    }

    async fn get(&self, path: &str) -> Option<(u16, String)> {
        let (addr, path, cookie) = (self.addr, path.to_string(), self.cookie.clone());
        tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, cookie.as_deref())
        })
        .await
        .ok()?
        .ok()
        .map(|response| (response.status, response.body))
    }

    async fn sessions(&self) -> Vec<SessionMeta> {
        let Some((_, body)) = self.get("/api/sessions").await else {
            return Vec::new();
        };
        serde_json::from_str(&body).unwrap_or_default()
    }

    /// ブラウザの役で `/ws` へ繋ぐ。
    async fn browser(&self) -> Browser {
        // **入館証を載せて繋ぐ。** `/ws` も REST と同じ Cookie で認証する（§8-2）ので、
        // 載せないと upgrade の手前で 401 になる
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://{}/ws", self.addr))
            .header("Host", self.addr.to_string())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .header("Cookie", self.cookie.clone().unwrap_or_default())
            .body(())
            .expect("要求を組み立てられること");
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ブラウザとして繋げること");
        Browser { socket }
    }

    fn kill_agent(&mut self) {
        if let Some(agent) = &mut self.agent {
            let _ = agent.kill();
            let _ = agent.wait();
        }
        self.agent = None;
    }
}

struct Browser {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl Browser {
    async fn send(&mut self, message: &ClientMessage) {
        let text = serde_json::to_string(message).expect("組み立てられること");
        self.socket
            .send(tokio_tungstenite::tungstenite::Message::text(text))
            .await
            .expect("送れること");
    }

    /// 条件に合う知らせが届くまで受け取り続ける。
    async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&ServerMessage) -> bool,
    ) -> ServerMessage {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let next = tokio::time::timeout(remaining, self.socket.next())
                .await
                .unwrap_or_else(|_| panic!("{TIMEOUT:?} 以内に {what} が届きませんでした"));
            match next {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ServerMessage>(&text)
                        && matches(&message)
                    {
                        return message;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("{what} を待っている間に切れました: {other:?}"),
            }
        }
    }
}

#[tokio::test]
async fn ペアリングして起動しフックまで通る() {
    let mut pair = Pair::start("full").await;

    // 起動の指示はブラウザから。**採番するのは PC 側**なので、できたカードは
    // `SessionUpsert` で返ってくる（設計§5-2）
    let mut browser = pair.browser().await;
    let cwd = pair.dir.join("project");
    std::fs::create_dir_all(&cwd).expect("作業ディレクトリを作れること");
    browser
        .send(&ClientMessage::Spawn {
            cwd: cwd.to_string_lossy().into_owned(),
            permission_mode: None,
            // 繋がっているのは1台だけなので、宛先は選ばない
            agent_id: None,
        })
        .await;

    let message = browser
        .wait_for("カードができる", |message| {
            matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;
    let ServerMessage::SessionUpsert { session } = message else {
        unreachable!()
    };
    let card_id = session.card_id;
    assert!(
        session.agent_id.is_some(),
        "どの PC のカードか分からないまま記録されている"
    );
    assert_eq!(session.account.as_deref(), Some("テスト用"));

    // 擬似 claude に、**注入された settings のフックを実際に起動させる**。
    // ここが通れば「焼き込み → エージェントの 127.0.0.1 → 状態導出 → A2S → 記録」が
    // 端から端まで成立している（実機検証#5 の自動化）
    browser
        .send(&ClientMessage::SendInput {
            card_id,
            text: "hook UserPromptSubmit".to_string(),
        })
        .await;

    wait_for("作業中になる", || async {
        pair.sessions()
            .await
            .iter()
            .any(|meta| meta.card_id == card_id && meta.status == SessionStatus::Working)
    })
    .await;

    // エージェントを落とすと、接続断の印だけが付く（状態は最後の既知のまま）
    pair.kill_agent();
    wait_for("接続断になる", || async {
        pair.sessions()
            .await
            .iter()
            .any(|meta| meta.card_id == card_id && !meta.agent_connected)
    })
    .await;

    let listed = pair.sessions().await;
    let meta = listed
        .iter()
        .find(|meta| meta.card_id == card_id)
        .expect("カードが残っていること");
    assert_eq!(
        meta.status,
        SessionStatus::Working,
        "接続が切れただけで状態まで書き換えている"
    );
}

#[tokio::test]
async fn 認められないトークンでは繋がらない() {
    // 発行していないトークンで起動しても、**1台も繋がらない**。エージェントの側は
    // 繋がるまで試し直し続けるので、断り続けられていることを外から見る
    let (pair, _token) = Pair::start_server_only("bad-token").await;
    assert!(
        pair.available_modes().await.is_empty(),
        "まだ誰も繋がっていないこと"
    );

    let agent_config = pair.dir.join("bad-agent.toml");
    std::fs::write(
        &agent_config,
        format!(
            "server_url = \"http://{}\"\n\
             pairing_token = \"adp_でたらめ\"\n\
             agent_name = \"にせのPC\"\n\
             state_dir = \"{}\"\n\
             selfheal_enabled = false\n",
            pair.addr,
            pair.dir.join("bad-state").display(),
        ),
    )
    .expect("設定を書けること");

    let mut liar = spawn_agent(&agent_config);
    // 何度か試し直すだけの時間を与える（初回は 0.5 秒後、次は 1 秒後…）
    tokio::time::sleep(Duration::from_secs(3)).await;

    assert!(
        pair.available_modes().await.is_empty(),
        "認められないトークンの PC が繋がっている"
    );

    let _ = liar.kill();
    let _ = liar.wait();
}

/// 条件が満たされるまで待つ。
///
/// `Pair` のメソッドにしていないのは、**待つ間ずっと `Pair` を借りたままにしない**ため。
/// 途中でエージェントを畳む（`&mut`）テストがあるので、借りる範囲は短いほうがよい。
async fn wait_for<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if check().await {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{TIMEOUT:?} 以内に「{what}」になりませんでした"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// エージェントを1つ起こす。**本物の claude は起こさない**（E2E と同じ差し替え口）。
fn spawn_agent(config: &Path) -> Child {
    Command::new(testkit::binary_path("agentdashboard-agent"))
        .arg("--config")
        .arg(config)
        .env(
            agent_core::session::lifecycle::CLAUDE_BIN_ENV,
            common::fake_claude(),
        )
        .env(agent_core::parser::PARSER_BIN_ENV, common::parser_program())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("エージェントを起動できること")
}
