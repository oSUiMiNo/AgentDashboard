//! AgentDashboard の core（設計§1）。
//!
//! セッションの起動と管理（[`session`]）、ブラウザとの WebSocket（[`ws`]）、設定の読み込み
//! （[`config`]）、フロントエンドの同梱配信（[`embed`]）を持つ。
//!
//! 実行ファイル（`agentdashboard`）は薄い入口で、中身はすべてこのライブラリ側にある。
//! こうしているのは、統合テストからサーバの組み立てをそのまま呼べるようにするため
//! （バイナリだけのクレートは `tests/` から参照できない）。

pub mod claude_settings;
pub mod config;
pub mod embed;
pub mod hook_post;
pub mod hooks;
pub mod jsonfile;
pub mod model_aliases;
pub mod model_catalog;
pub mod model_post;
pub mod parser;
pub mod selfheal;
pub mod session;
pub mod settings;
pub mod state;
pub mod transcript;
pub mod ws;

use axum::{
    Router,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use config::Config;
use session::SessionManager;
use std::{net::Ipv4Addr, sync::Arc};

/// サーバのルーティングを組み立てる。
///
/// 口は3つだけ。`/ws` が WebSocket、`/api/*` がブラウザ向けのスナップショット、
/// `/hook/*` がフックからの通知（設計§7）。残りはすべて同梱した web アセットの配信にまわる。
pub fn build_router(state: ws::AppState) -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/api/sessions", get(ws::api_sessions))
        .route(
            "/api/sessions/{card_id}/transcript",
            get(ws::api_transcript),
        )
        // 設定は接続のたびに流すほど変わらないので、WebSocket ではなく REST に置く
        .route(
            "/api/settings",
            get(ws::api_settings).put(ws::api_update_settings),
        )
        .route("/hook/{token}/{event}", post(hooks::receive))
        // 注入した statusLine がいまのモデルを知らせてくる（設計§4）
        .route("/model/{token}", post(hooks::receive_model))
        .fallback(get(static_handler))
        .with_state(state)
}

/// 設定からサーバ一式を組み立てて起動する。
///
/// バインド先は **127.0.0.1 のみ**（設計§7）。個人用のローカルツールなので、外部から
/// 触れる経路をそもそも作らない。
pub async fn serve(config: Config, config_path: std::path::PathBuf) -> anyhow::Result<()> {
    let config = Arc::new(config);
    let manager = SessionManager::new(Arc::clone(&config));
    tracing::info!("起動する CLI: {}", manager.program());

    // その CLI が受け付ける権限モードを1回だけ読む（設計§3）。`--help` はモデルへ
    // 問い合わせないのでクォータを使わない。読めなければ既知の表へ落ちる
    let available_modes = session::permission::supported_modes(manager.program());
    tracing::info!(
        "権限モード: {}",
        available_modes
            .iter()
            .map(protocol::PermissionMode::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    );
    // 正式名と通称の対応表を、起動している CLI 自身から取り出す（設計§13）。
    // 画面の選択肢へ版番号を出すための材料で、**取れなくても何も壊れない**
    let catalog =
        model_catalog::ModelCatalog::resolve(manager.program(), Some(config.resolved_state_dir()));
    let settings = Arc::new(settings::SettingsStore::new(
        config_path,
        &config,
        available_modes,
        catalog.models().to_vec(),
    ));

    // 「作業中」の表示のまま実はハングしている、という見落としを防ぐ見張り（設計§5）
    manager.start_sweeper();

    // 履歴を読むパーサは別プロセス。落ちてもターミナルと状態表示は無傷（設計§11）
    let parser = parser::ParserSupervisor::start(Arc::clone(&manager), Arc::clone(&config));
    manager.attach_parser(parser.handle());

    // フォーマット変更に自分で追随する仕組み（設計§9）。
    // 修復には Docker とダッシュボード自身のソースが要る。無い環境では検知の通知だけ行う
    let ops = match config.resolved_repo_dir() {
        Some(repo) => Some(Arc::new(selfheal::ops::HostOps::new(
            repo,
            manager.program().to_string(),
        )) as Arc<dyn selfheal::ops::SelfhealOps>),
        None => {
            tracing::warn!(
                "ダッシュボード自身のソースが見つかりません。自己修復は検知の通知だけになります"
            );
            None
        }
    };
    selfheal::Selfheal::start(
        Arc::clone(&manager),
        Arc::clone(&parser),
        Arc::clone(&config),
        ops,
    );

    let state = ws::AppState::new(manager, Arc::clone(&config))
        .with_parser(parser)
        .with_settings(settings);
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
