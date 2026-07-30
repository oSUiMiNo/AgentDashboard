//! ローカルモードの AgentDashboard（設計§1・セルフホスト化設計§1-1）。
//!
//! PC 側（[`agent_core`]）とサーバ側（[`server_core`]）を**1つのプロセスで束ねる**層。
//! 実体は次の3つしかない。
//!
//! - [`local::LocalAgent`] … サーバ側から見た「PC 側」を、同じプロセスの `agent_core` へ直結する
//! - [`LocalServer::router`] … ブラウザ向け・フック受信・設定の3つのルータを合成する
//! - [`config::Config`] … 1つの `config.toml` から両側の設定を作る
//!
//! セルフホストモードでは、この束ねる層の代わりにネットワークが入る（フェーズ3）。
//! **どちらのモードでもブラウザから見た口は変わらない**というのが、この分け方の狙い。
//!
//! 実行ファイル（`agentdashboard`）は薄い入口で、中身はすべてこのライブラリ側にある。
//! こうしているのは、統合テストからサーバの組み立てをそのまま呼べるようにするため
//! （バイナリだけのクレートは `tests/` から参照できない）。

pub mod config;
pub mod local;
pub mod settings_api;

use agent_core::{
    hooks, model_catalog, parser, parser::ParserSupervisor, selfheal, session,
    session::SessionManager, settings, settings::SettingsStore,
};
use axum::Router;
use config::Config;
use local::LocalAgent;
use server_core::{config::ServerConfig, embed, ws};
use settings_api::SettingsState;
use std::{net::Ipv4Addr, sync::Arc};

/// ローカルモードで動くサーバ一式。
///
/// 両側の部品を持ち、[`Self::router`] で1つの待ち受けへ合成する。
pub struct LocalServer {
    manager: Arc<SessionManager>,
    config: Arc<ServerConfig>,
    /// パーサの世話役。**居なくても動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    parser: Option<Arc<ParserSupervisor>>,
    /// 画面から書き換えられる設定（設計§7）。**居なくても動く**ので、統合テストは
    /// 設定画面を立てずにセッションの検証だけができる。
    settings: Option<Arc<SettingsStore>>,
}

impl LocalServer {
    pub fn new(manager: Arc<SessionManager>, config: Arc<ServerConfig>) -> Self {
        Self {
            manager,
            config,
            parser: None,
            settings: None,
        }
    }

    /// パーサを繋いだ状態にする。
    pub fn with_parser(mut self, parser: Arc<ParserSupervisor>) -> Self {
        self.parser = Some(parser);
        self
    }

    /// 設定の持ち主を繋いだ状態にする。
    pub fn with_settings(mut self, settings: Arc<SettingsStore>) -> Self {
        self.settings = Some(settings);
        self
    }

    /// 3つのルータを合成する。
    ///
    /// | ルータ | 出どころ | なぜ分かれているか |
    /// |---|---|---|
    /// | `/ws`・`/api/sessions`・web アセット | [`server_core::routes`] | ブラウザ向け。セルフホストではクラウド側へ移る |
    /// | `/hook/*`・`/model/*` | [`agent_core::hooks::routes`] | 宛先はどちらのモードでもエージェントの 127.0.0.1（セルフホスト化設計§5-3） |
    /// | `/api/settings` | [`settings_api::routes`] | 応答の中身が PC 側にしか無い（§13-4 で作り替える予定） |
    ///
    /// いまは同じポートに同居しているが、**分けられる形にしておく**のがこの合成の意味。
    pub fn router(&self) -> Router {
        let mut agent = LocalAgent::new(Arc::clone(&self.manager));
        if let Some(parser) = &self.parser {
            agent = agent.with_parser(Arc::clone(parser));
        }
        let ws_state = ws::AppState::new(Arc::new(agent), Arc::clone(&self.config));

        server_core::routes(ws_state)
            .merge(hooks::routes(Arc::clone(&self.manager)))
            .merge(settings_api::routes(SettingsState {
                store: self.settings.clone(),
                manager: Arc::clone(&self.manager),
            }))
    }
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

    let server = LocalServer::new(manager, Arc::clone(&server_config))
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

    axum::serve(listener, server.router()).await?;
    Ok(())
}
