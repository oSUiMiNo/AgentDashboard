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
    hooks, model_catalog, offsets::OffsetStore, parser, parser::ParserSupervisor, selfheal,
    session, session::SessionManager, settings, settings::SettingsStore,
};
use axum::Router;
use config::Config;
use local::LocalAgent;
use server_core::{
    auth::AuthContext, config::ServerConfig, embed, gateway::AgentHub, registry::SessionRegistry,
    ws,
};
use settings_api::SettingsState;
use std::sync::Arc;

/// ローカルモードで動くサーバ一式。
///
/// 両側の部品を持ち、[`Self::router`] で1つの待ち受けへ合成する。
pub struct LocalServer {
    manager: Arc<SessionManager>,
    /// カードの記録（セルフホスト化設計§3）。**実体（PTY）とは別物**で、
    /// こちらは DB に裏付けられている。再起動しても残るのはこちら
    registry: Arc<SessionRegistry>,
    config: Arc<ServerConfig>,
    /// パーサの世話役。**居なくても動く**（構造化ビューだけが縮退する）。
    ///
    /// 設計§11 の「パーサが停止しても、ターミナルと指示送信は通常動作」を型で表している。
    parser: Option<Arc<ParserSupervisor>>,
    /// 画面から書き換えられる設定（設計§7）。**居なくても動く**ので、統合テストは
    /// 設定画面を立てずにセッションの検証だけができる。
    settings: Option<Arc<SettingsStore>>,
    /// 入口の鍵（セルフホスト化設計§8-1）。**待ち受けの広さで中身が決まる**——
    /// 127.0.0.1 だけなら鍵なし、広げているなら LAN の共有パスワード。
    auth: Arc<AuthContext>,
}

impl LocalServer {
    pub fn new(
        manager: Arc<SessionManager>,
        registry: Arc<SessionRegistry>,
        config: Arc<ServerConfig>,
        auth: Arc<AuthContext>,
    ) -> Self {
        Self {
            manager,
            registry,
            config,
            parser: None,
            settings: None,
            auth,
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
    ///
    /// # フックの受信だけは鍵をかけない
    ///
    /// 叩くのは CLI が起動する `hook-post` で、宛先は 127.0.0.1、URL にセッションごとの
    /// トークンが入っている（設計§5-3）。ブラウザの Cookie を持ちようが無いので、
    /// ここに鍵をかけると**フックが1件も届かなくなる**。
    pub fn router(&self) -> Router {
        let mut agent = LocalAgent::new(Arc::clone(&self.manager));
        if let Some(parser) = &self.parser {
            agent = agent.with_parser(Arc::clone(parser));
        }
        let ws_state = ws::AppState::new(
            Arc::new(agent),
            Arc::clone(&self.registry),
            Arc::clone(&self.config),
        );

        let settings = server_core::guard(
            settings_api::routes(SettingsState {
                store: self.settings.clone(),
                manager: Arc::clone(&self.manager),
                auth: Arc::clone(&self.auth),
            }),
            Arc::clone(&self.auth),
        );

        let router = server_core::routes(ws_state, Arc::clone(&self.auth))
            .merge(hooks::routes(Arc::clone(&self.manager)))
            .merge(settings);
        server_core::auth::with_sessions(router, &self.auth)
    }
}

/// ダッシュボードサーバだけを起動する（セルフホスト化設計§1-1）。
///
/// **PC 側を作らない**のがローカルモードとの違い。PTY もフックの受信口も持たず、
/// セッションの実体は A2S の向こう（[`server_core::gateway`]）にある。
///
/// 落ちても、繋がっている PC のセッションは無傷（§9-6）。エージェントは繋ぎ直し、
/// 未 ack のぶんを送り直して追いつく（§6-4）。
pub async fn serve_server(config: Config) -> anyhow::Result<()> {
    let server_config = Arc::new(config.server());

    let db = server_core::db::connect(&config.resolved_database_url()).await?;
    let registry = SessionRegistry::load(db.clone(), server_config.transcript_window_nodes).await?;
    let auth = AuthContext::server(db.clone(), &server_config);
    let hub = AgentHub::new(db, Arc::clone(&registry));

    let agent: Arc<dyn server_core::agent::AgentHost> =
        Arc::new(server_core::gateway::RemoteAgent::new(Arc::clone(&hub)));
    let ws_state = ws::AppState::new(agent, Arc::clone(&registry), Arc::clone(&server_config));
    let router = server_core::routes(ws_state, Arc::clone(&auth))
        // エージェントの受け口は**ブラウザとは別の鍵**（ペアリングトークン。§8-4）。
        // Cookie の middleware をかけると、PC が Cookie を持たないだけで断られる
        .merge(server_core::gateway::agent_routes(Arc::clone(&hub)))
        .merge(server_core::guard(
            settings_api::server_routes(Arc::clone(&hub)),
            Arc::clone(&auth),
        ));
    let router = server_core::auth::with_sessions(router, &auth);

    let listener = bind(&server_config).await?;
    tracing::info!(
        "AgentDashboard（サーバ）を起動しました: http://{}",
        listener.local_addr()?
    );
    serve_router(listener, router).await
}

/// 待ち受けを開く。
async fn bind(config: &ServerConfig) -> anyhow::Result<tokio::net::TcpListener> {
    let listener = tokio::net::TcpListener::bind((config.bind_addr.as_str(), config.port)).await?;
    Ok(listener)
}

/// 待ち受けを始める。**接続元のアドレスを渡す形で**動かす。
///
/// 素の `axum::serve` はピアアドレスをハンドラへ渡さない。LAN 開放の
/// 「127.0.0.1 は常に免除」（設計§8-3）は**接続そのもの**を見て決める必要があり、
/// `X-Forwarded-For` のようなヘッダで代用してはいけない——偽装ヘッダ一発で
/// 免除が取れる穴になる。
async fn serve_router(listener: tokio::net::TcpListener, router: Router) -> anyhow::Result<()> {
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// 設定からサーバ一式を組み立てて起動する（ローカルモード）。
pub async fn serve(config: Config, config_path: std::path::PathBuf) -> anyhow::Result<()> {
    // 1つのファイルから、エージェント側とサーバ側の2つへ射影する（セルフホスト化設計§13-2）。
    // 分けておくと、フェーズ3 で両者が別プロセスになったときに、この行より下は
    // ほとんど動かさずに済む
    let agent_config = Arc::new(config.agent());
    let server_config = Arc::new(config.server());

    // **繋げなければ起動しない**（利用者判断）。DB が真実である以上、無い状態で
    // 動かすと一覧も履歴も嘘になる。設計§12 の「DB 断」は稼働中に落ちた場合の縮退の
    // 話で、起動時の検査とは別に扱う——ここで失敗するのはたいてい設定の打ち間違いで、
    // そのときに黙って動くほうが害が大きい
    let database_url = config.resolved_database_url();
    let db = server_core::db::connect(&database_url).await?;

    // **鍵なしで開ける事故を仕組みで防ぐ**（要件1-1・設計§8-3）。待ち受けを広げて
    // いるのに LAN のパスワードが無いなら、警告ではなく起動そのものを止める——
    // 警告は読まれないことがあるし、読まれたときには既に開いている
    server_core::auth::ensure_lan_password(&db, &server_config).await?;
    let auth = server_core::auth::AuthContext::local(db.clone(), &server_config);

    let registry = SessionRegistry::load(db, server_config.transcript_window_nodes).await?;

    // 再開位置の置き場所は、パーサの世話役（読む側）と報告の運び手（進める側）で
    // 共有する。**進めてよいのは記録に入ってから**（設計§6-1）
    let offsets = OffsetStore::open(agent_config.resolved_state_dir());

    // 報告先を記録層へ繋いでからマネージャを作る。**報告 → DB → ブラウザ**の順序が
    // ここで決まる（設計§9-1「耐久データは DB へ書いてから publish する」）
    let manager = SessionManager::with_sink(
        Arc::clone(&agent_config),
        local::reporting(Arc::clone(&registry), Arc::clone(&offsets)),
    );
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
    let settings = Arc::new(settings::SettingsStore::with_version(
        config_path,
        &agent_config,
        available_modes,
        catalog.models().to_vec(),
        catalog.cli_version().to_string(),
    ));

    // 「作業中」の表示のまま実はハングしている、という見落としを防ぐ見張り（設計§5）
    manager.start_sweeper();

    // 履歴を読むパーサは別プロセス。落ちてもターミナルと状態表示は無傷（設計§11）
    let parser =
        parser::ParserSupervisor::start(Arc::clone(&manager), Arc::clone(&agent_config), offsets);
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

    let server = LocalServer::new(manager, registry, Arc::clone(&server_config), auth)
        .with_parser(parser)
        .with_settings(settings);
    let listener = bind(&server_config).await?;
    let address = listener.local_addr()?;

    tracing::info!("AgentDashboard を起動しました: http://{address}");
    if embed::list().is_empty() {
        // ビルド順を間違えると起きる。黙って空白のページを返すより理由を出す
        tracing::warn!(
            "web アセットが同梱されていません。`make build` で web を先にビルドしてください"
        );
    }

    serve_router(listener, server.router()).await
}
