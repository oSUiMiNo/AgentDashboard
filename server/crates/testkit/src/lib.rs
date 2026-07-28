//! テスト用のヘルパ群（テスト計画フェーズ1「テストヘルパ実装」）。
//!
//! 本番コードからは参照しない。提供するのは次の2つ。
//!
//! - [`MockHookServer`] … Claude Code のフックスクリプトが叩く先を模したHTTPサーバ。
//!   実機検証で使った受信サーバのテスト版にあたる。受け取った payload を蓄えておき、
//!   テストから「どのイベントが何回、どんな中身で届いたか」を検証できる
//! - `fake-claude` バイナリ … PTY 越しに決められた応答を返す擬似 CLI。本物の claude を
//!   起動せずに PTY のライフサイクル（起動→読み書き→終了）を検証するためのハーネス

use axum::{
    Router,
    extract::{Path, State},
    routing::post,
};
use std::{
    io::{Read as _, Write as _},
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

/// モックサーバが受信した1件のフック。
#[derive(Debug, Clone, PartialEq)]
pub struct ReceivedHook {
    /// URL パスに含まれるセッション毎のトークン（設計§7 の認証）
    pub token: String,
    /// フックイベント名（PreToolUse / Stop など）
    pub event: String,
    /// フックが stdin から受け取ったJSONそのもの。パースできない場合は `Null`
    pub payload: serde_json::Value,
    /// パースできなかった場合に原文を確認するための生ボディ
    pub raw_body: String,
}

#[derive(Clone, Default)]
struct HookState {
    received: Arc<Mutex<Vec<ReceivedHook>>>,
}

/// `POST /hook/{token}/{event}` を受けて内容を記録するだけのテスト用サーバ。
///
/// 127.0.0.1 のポート0で待ち受ける（OSに空きポートを選ばせる）。設計§7 と同じく
/// ループバックにしかバインドしないので、テスト中に外部へ露出することはない。
pub struct MockHookServer {
    addr: SocketAddr,
    state: HookState,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl MockHookServer {
    pub async fn start() -> anyhow::Result<Self> {
        let state = HookState::default();
        let app = Router::new()
            .route("/hook/{token}/{event}", post(receive_hook))
            .with_state(state.clone());

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            addr,
            state,
            shutdown: Some(shutdown_tx),
            handle: Some(handle),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// セッションに注入する settings へ書き込む形の URL を組み立てる。
    pub fn hook_url(&self, token: &str, event: &str) -> String {
        format!("http://{}/hook/{token}/{event}", self.addr)
    }

    /// これまでに受信したフックを時系列で返す。
    pub fn received(&self) -> Vec<ReceivedHook> {
        self.state
            .received
            .lock()
            .expect("ロックが壊れていない")
            .clone()
    }

    pub fn received_count(&self) -> usize {
        self.state
            .received
            .lock()
            .expect("ロックが壊れていない")
            .len()
    }

    /// サーバを停止する。
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for MockHookServer {
    fn drop(&mut self) {
        // shutdown() を呼ばずに落とされてもタスクを残さない
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

async fn receive_hook(
    State(state): State<HookState>,
    Path((token, event)): Path<(String, String)>,
    body: String,
) -> &'static str {
    // テストダブルなので、壊れたJSONが来ても拒否せず記録する。
    // 「何が届いたか」を観測するのが役目で、検証するのはテスト側の責務。
    let payload = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    state
        .received
        .lock()
        .expect("ロックが壊れていない")
        .push(ReceivedHook {
            token,
            event,
            payload,
            raw_body: body,
        });
    ""
}

/// 依存を増やさずに JSON を POST するための最小HTTPクライアント。
///
/// テストからモックサーバを叩くためだけのもの。HTTPステータスコードを返す。
pub fn post_json(addr: SocketAddr, path: &str, body: &str) -> anyhow::Result<u16> {
    let mut stream = std::net::TcpStream::connect(addr)?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;

    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!("HTTPステータス行を読めません: {response:?}"))?;
    Ok(status)
}
