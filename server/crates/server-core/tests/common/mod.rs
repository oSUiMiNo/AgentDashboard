//! DB のテストを **SQLite と PostgreSQL の両方へ同じコードで**通すための足場
//! （セルフホスト化設計§3-2・§15-3、テスト計画フェーズ2 の最終項目）。
//!
//! # なぜ両方へ通すのか
//!
//! 「共有するのはスキーマ」が本設計の前提なので、**SQLite では通るのに PostgreSQL で
//! 落ちる**という食い違いが最も痛い。型の厳密さ（SQLite は動的型・PostgreSQL は静的型）、
//! JSON の扱い、主キーに NULL を置けるか——どれも片方でしか出ない。ローカルで書いた
//! コードがセルフホストで初めて壊れるのを、この足場が手前で止める。
//!
//! # 走り方
//!
//! - `make ci`：SQLite だけ（PostgreSQL は用意されていないので黙って飛ばす）
//! - `make test-compose`：`AGENTDASHBOARD_TEST_DATABASE_URL` が指す PostgreSQL も加える
//!
//! **飛ばしたことは黙らない。** 環境変数が無いときは理由を印字する。「両方通した」と
//! 「片方しか走っていない」を見分けられないと、この足場は意味を失う。

#![allow(dead_code)]

use sea_orm::{ConnectionTrait as _, Database, DatabaseConnection};
use std::path::PathBuf;

/// PostgreSQL 側の接続先を指す環境変数（`make test-compose` が設定する）。
///
/// 指すのは**管理用のデータベース**で、テストごとに使い捨ての DB をこの接続から作る。
pub const PG_URL_ENV: &str = "AGENTDASHBOARD_TEST_DATABASE_URL";

/// テスト1本ぶんの DB。
pub struct Backend {
    /// 落ちたときにどちらで落ちたか分かるようにする名札
    pub name: &'static str,
    pub db: DatabaseConnection,
    /// 同じ DB へ繋ぎ直すための接続文字列（マイグレーションの冪等性を見るのに要る）
    pub url: String,
    cleanup: Cleanup,
}

enum Cleanup {
    /// SQLite：ファイルごと消す
    File(PathBuf),
    /// PostgreSQL：管理用接続から使い捨て DB を落とす
    Database { admin_url: String, name: String },
}

impl Backend {
    /// 後始末。**テストの最後に必ず呼ぶ**（呼ばないと使い捨て DB が溜まる）。
    pub async fn finish(self) {
        let Backend { db, cleanup, .. } = self;
        let _ = db.close().await;
        match cleanup {
            Cleanup::File(path) => {
                let _ = std::fs::remove_file(&path);
                // SQLite は WAL とジャーナルを隣に作る
                for suffix in ["-wal", "-shm", "-journal"] {
                    let mut sidecar = path.clone().into_os_string();
                    sidecar.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(sidecar));
                }
            }
            Cleanup::Database { admin_url, name } => {
                if let Ok(admin) = Database::connect(admin_url).await {
                    let _ = admin
                        .execute_unprepared(&format!(r#"DROP DATABASE IF EXISTS "{name}""#))
                        .await;
                    let _ = admin.close().await;
                }
            }
        }
    }
}

/// このテストで使う DB を全部用意する。
///
/// `label` はテストの名札。使い捨ての置き場所の名前に混ぜて、並行して走る他のテストと
/// ぶつからないようにする（nextest はテストごとにプロセスを分けるが、PostgreSQL は
/// 共有なのでこちらで分ける必要がある）。
pub async fn backends(label: &str) -> Vec<Backend> {
    let mut backends = vec![sqlite(label).await];
    match std::env::var(PG_URL_ENV) {
        Ok(url) if !url.is_empty() => backends.push(postgres(label, &url).await),
        _ => eprintln!(
            "[{label}] PostgreSQL は飛ばしました（{PG_URL_ENV} が未設定）。両方で確かめるには make test-compose"
        ),
    }
    backends
}

async fn sqlite(label: &str) -> Backend {
    let path = std::env::temp_dir().join(format!(
        "agentdashboard-test-{label}-{}.db",
        uuid::Uuid::new_v4().simple()
    ));
    let url = format!("sqlite://{}", path.display());
    let db = server_core::db::connect(&url)
        .await
        .expect("SQLite へ繋げること");
    Backend {
        name: "sqlite",
        db,
        url,
        cleanup: Cleanup::File(path),
    }
}

async fn postgres(label: &str, admin_url: &str) -> Backend {
    // 使い捨ての DB を1つ作る。スキーマを共有すると、並行して走るテストが互いの行を見る
    let name = format!("adash_test_{label}_{}", uuid::Uuid::new_v4().simple());
    let admin = Database::connect(admin_url)
        .await
        .expect("PostgreSQL の管理用接続を開けること");
    admin
        .execute_unprepared(&format!(r#"CREATE DATABASE "{name}""#))
        .await
        .expect("使い捨てのデータベースを作れること");
    let _ = admin.close().await;

    let url = replace_database(admin_url, &name);
    let db = server_core::db::connect(&url)
        .await
        .expect("PostgreSQL へ繋げること");
    Backend {
        name: "postgres",
        db,
        url,
        cleanup: Cleanup::Database {
            admin_url: admin_url.to_string(),
            name,
        },
    }
}

/// 接続文字列のデータベース名だけを差し替える。
fn replace_database(url: &str, name: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (url, None),
    };
    // `postgres://user:pass@host:port/dbname` の最後の `/` から後ろが名前
    let stem = match base.rfind('/') {
        Some(at) if at > "postgres://".len() => &base[..at],
        _ => base,
    };
    match query {
        Some(query) => format!("{stem}/{name}?{query}"),
        None => format!("{stem}/{name}"),
    }
}

// --- エージェントの役をするための道具（`gateway.rs` と `tenancy.rs` が使う）---------
//
// **写さずに共有する。** 同じものを2つ持つと片方だけが古くなり、しかもここは
// 「他人のカードへ報告しても通らない」を確かめる側なので、古い写しが通ってしまうと
// 検査そのものが嘘になる。

use futures_util::{SinkExt as _, StreamExt as _};
use protocol::{
    CardId, ProjectId, SessionMeta, SessionStatus,
    a2s::{A2S_PROTOCOL, A2S_VERSION, AgentMessage, ServerToAgent},
};
use std::time::Duration;
use tokio_tungstenite::tungstenite;

/// 待ち合わせの上限。
pub const AGENT_TIMEOUT: Duration = Duration::from_secs(10);

/// エージェントとして繋ぐ。版とトークンは呼び出し側が決める（断られ方も試すため）。
pub async fn connect_agent(
    addr: std::net::SocketAddr,
    token: Option<&str>,
    protocol: Option<&str>,
) -> Result<AgentSocket, tungstenite::Error> {
    let mut request = tungstenite::client::IntoClientRequest::into_client_request(format!(
        "ws://{addr}/agent/ws"
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
    Ok(AgentSocket { socket })
}

/// 名乗りまで済ませて繋ぐ（普通の使い方）。
pub async fn connect_agent_as(addr: std::net::SocketAddr, token: &str, name: &str) -> AgentSocket {
    let mut socket = connect_agent(addr, Some(token), Some(A2S_PROTOCOL))
        .await
        .expect("繋げること");
    socket.send(&hello(name)).await;
    socket
}

pub struct AgentSocket {
    pub socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl AgentSocket {
    pub async fn send(&mut self, message: &AgentMessage) {
        let text = serde_json::to_string(message).expect("組み立てられること");
        self.socket
            .send(tungstenite::Message::text(text))
            .await
            .expect("送れること");
    }

    /// 画面のフレームを送る（設計§4-3。JSON に包まずバイナリのまま）。
    pub async fn send_screen(
        &mut self,
        kind: protocol::frame::FrameKind,
        card_id: CardId,
        seq: u64,
    ) {
        let bytes = protocol::frame::encode_screen(kind, card_id, seq, b"\x1b[2J\x1b[Hhello");
        self.socket
            .send(tungstenite::Message::Binary(bytes.into()))
            .await
            .expect("送れること");
    }

    /// 条件に合う指示が来るまで受け取り続ける。
    pub async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&ServerToAgent) -> bool,
    ) -> ServerToAgent {
        let deadline = tokio::time::Instant::now() + AGENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let next = tokio::time::timeout(remaining, self.socket.next())
                .await
                .unwrap_or_else(|_| panic!("{AGENT_TIMEOUT:?} 以内に {what} が届きませんでした"));
            match next {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    let message = serde_json::from_str::<ServerToAgent>(&text)
                        .unwrap_or_else(|err| panic!("解釈できません（{err}）: {text}"));
                    if matches(&message) {
                        return message;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("{what} を待っている間に切れました: {other:?}"),
            }
        }
    }
}

pub fn hello(name: &str) -> AgentMessage {
    AgentMessage::Hello {
        protocol_version: A2S_VERSION,
        agent_version: "テスト".to_string(),
        agent_name: name.to_string(),
        available_modes: vec![protocol::PermissionMode::new("default")],
        always_bypass_permissions: false,
    }
}

pub fn meta(card_id: CardId) -> SessionMeta {
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
        // **エージェントが何を書いて寄越しても**、記録に残る帰属は接続が決める（§8-5）
        agent_id: Some(protocol::AgentId::new()),
        agent_connected: true,
        account: Some("なりすまし".to_string()),
        toml_account: None,
    }
}
