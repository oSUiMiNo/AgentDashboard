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
    state::{HookEvent, HookInput},
    ws::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::Value;

/// `POST /hook/{token}/{event}` の受け口。
pub async fn receive(
    State(state): State<AppState>,
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
