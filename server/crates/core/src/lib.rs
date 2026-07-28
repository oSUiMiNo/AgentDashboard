//! AgentDashboard の core（設計§1）。
//!
//! セッションの起動と管理（[`session`]）、ブラウザとの WebSocket（[`ws`]）、設定の読み込み
//! （[`config`]）、フロントエンドの同梱配信（[`embed`]）を持つ。
//!
//! 実行ファイル（`agentdashboard`）は薄い入口で、中身はすべてこのライブラリ側にある。
//! こうしているのは、統合テストからサーバの組み立てをそのまま呼べるようにするため
//! （バイナリだけのクレートは `tests/` から参照できない）。

pub mod config;
pub mod embed;
pub mod session;
pub mod ws;

use axum::{
    Router,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use config::Config;
use session::SessionManager;
use std::{net::Ipv4Addr, sync::Arc};

/// サーバのルーティングを組み立てる。
///
/// `/ws` だけが WebSocket で、残りはすべて同梱した web アセットの配信にまわる。
pub fn build_router(state: ws::AppState) -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        .fallback(get(static_handler))
        .with_state(state)
}

/// 設定からサーバ一式を組み立てて起動する。
///
/// バインド先は **127.0.0.1 のみ**（設計§7）。個人用のローカルツールなので、外部から
/// 触れる経路をそもそも作らない。
pub async fn serve(config: Config) -> anyhow::Result<()> {
    let config = Arc::new(config);
    let manager = SessionManager::new(Arc::clone(&config));
    tracing::info!("起動する CLI: {}", manager.program());

    let state = ws::AppState::new(manager, Arc::clone(&config));
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port)).await?;
    let address = listener.local_addr()?;

    tracing::info!("AgentDashboard を起動しました: http://{address}");
    if embed::list().is_empty() {
        // ビルド順を間違えると起きる。黙って空白のページを返すより理由を出す
        tracing::warn!(
            "web アセットが同梱されていません。`make build` で web を先にビルドしてください"
        );
    }

    axum::serve(listener, build_router(state)).await?;
    Ok(())
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
