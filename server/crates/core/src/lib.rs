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

pub mod boot;
pub mod cli;
pub mod config;
pub mod gate;
pub mod local;
pub mod settings_api;
pub mod versions_api;

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
    /// 版の保管庫の置き場所（CICD設計§14）。**居なくても動く**ので、既存の統合テストは
    /// 版の口を立てずにセッションの検証だけができる。
    state_dir: Option<std::path::PathBuf>,
    /// 版の口の残りの材料（CICD設計§9・§10）。`state_dir` と一緒に入る。
    versions: Option<VersionsWiring>,
}

/// 版の口が要る、`state_dir` 以外の材料。
///
/// 門は行き先の実行ファイルへ聞くだけでなく**その DB に適用済みの形**と突き合わせる
/// ので、記録への口が要る。`crates/core` は記録の道具を通常の依存に持っていないので、
/// 型ではなく関数で受け取る（CICD設計§23-9 と同じ形）。
pub struct VersionsWiring {
    pub config_arg: Option<std::path::PathBuf>,
    pub applied: versions_api::AppliedSchemas,
    pub stop: versions_api::Stopper,
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
            state_dir: None,
            versions: None,
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

    /// 版の保管庫を繋いだ状態にする。**見る口と消す口だけ**が生える。
    pub fn with_state_dir(mut self, state_dir: std::path::PathBuf) -> Self {
        self.state_dir = Some(state_dir);
        self
    }

    /// 版を**選ぶ・取ってくる・入れ替える**口まで生やす（CICD設計§9・§10）。
    ///
    /// 分けてあるのは、既存の統合テストが記録への口も終わり方も要らないため。
    /// **終わり方を差し替えられる形にしてある**のが要点——素直に落とすと、サーバを
    /// プロセス内に立てているテストがテストバイナリごと死ぬ。
    pub fn with_versions(mut self, wiring: VersionsWiring) -> Self {
        self.versions = Some(wiring);
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

        let mut router = server_core::routes(ws_state, Arc::clone(&self.auth))
            .merge(hooks::routes(Arc::clone(&self.manager)))
            .merge(settings);
        if let Some(state_dir) = &self.state_dir {
            router = router.merge(server_core::guard(
                versions_api::routes(versions_api::VersionsState {
                    state_dir: state_dir.clone(),
                    auth: Arc::clone(&self.auth),
                    // **こちらは PTY の持ち主**。落とすと道連れになるカードがあるので、
                    // 押す前に数えられるようにする（CICD設計§10）
                    registry: Some(Arc::clone(&self.registry)),
                    config_arg: self
                        .versions
                        .as_ref()
                        .and_then(|wiring| wiring.config_arg.clone()),
                    applied: match &self.versions {
                        Some(wiring) => Arc::clone(&wiring.applied),
                        None => versions_api::no_schemas(),
                    },
                    ops: agent_core::version_ops::detect(),
                    install: Arc::new(std::sync::Mutex::new(None)),
                    stop: match &self.versions {
                        Some(wiring) => Arc::clone(&wiring.stop),
                        None => versions_api::no_stop(),
                    },
                }),
                Arc::clone(&self.auth),
            ));
        }
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
pub async fn serve_server(
    config: Config,
    config_arg: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let server_config = Arc::new(config.server());

    let db = server_core::db::connect(&config.resolved_database_url()).await?;

    // インスタンスを跨ぐ連絡係（設計§9）。**無ければプロセスの中で完結する**——
    // インスタンスが1台なら本当にそれで足りるので、必須にはしない
    let (incoming_tx, incoming_rx) = tokio::sync::mpsc::unbounded_channel();
    let bus = match &server_config.valkey_url {
        Some(url) => {
            let bus = server_core::bus::valkey::ValkeyBus::connect(url, incoming_tx).await?;
            Some(bus as Arc<dyn server_core::bus::Bus>)
        }
        None => {
            tracing::info!(
                "valkey_url が無いので連絡係を持ちません（インスタンスは1台の前提で動きます）"
            );
            None
        }
    };

    let registry = SessionRegistry::load(
        db.clone(),
        server_config.transcript_window_nodes,
        bus.clone(),
    )
    .await?;
    let auth = AuthContext::server(db.clone(), &server_config);
    let update_db = db.clone();
    let gate_db = db.clone();
    let hub = AgentHub::new(db, Arc::clone(&registry));

    if let Some(bus) = &bus {
        server_core::cluster::start(
            Arc::clone(&registry),
            Arc::clone(&hub),
            incoming_rx,
            bus.state(),
        );
    }

    let agent: Arc<dyn server_core::agent::AgentHost> =
        Arc::new(server_core::gateway::RemoteAgent::new(Arc::clone(&hub)));
    let ws_state = ws::AppState::new(agent, Arc::clone(&registry), Arc::clone(&server_config));
    let router = server_core::routes(ws_state, Arc::clone(&auth))
        // エージェントの受け口は**ブラウザとは別の鍵**（ペアリングトークン。§8-4）。
        // Cookie の middleware をかけると、PC が Cookie を持たないだけで断られる
        .merge(server_core::gateway::agent_routes(Arc::clone(&hub)))
        .merge(server_core::guard(
            settings_api::server_routes(Arc::clone(&hub))
                // アカウント画面（トークンの発行・失効・PC 一覧。§11-1）。
                // **ローカルモードには無い**——A2S の受け口が無いので、繋いでくる
                // PC が存在せず、鍵を配る相手も居ない
                .merge(server_core::account::routes(Arc::clone(&hub)))
                // 版の切替はサーバモードでも要る。**PTY は持たないが、版を
                // 切り替えられる主体であることは変わらない**（CICD設計§14）
                .merge(versions_api::routes(versions_api::VersionsState {
                    state_dir: config.agent().resolved_state_dir(),
                    auth: Arc::clone(&auth),
                    // **PTY を持たないので道連れにするものが無い。** 記録は持っている
                    // が、あれは PC 側が生かし続けるセッションの写し（CICD設計§10）
                    registry: None,
                    config_arg: config_arg.clone(),
                    // 記録への口は**型を書かずに関数で受け取る**（設計§23-9 と同じ形）
                    applied: {
                        let db = gate_db;
                        Arc::new(move || {
                            let db = db.clone();
                            Box::pin(async move {
                                server_core::db::applied_migration_names(&db)
                                    .await
                                    .map_err(|err| format!("適用済みの記録の形を読めません: {err}"))
                            })
                        })
                    },
                    ops: agent_core::version_ops::detect(),
                    install: Arc::new(std::sync::Mutex::new(None)),
                    stop: versions_api::exit_process(),
                })),
            Arc::clone(&auth),
        ));
    let router = server_core::auth::with_sessions(router, &auth);

    let listener = bind(&server_config).await?;
    // 乗り換えの印を消す（CICD設計§11）。**サーバモードでも同じ**——PTY は持たないが、
    // 版を切り替えられる主体であることは変わらない
    agent_core::version::confirm_started(&config.agent().resolved_state_dir());
    tokio::spawn(watch_updates(
        config.agent().resolved_state_dir(),
        move || {
            let db = update_db.clone();
            async move {
                server_core::db::settings::update_check_enabled(&db)
                    .await
                    .unwrap_or(server_core::db::settings::DEFAULT_UPDATE_CHECK_ENABLED)
            }
        },
    ));
    tracing::info!(
        "AgentDashboard（サーバ）を起動しました: http://{}",
        listener.local_addr()?
    );
    serve_router(listener, router).await
}

/// 新しい版が出ていないか、背景で見に行く（CICD設計§8）。
///
/// **見に行くだけ。** 取ってくることも入れ替えることもしない。起動を待たせないよう
/// 背景へ逃がす——献立表の取得は実測 0.6 秒だが、回線が遅ければその待ち時間が
/// そのまま起動に乗る。
///
/// 実際に外へ出るかは [`agent_core::version_ops::due`] が決める。**「起動時に1回」だけに
/// すると頻度の上限が再起動の回数になる**ので、前回から経っていなければ見に行かない。
///
/// 設定の読み方を関数で受け取っているのは、`crates/core` が記録の道具を通常の依存に
/// 持っていないため。**型を書かずに呼べる形**にしておく（設定の綴りとスコープは
/// `server_core::db::settings` の薄いラッパが持っている）。
async fn watch_updates<F, Fut>(state_dir: std::path::PathBuf, enabled: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    /// 設定の入り切りに追随できるよう、様子を見に来る間隔。
    /// 外へ出るかどうかは別（[`agent_core::version_ops::CHECK_INTERVAL_MS`]）。
    const POLL: std::time::Duration = std::time::Duration::from_secs(3600);

    let Ok(ops) = tokio::task::spawn_blocking(agent_core::version_ops::detect).await else {
        return;
    };
    if let Some(reason) = ops.unavailable_reason() {
        // **黙って何もしないと原因を辿れない。** 取ってくる道具は入れ直しで生えたり
        // 消えたりするので、理由を1行残す
        tracing::info!("新しい版の確認はできません: {reason}");
        return;
    }

    loop {
        if enabled().await {
            let state_dir = state_dir.clone();
            let ops = Arc::clone(&ops);
            let now = agent_core::session::now_ms();
            let checked = tokio::task::spawn_blocking(move || {
                use agent_core::version_ops as v;
                if !v::due(&v::read_notice(&state_dir), now, v::CHECK_INTERVAL_MS) {
                    return None;
                }
                Some(v::check_once(&state_dir, ops.as_ref(), now))
            })
            .await;
            match checked {
                Ok(Some(Ok(latest))) => {
                    tracing::info!(version = %latest.version, "最新版を確認しました");
                }
                // 読めなかった（回線が無い等）ときは黙って次へ。**打てる手が無いことを
                // 出し続けない**（設計§8）
                Ok(Some(Err(error))) => tracing::debug!("新しい版を確認できませんでした: {error}"),
                _ => {}
            }
        }
        tokio::time::sleep(POLL).await;
    }
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
pub async fn serve(config: Config, config_arg: Option<std::path::PathBuf>) -> anyhow::Result<()> {
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
    let update_db = db.clone();
    let gate_db = db.clone();

    let registry = SessionRegistry::load(db, server_config.transcript_window_nodes, None).await?;

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
            // **ここでは画面へ出さない**（設計§25 読み替え3）。パースは正常なのに
            // 起動しただけで縮退バナーが出ると、配ったバイナリでは出っぱなしになる。
            // 伝えるのは実際に検知が発火したとき
            tracing::warn!(
                "ダッシュボード自身のソースが見つかりません。自己修復は検知の通知だけになります\
                 （パーサの更新が要るときは画面に出ます）"
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
        .with_settings(settings)
        .with_state_dir(agent_config.resolved_state_dir())
        .with_versions(VersionsWiring {
            config_arg,
            // 記録への口は**型を書かずに関数で受け取る**（設計§23-9 と同じ形）
            applied: {
                let db = gate_db;
                Arc::new(move || {
                    let db = db.clone();
                    Box::pin(async move {
                        server_core::db::applied_migration_names(&db)
                            .await
                            .map_err(|err| format!("適用済みの記録の形を読めません: {err}"))
                    })
                })
            },
            stop: versions_api::exit_process(),
        });
    let listener = bind(&server_config).await?;
    // **待ち受けを確保できた時点で、乗り換えの印を消す**（CICD設計§11）。ここより後ろへ
    // ずらすと、印を消す前に落ちる隙間が広がる
    agent_core::version::confirm_started(&agent_config.resolved_state_dir());
    tokio::spawn(watch_updates(
        agent_config.resolved_state_dir(),
        move || {
            let db = update_db.clone();
            async move {
                server_core::db::settings::update_check_enabled(&db)
                    .await
                    .unwrap_or(server_core::db::settings::DEFAULT_UPDATE_CHECK_ENABLED)
            }
        },
    ));
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
