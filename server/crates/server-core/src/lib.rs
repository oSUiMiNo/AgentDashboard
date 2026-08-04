//! ダッシュボードサーバ側のロジック（セルフホスト化設計§2-1）。
//!
//! ブラウザとの WebSocket・REST・web アセットの配信を持つ。**PTY には触らない**のが
//! このクレートの存在理由で、PC 側へは境界 trait（[`agent::AgentHost`]）越しにしか
//! 触れない。境界が守られていることは `crates/core/tests/dependencies.rs` が機械で検査する。
//!
//! ローカルモードでは [`agent_core`] と同じプロセスに同居し、境界はプロセス内の直結に
//! なる。セルフホストモードでは同じ境界の向こうが A2S 越しのセッションホストに変わる
//! （設計§2-3）。**どちらのモードでもブラウザから見た口は変わらない。**
//!
//! [`agent_core`]: https://docs.rs/agent-core

pub mod account;
pub mod agent;
pub mod auth;
pub mod bus;
pub mod cluster;
pub mod config;
pub mod db;
pub mod embed;
pub mod gateway;
pub mod portable;
pub mod registry;
pub mod transcript;
pub mod ws;

use axum::{
    Router,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use std::sync::Arc;

/// ブラウザ向けのルート一式。
///
/// 口は2種類だけ。`/ws` が WebSocket、`/api/*` がスナップショットと履歴の遡り。
/// 残りはすべて同梱した web アセットの配信にまわる。
///
/// フックの受信（`/hook/*`・`/model/*`）は**ここには入らない**。宛先はどちらのモードでも
/// セッションホストの 127.0.0.1 で、セルフホストモードでは別プロセスの別ポートになる
/// （セルフホスト化設計§5-3）。合成するのは両者を束ねる側の仕事。
///
/// # 鍵がかかるのは中身のある口だけ
///
/// web アセット（[`static_handler`]）と認証の口（[`auth::routes`]）は素通しにしてある。
/// 画面そのものを 401 にすると「ログイン画面を出す」手段が無くなるし、認証の要否を
/// 知るのに認証が要るという循環もできる。**中身は返さないが、扉は開ける。**
pub fn routes(state: ws::AppState, auth: Arc<auth::AuthContext>) -> Router {
    let protected = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/api/sessions", get(ws::api_sessions))
        .route(
            "/api/sessions/{card_id}/transcript",
            get(ws::api_transcript),
        )
        .with_state(state);

    guard(protected, Arc::clone(&auth))
        .merge(auth::routes(auth))
        .fallback(get(static_handler))
}

/// 鍵をかける（設計§8-6）。
///
/// enforcement の要求は「漏れなく総当たり」なので、**通す口を1つの関数の向こうへ集める**。
/// ルータごとに middleware を書き並べると、新しい口を足したときに付け忘れる。
pub fn guard(router: Router, auth: Arc<auth::AuthContext>) -> Router {
    router.layer(axum::middleware::from_fn_with_state(
        auth,
        auth::require_identity,
    ))
}

/// 同梱した web アセットを配信する。
///
/// 見つからないパスのうち、拡張子を持たないものは SPA のルーティング（`/s/<id>` など）と
/// みなして `index.html` を返す。拡張子があるのに見つからない場合は本当に無いので 404 に
/// する（欠けた JS の代わりに HTML を返すと、原因の分からない実行時エラーになる）。
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(data) = embed::get(path) {
        return ([(header::CONTENT_TYPE, embed::content_type(path))], data).into_response();
    }

    let looks_like_file = path
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'));
    if !looks_like_file && let Some(data) = embed::get("index.html") {
        return (
            [(header::CONTENT_TYPE, embed::content_type("index.html"))],
            data,
        )
            .into_response();
    }

    (StatusCode::NOT_FOUND, format!("見つかりません: /{path}")).into_response()
}
