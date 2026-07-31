//! フックの受信口（設計§7 の HookIngest）。
//!
//! セッションに注入した settings は `POST /hook/{token}/{event}` を叩くように書いてある
//! （[`crate::session::hooks_settings`]）。ここで受けたものを状態機械
//! （[`crate::state`]）へ通し、変わった分をブラウザへ配る。
//!
//! # 認証は「合言葉」だけ
//!
//! 待ち受けは 127.0.0.1 のみで、URL にセッションごとのランダムな合言葉を埋めてある。
//! カードIDをそのまま載せていないのは、値が推測できると外から状態を書き換えられてしまう
//! ため。個人用のローカルツールとしてはこれで十分な強度になる。
//!
//! # 遅らせない・拒まない
//!
//! - 応答は即返す。フックは非同期モードで動くとはいえ、SessionEnd だけは CLI 側の
//!   タイムアウトが 1.5 秒しかない
//! - 知らないイベント名は**受け流す**。Claude Code が将来イベントを増やしても、
//!   ダッシュボードが 4xx を返してログを汚すようなことにはしない

use crate::{
    session::SessionManager,
    state::{HookEvent, HookInput},
};
use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    routing::post,
};
use serde_json::Value;
use std::sync::Arc;

/// 受信口が必要とするもの。**ブラウザ向けの状態（`AppState`）とは別に持つ。**
///
/// フックの宛先はどちらのモードでも「エージェントの 127.0.0.1」であり（設計§7）、
/// セルフホストモードではサーバ側の待ち受けとは**別のプロセス・別のポート**になる
/// （設計§5-3）。ここがブラウザ配信側の状態に相乗りしていると、その分離ができない。
#[derive(Clone)]
pub struct HookState {
    pub manager: Arc<SessionManager>,
}

/// フックと `statusLine` の受信口をまとめたルータ。
///
/// ローカルモードではブラウザ向けのルータと同じポートへ合成され（`agentdashboard_core`）、
/// セルフホストモードではエージェント自身のポートで単独に立つ（フェーズ3）。
pub fn routes(manager: Arc<SessionManager>) -> Router {
    Router::new()
        .route("/hook/{token}/{event}", post(receive))
        // 注入した statusLine がいまのモデルを知らせてくる（設計§4）
        .route("/model/{token}", post(receive_model))
        .with_state(HookState { manager })
}

/// フックの受信口を**自分のポートで**開く（セルフホスト化設計§5-3）。
///
/// # 先にポートを確定させてから設定を作る
///
/// 注入する settings にはフックの宛先 URL が焼き込まれるので、**セッションを起こす前に
/// 番号が決まっていないと届かない**。だから「開く」と「配る」を2つに分けてある——
/// 呼び出し側は [`bind`] で番号を取り、その番号を `AgentConfig::hook_port` に入れて
/// マネージャを作り、最後に [`serve`] を呼ぶ。
///
/// 待ち受けは **127.0.0.1 のみ**。フックの宛先はどちらのモードでも PC の中で、
/// ネットワークへ出す理由が無い（要件7）。
pub async fn bind(port: u16) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let bound = listener.local_addr()?.port();
    Ok((listener, bound))
}

/// [`bind`] で取った待ち受けでフックを受け始める。
pub fn serve(listener: tokio::net::TcpListener, manager: Arc<SessionManager>) {
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, routes(manager)).await {
            // ここが落ちると状態が永久に「不明」のままになる。黙って終わらない
            tracing::error!("フックの受信口が止まりました: {err}");
        }
    });
}

/// `POST /hook/{token}/{event}` の受け口。
pub async fn receive(
    State(state): State<HookState>,
    Path((token, event)): Path<(String, String)>,
    body: String,
) -> StatusCode {
    let Some(session) = state.manager.resolve_token(&token) else {
        // カードの存在を漏らさないため、合言葉違いは一律で「そんなURLは無い」とする
        return StatusCode::NOT_FOUND;
    };

    let Some(event) = HookEvent::parse(&event) else {
        tracing::debug!("注入していないフックイベントを受け取りました: {event}");
        return StatusCode::NO_CONTENT;
    };

    // 壊れたJSONでも受け流す。フックの中身が読めないことより、CLI 側を止めない方が大事
    let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    state
        .manager
        .handle_hook(&session, &HookInput::new(event, payload));

    StatusCode::NO_CONTENT
}

/// `POST /model/{token}` の受け口（設計§4）。
///
/// 注入した `statusLine` が、セッションの JSON をそのまま送ってくる。フックと同じ
/// 合言葉を使い回すので、認証の考え方も同じ（127.0.0.1 のみ＋推測できない合言葉）。
///
/// # 使うのは3つのキーだけ
///
/// 届く JSON には12個のキーが入っている（設計§11 前提1）が、読むのは `model.id` と
/// `model.display_name` だけ。**残りは読まない。** CLI 側がキーを増減しても、
/// ここが壊れないようにするため。
///
/// # 変わったときだけ配る
///
/// `refreshInterval` の周期で届くので、毎回カードを送り直すとセッション数だけ無駄が
/// 積み上がる。値が動いたときだけ配信する（フックの `permission_mode` と同じ判断）。
pub async fn receive_model(
    State(state): State<HookState>,
    Path(token): Path<String>,
    body: String,
) -> StatusCode {
    let Some(session) = state.manager.resolve_token(&token) else {
        return StatusCode::NOT_FOUND;
    };

    // 壊れた JSON でも受け流す。statusLine を止めない方が大事
    let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    let Some(id) = payload
        .get("model")
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        tracing::debug!("statusLine の payload に model.id がありません");
        return StatusCode::NO_CONTENT;
    };
    let label = payload
        .get("model")
        .and_then(|model| model.get("display_name"))
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty())
        .map(str::to_string);

    state
        .manager
        .apply_model_report(&session, protocol::ModelId::new(id), label);

    StatusCode::NO_CONTENT
}
