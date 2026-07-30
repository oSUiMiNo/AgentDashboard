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
pub mod ws;

// PC 側の一式は [`agent_core`] へ移った（セルフホスト化フェーズ1）。ここで名前を
// 出し直しているのは、既存の呼び出し側（実行ファイル・統合テスト）を1つのコミットで
// 全部書き換えずに済ませるため。**移設が済んだら外す**。
pub use agent_core::{
    claude_settings, hook_post, hooks, jsonfile, model_aliases, model_catalog, model_post, parser,
    selfheal, session, settings, state, transcript,
};

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
/// 口は3つだけ。`/ws` が WebSocket、`/api/*` がブラウザ向けのスナップショット、
/// `/hook/*` がフックからの通知（設計§7）。残りはすべて同梱した web アセットの配信にまわる。
///
/// # 2つのルータを合成している
///
/// ブラウザ向け（この関数）とフック受信（[`agent_core::hooks::routes`]）は**別々に
/// 組み立ててから合わせる**。フックの宛先はどちらのモードでも「エージェントの
/// 127.0.0.1」で、セルフホストモードでは別プロセスの別ポートになる（セルフホスト化
/// 設計§5-3）。いまは同じポートに同居しているが、分けられる形にしておく。
pub fn build_router(state: ws::AppState) -> Router {
    let manager = Arc::clone(&state.manager);
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
        .fallback(get(static_handler))
        .with_state(state)
        .merge(hooks::routes(manager))
}

/// 設定からサーバ一式を組み立てて起動する。
///
/// バインド先は **127.0.0.1 のみ**（設計§7）。個人用のローカルツールなので、外部から
/// 触れる経路をそもそも作らない。
pub async fn serve(config: Config, config_path: std::path::PathBuf) -> anyhow::Result<()> {
    // 1つのファイルから、エージェント側とサーバ側の2つへ射影する（セルフホスト化設計§13-2）。
    // 分けておくと、フェーズ3 で両者が別プロセスになったときに、この行より下は
    // ほとんど動かさずに済む
    let agent_config = Arc::new(config.agent());
    let server_config = Arc::new(config.server());
    let manager = SessionManager::new(Arc::clone(&agent_config));
    tracing::info!("起動する CLI: {}", manager.program());

    // 起動している CLI へ問い合わせる2つを、まとめてブロッキング用のスレッドへ逃がす。
    //
    // - 受け付ける権限モード（`--help`。設計§3）
    // - 正式名と通称の対応表（バイナリの走査。設計§13）
    //
    // どちらも子プロセスの起動と大きなファイル読みで、**待ち受けを始める前とはいえ
    // async の上で直接やる仕事ではない**。対応表の走査は版が読めない環境だと
    // 275MB を頭から読むことがある。なお `--help` も対応表もモデルへ問い合わせないので
    // クォータは使わない
    let (available_modes, catalog) = {
        let program = manager.program().to_string();
        let state_dir = agent_config.resolved_state_dir();
        tokio::task::spawn_blocking(move || {
            let modes = session::permission::supported_modes(&program);
            let catalog = model_catalog::ModelCatalog::resolve(&program, Some(state_dir));
            (modes, catalog)
        })
        .await?
    };
    tracing::info!(
        "権限モード: {}",
        available_modes
            .iter()
            .map(protocol::PermissionMode::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    );
    let settings = Arc::new(settings::SettingsStore::new(
        config_path,
        &agent_config,
        available_modes,
        catalog.models().to_vec(),
    ));

    // 「作業中」の表示のまま実はハングしている、という見落としを防ぐ見張り（設計§5）
    manager.start_sweeper();

    // 履歴を読むパーサは別プロセス。落ちてもターミナルと状態表示は無傷（設計§11）
    let parser = parser::ParserSupervisor::start(Arc::clone(&manager), Arc::clone(&agent_config));
    manager.attach_parser(parser.handle());

    // フォーマット変更に自分で追随する仕組み（設計§9）。
    // 修復には Docker とダッシュボード自身のソースが要る。無い環境では検知の通知だけ行う
    let ops = match agent_config.resolved_repo_dir() {
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
        Arc::clone(&agent_config),
        ops,
        // 版は対応表を取り出したときに読んである。ここで読み直すと CLI を2回起こす
        catalog.cli_version().to_string(),
    );

    let state = ws::AppState::new(manager, Arc::clone(&server_config))
        .with_parser(parser)
        .with_settings(settings);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, server_config.port)).await?;
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
