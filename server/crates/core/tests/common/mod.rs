//! ブラウザ配信まで通す統合テストの共通ヘルパ。
//!
//! セッションを相手にする部分（擬似 claude の起動・PTY の監視・状態待ち）は
//! **agent-core 側のハーネスをそのまま読み込んで使う**。同じ内容を2つ持つと片方だけが
//! 古くなるので、コピーはしない。ここに足すのは「待ち受けているサーバ」のぶんだけ。

#![allow(dead_code)]

// セッション側のハーネス。crate をまたぐが、テストのソースを直に読み込む形なので
// 製品の依存は増えない（agent-core を test 用に公開する必要がない）。
#[path = "../../../agent-core/tests/common/mod.rs"]
mod session;
pub use session::*;

use agent_core::{
    claude_settings::ClaudeSettings,
    model_aliases::ModelAliases,
    offsets::OffsetStore,
    parser::ParserSupervisor,
    session::{Session, SessionManager},
};
use agentdashboard_core::{LocalServer, config::Config, local};
use protocol::ws::ServerMessage;
use server_core::registry::SessionRegistry;
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    sync::broadcast,
    time::{Instant, timeout},
};

/// パーサの実行ファイル（ビルド済みの `transcript-parser`）。
///
/// `hook_program` と同じ理由で明示的に渡す。本番は `current_exe()` の隣を見るが、
/// 統合テストではライブラリとして動くのでテストバイナリの隣を探してしまう。
pub fn parser_program() -> PathBuf {
    testkit::binary_path("transcript-parser")
}

/// 使い捨てのグローバル設定を持つ、待ち受け中のサーバ。
///
/// **本物の `~/.claude/settings.json` を絶対に触らせないための入口。**
/// 既定のマネージャは利用者の本物のファイルを指すので、モデル切替を含むテストは
/// 必ずこちらを使う。
///
/// サーバを立てるのは、注入した `statusLine` が **HTTP でモデルを送ってくる**ため。
/// マネージャだけではその受信口が無く、モデルが永久に「不明」のままになる。
///
/// 返り値の `PathBuf` が擬似のグローバル設定で、テストはこれを読んで「戻ったか」を確かめる。
pub async fn server_with_fake_global(
    label: &str,
    body: &str,
    config: Config,
) -> (PathBuf, TestServer) {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-model-test-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
    let path = dir.join("settings.json");
    std::fs::write(&path, body).expect("擬似のグローバル設定を書けること");

    let mut config = config;
    let server = TestServer::build_full(
        &mut config,
        fake_claude().to_string_lossy().into_owned(),
        false,
        true,
        None,
        Some(Arc::new(ClaudeSettings::new(path.clone()))),
        None,
    )
    .await;
    (path, server)
}

/// 擬似のグローバル設定から `model` を読む。
pub fn global_model(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("model")?.as_str().map(str::to_string)
}

/// カードのモデルが期待どおりになるまで待つ。
///
/// `statusLine` は `refreshInterval` の周期で届くので、送った直後には確定していない。
/// マーカーではなく**状態そのもの**を待つ（設計§5 の楽観更新と確定の順序を、
/// テスト側で先回りして決めつけないため）。
pub async fn wait_for_model(session: &Arc<Session>, expected: &str) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let model = session.meta().model;
        if model.as_ref().map(protocol::ModelId::as_str) == Some(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{TIMEOUT:?} 以内にモデルが {expected} になりませんでした。実際: {model:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 実際に待ち受けている core サーバ。フックの受信を端から端まで通すために使う。
pub struct TestServer {
    pub manager: Arc<SessionManager>,
    /// カードの記録（DB 裏付け）。**ブラウザが見るのはこちら**（設計§3-3）。
    /// `manager` は実体（PTY）側なので、履歴の中身はここから読む
    pub registry: Arc<SessionRegistry>,
    pub addr: SocketAddr,
    /// 立ち上げた場合のみ。パーサを使わないテストでは None
    pub parser: Option<Arc<ParserSupervisor>>,
    /// 立ち上げた場合のみ（自己修復のテストだけ）
    pub selfheal: Option<Arc<agent_core::selfheal::Selfheal>>,
    pub config: Arc<Config>,
    /// ログイン後の入館証（設計§8-2）。
    ///
    /// REST も `/ws` も同じ Cookie で通すので、**ここに入れておけば以後の要求に載る**。
    /// 鍵の無いローカルモード（`Open`）では最後まで `None` のまま。
    pub cookie: Option<String>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    /// 空きポートで core を起動する。
    ///
    /// **先にポートを確定させてから設定を作る**のが要点。注入する settings には
    /// フックの宛先URLが焼き込まれるため、後からポートが変わると届かなくなる。
    pub async fn start() -> Self {
        Self::start_with(Config::default()).await
    }

    pub async fn start_with(config: Config) -> Self {
        Self::start_with_program(config, fake_claude().to_string_lossy().into_owned()).await
    }

    /// 起動する CLI を明示して立ち上げる（実CLI統合テストが本物の claude を指すため）。
    /// パーサ（transcript-parser の子プロセス）も立ち上げて起動する。
    ///
    /// 構造化ビューを端から端まで通すテスト専用。パーサを使わないテストで毎回
    /// 子プロセスを起こすと、テストの本数だけ無駄なプロセスが増える。
    pub async fn start_with_parser(config: Config) -> Self {
        let server = Self::build(config, fake_claude().to_string_lossy().into_owned(), true).await;
        // 起動直後は指示を受け付けられないので、パーサが立ち上がる間を置く
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    pub async fn start_with_program(config: Config, program: String) -> Self {
        Self::build(config, program, false).await
    }

    /// パーサに加えて自己修復も立ち上げる（設計§9）。
    ///
    /// 外の世界へ出る操作（cargo・git・本物の claude）は呼び出し側が差し替える。
    /// コンテナの中から docker は叩けないので、ここは差し替えが前提になる。
    pub async fn start_with_selfheal(
        config: Config,
        ops: Arc<dyn agent_core::selfheal::ops::SelfhealOps>,
    ) -> Self {
        Self::start_with_selfheal_and_program(
            config,
            ops,
            fake_claude().to_string_lossy().into_owned(),
        )
        .await
    }

    /// 起動する CLI を明示して自己修復も立ち上げる（実CLIの訓練用）。
    pub async fn start_with_selfheal_and_program(
        config: Config,
        ops: Arc<dyn agent_core::selfheal::ops::SelfhealOps>,
        program: String,
    ) -> Self {
        // 差し替えの検証をするので、パーサの場所は**ポインタ経由**で決めさせる。
        // 環境変数で名指しすると探索順の先頭にあたり、差し替えても効かなくなる
        let state_dir = config.agent().resolved_state_dir();
        std::fs::create_dir_all(&state_dir).expect("状態の置き場所を作れること");
        std::fs::write(
            state_dir.join(agent_core::parser::PARSER_POINTER),
            parser_program().to_string_lossy().as_bytes(),
        )
        .expect("ポインタを書けること");

        let mut server = Self::build_with(config, program, true, false, None).await;
        server.selfheal = Some(agent_core::selfheal::Selfheal::start(
            Arc::clone(&server.manager),
            Arc::clone(server.parser.as_ref().expect("パーサを起動している")),
            Arc::new(server.config.agent()),
            Some(ops),
            // 擬似 claude は `--version` に答えないので、本番でもここは空になる。
            // 空だと別名の表の見直しは起きない（比べる相手が無い）。表の見直しを
            // 見るテストは `review_model_table` を直接呼んでいる
            String::new(),
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    /// 起動する CLI を明示したうえで、パーサも立ち上げる（実CLI×構造化ビュー用）。
    pub async fn start_with_parser_and_program(config: Config, program: String) -> Self {
        let server = Self::build(config, program, true).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    async fn build(config: Config, program: String, with_parser: bool) -> Self {
        Self::build_with(config, program, with_parser, true, None).await
    }

    /// 設定の書き換え（`/api/settings`）を確かめるために、設定の持ち主も立てる。
    ///
    /// 書き戻し先はテストが渡す一時ファイル。**利用者の config.toml は絶対に触らない**。
    pub async fn start_with_settings(config: Config, settings_path: PathBuf) -> Self {
        Self::build_with(
            config,
            fake_claude().to_string_lossy().into_owned(),
            false,
            true,
            Some(settings_path),
        )
        .await
    }

    /// `name_parser_by_env` を false にすると、パーサの場所をポインタに決めさせる
    /// （自己修復の差し替えを検証するテスト用）。
    async fn build_with(
        mut config: Config,
        program: String,
        with_parser: bool,
        name_parser_by_env: bool,
        settings_path: Option<PathBuf>,
    ) -> Self {
        Self::build_full(
            &mut config,
            program,
            with_parser,
            name_parser_by_env,
            settings_path,
            None,
            None,
        )
        .await
    }

    /// **LAN の向こうから来たふりで**立ち上げる（設計§8-3 の検証用）。
    ///
    /// 本番は接続そのものからピアアドレスを取る。テストの接続元は必ず 127.0.0.1 に
    /// なるので、それだけでは「免除される側」しか踏めない。ここで差し替えられる形に
    /// してあるのは、**免除されない側**を確かめるため。
    pub async fn start_from(mut config: Config, peer: SocketAddr) -> Self {
        Self::build_full(
            &mut config,
            fake_claude().to_string_lossy().into_owned(),
            false,
            true,
            None,
            None,
            Some(peer),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn build_full(
        config: &mut Config,
        program: String,
        with_parser: bool,
        name_parser_by_env: bool,
        settings_path: Option<PathBuf>,
        claude_settings: Option<Arc<ClaudeSettings>>,
        pretend_peer: Option<SocketAddr>,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr = listener.local_addr().expect("待ち受け先を取れること");
        config.port = addr.port();

        // **使い捨ての DB を使う。** 既定は `state_dir` の隣＝開発者の本物の状態
        // ディレクトリになるので、指定しないとテストが実環境へ書き込む
        // （`claude_settings_for` と同じ性質の漏れ）
        //
        // **呼び出し側が指定していればそれを尊重する。** 同じ DB を指した2つのサーバを
        // 順に立てると「サーバだけ再起動した」状態を作れる（`restart.rs`）
        if config.database_url.is_none() {
            let db_dir = std::env::temp_dir().join(format!(
                "agentdashboard-test-db-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&db_dir).expect("DB の置き場所を作れること");
            config.database_url = Some(format!(
                "sqlite://{}",
                db_dir.join("dashboard.db").display()
            ));
        }

        let config = Arc::new(config.clone());
        // 本番（`serve`）と同じく、1つの設定ファイルから両側の射影を作る
        let agent_config = Arc::new(config.agent());
        let server_config = Arc::new(config.server());

        let db = server_core::db::connect(&config.resolved_database_url())
            .await
            .expect("使い捨ての DB へ繋げること");
        // 入口の鍵も**本番と同じ組み立て**で作る。テストだけ素通しにすると、
        // 認証を通る経路が一度も踏まれないまま緑になる
        let auth = server_core::auth::AuthContext::local(db.clone(), &server_config);
        let registry = SessionRegistry::load(db, server_config.transcript_window_nodes, None)
            .await
            .expect("記録層を立てられること");
        // 再開位置は、読む側（パーサの世話役）と進める側（報告の運び手）で共有する。
        // 置き場所は `state_dir` の下なので、テストごとの使い捨てになる
        let offsets = OffsetStore::open(agent_config.resolved_state_dir());
        let events = local::reporting(Arc::clone(&registry), Arc::clone(&offsets));

        let manager = match claude_settings {
            // モデルを扱うテストは**本物の ~/.claude/settings.json を触らない**
            Some(claude_settings) => SessionManager::with_everything(
                Arc::clone(&agent_config),
                program,
                hook_program(),
                claude_settings,
                Arc::new(ModelAliases::in_memory()),
                events,
            ),
            // 明示が無くても本物へは落とさない（[`claude_settings_for`]）
            None => build_manager_with(Arc::new(config.agent()), program, events),
        };

        let mut server = LocalServer::new(
            Arc::clone(&manager),
            Arc::clone(&registry),
            Arc::clone(&server_config),
            Arc::clone(&auth),
        );
        let parser = if with_parser {
            // 本番と同じ入口（環境変数）でビルド済みのパーサを指す
            if name_parser_by_env {
                unsafe {
                    std::env::set_var(agent_core::parser::PARSER_BIN_ENV, parser_program());
                }
            }
            let parser = ParserSupervisor::start(
                Arc::clone(&manager),
                Arc::clone(&agent_config),
                Arc::clone(&offsets),
            );
            manager.attach_parser(parser.handle());
            server = server.with_parser(Arc::clone(&parser));
            Some(parser)
        } else {
            None
        };

        if let Some(path) = settings_path {
            // 本番と同じく `--help` からモードを読む（擬似 claude も choices を出す）
            let modes = agent_core::session::permission::supported_modes(manager.program());
            server = server.with_settings(Arc::new(agent_core::settings::SettingsStore::new(
                path,
                &agent_config,
                modes,
                // 擬似 claude は対応表を持たない。空で通す
                Vec::new(),
            )));
        }

        // 接続元を差し替えるなら、**一番外側**で入れ替える。鍵の判定はこれより内側に
        // あるので、こちらが後から入れた値を見ることになる
        let mut router = server.router();
        if let Some(peer) = pretend_peer {
            router = router.layer(axum::middleware::from_fn(
                move |mut request: axum::extract::Request, next: axum::middleware::Next| async move {
                    request
                        .extensions_mut()
                        .insert(axum::extract::ConnectInfo(peer));
                    next.run(request).await
                },
            ));
        }

        // **接続元を渡す形で待ち受ける**（本番の `serve_router` と同じ）。
        // ここを素の `axum::serve` にすると、127.0.0.1 の免除（設計§8-3）が
        // テストでだけ効かず、開発環境でしか出ない差分になる
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });

        Self {
            manager,
            registry,
            addr,
            parser,
            selfheal: None,
            config,
            cookie: None,
            task,
        }
    }

    /// 入館証を載せて1往復する。**ログインしていなければ載せるものが無いだけ**なので、
    /// 鍵の無いローカルモードでもそのまま使える。
    pub async fn request(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
        let (addr, method, path) = (self.addr, method.to_string(), path.to_string());
        let (body, cookie) = (body.map(str::to_string), self.cookie.clone());
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, &method, &path, body.as_deref(), cookie.as_deref())
        })
        .await
        .expect("HTTPスレッドが落ちないこと")
        .expect("応答を読めること");
        (response.status, response.body)
    }

    /// 入館証を受け取る要求（ログイン・セットアップ）。**Cookie を覚える。**
    async fn authenticate(&mut self, path: &str, body: String) -> (u16, String) {
        let addr = self.addr;
        let cookie = self.cookie.clone();
        let path = path.to_string();
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "POST", &path, Some(&body), cookie.as_deref())
        })
        .await
        .expect("HTTPスレッドが落ちないこと")
        .expect("応答を読めること");
        if let Some(cookie) = response.cookie {
            self.cookie = Some(cookie);
        }
        (response.status, response.body)
    }

    /// 最初の管理者を作る（設計§8-2）。
    pub async fn setup(&mut self, name: &str, password: &str) -> (u16, String) {
        let body = serde_json::json!({ "name": name, "password": password }).to_string();
        self.authenticate("/api/setup", body).await
    }

    /// ログインする。`name` が `None` なら LAN の共有パスワード（§8-3）。
    pub async fn login(&mut self, name: Option<&str>, password: &str) -> (u16, String) {
        let body = match name {
            Some(name) => serde_json::json!({ "name": name, "password": password }),
            None => serde_json::json!({ "password": password }),
        };
        self.authenticate("/api/login", body.to_string()).await
    }

    pub async fn logout(&mut self) -> (u16, String) {
        let result = self.authenticate("/api/logout", "{}".to_string()).await;
        self.cookie = None;
        result
    }

    /// 一覧に載ったカードが条件を満たすまで待つ。
    ///
    /// **エージェント側の状態が変わった直後には、まだ一覧に出ていない**ことがある。
    /// フェーズ2 で報告が「DB へ書いてから配る」経路（設計§9-1）を通るようになり、
    /// 実体の状態と記録の状態の間に1段の遅れができた。ブラウザから見える形を
    /// 確かめるテストは、実体ではなくこちらを待つ。
    pub async fn wait_for_listed(
        &self,
        what: &str,
        matches: impl Fn(&[protocol::SessionMeta]) -> bool,
    ) -> Vec<protocol::SessionMeta> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let listed = self.registry.list(server_core::db::LOCAL_ACCOUNT_ID);
            if matches(&listed) {
                return listed;
            }
            assert!(
                Instant::now() < deadline,
                "{TIMEOUT:?} 以内に一覧が {what} になりませんでした（{} 枚）",
                listed.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// カードの記録から履歴を読む。
    ///
    /// 実体（`manager`）ではなく記録から読むのがフェーズ2 での変化。**履歴の持ち主は
    /// サーバ側**になったので、セッションに聞いても持っていない（設計§3-3）。
    pub fn transcript_of(&self, card_id: protocol::CardId) -> Vec<protocol::TreeNode> {
        self.registry
            .get(card_id)
            .map(|record| record.transcript_snapshot())
            .unwrap_or_default()
    }

    /// 履歴が条件を満たすまで待つ。
    ///
    /// 報告が DB を経由してから記録に載るので、**フックが届いた直後にはまだ空**の
    /// ことがある。`manager` の窓を直接見ていた頃には無かった待ちで、経路が
    /// 1段伸びたぶんの遅れにあたる。
    pub async fn wait_for_transcript(
        &self,
        card_id: protocol::CardId,
        what: &str,
        matches: impl Fn(&[protocol::TreeNode]) -> bool,
    ) -> Vec<protocol::TreeNode> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let nodes = self.transcript_of(card_id);
            if matches(&nodes) {
                return nodes;
            }
            assert!(
                Instant::now() < deadline,
                "{TIMEOUT:?} 以内に履歴が {what} になりませんでした（{} 件）",
                nodes.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// フックの受信口を直接叩く（擬似 claude を介さない経路の確認用）。
    ///
    /// HTTP クライアントがブロッキングなので、必ず専用スレッドへ逃がす。テストの
    /// スレッドで直接待つと、同じランタイムで動いているサーバが応答できなくなり、
    /// 自分の応答を自分で待ち続ける形で止まってしまう。
    pub async fn post_hook(&self, token: &str, event: &str, body: &str) -> u16 {
        let (addr, path, body) = (
            self.addr,
            format!("/hook/{token}/{event}"),
            body.to_string(),
        );
        tokio::task::spawn_blocking(move || testkit::post_json(addr, &path, &body))
            .await
            .expect("送信スレッドが正常に終わること")
            .expect("受信口へ送れること")
    }

    /// JSON を PUT する（設定の書き換え）。ブロッキングなので専用スレッドへ逃がす。
    pub async fn put(&self, path: &str, body: &str) -> (u16, String) {
        self.request("PUT", path, Some(body)).await
    }

    pub async fn get(&self, path: &str) -> (u16, String) {
        self.request("GET", path, None).await
    }

    /// DB に入っている間隔（設計§13-3）。
    ///
    /// `/api/settings` を読むのではなく DB を直に見るのは、**設定の持ち主
    /// （`config.toml` 側）を立てていないテストでも確かめたい**ため。
    pub async fn registry_intervals(
        &self,
    ) -> Result<server_core::db::settings::Intervals, sea_orm::DbErr> {
        let db = server_core::db::connect(&self.config.resolved_database_url())
            .await
            .expect("同じ DB へ繋げること");
        server_core::db::settings::intervals(&db, server_core::db::LOCAL_ACCOUNT_ID).await
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 一覧の更新通知を受け取り、目的の種類が来るまで待つ。
pub struct EventWatcher {
    receiver: broadcast::Receiver<ServerMessage>,
}

impl EventWatcher {
    /// **エージェントが何を報告したか**を購読する。
    ///
    /// 記録層の配信（[`SessionRegistry::subscribe_events`]）ではなくこちらを見るのは、
    /// 「差分（`Status`）で足りるか、カード全体（`SessionUpsert`）を送り直すか」の
    /// 判断が**エージェント側の性質**だから（`SessionManager::publish`）。記録層は
    /// それを転送するだけなので、間に DB を挟むぶん遅れが乗り、直前の別の報告が
    /// 窓に入り込む。
    ///
    /// ブラウザから見える形を確かめたいときは [`TestServer::wait_for_listed`] を使う。
    pub fn attach(manager: &SessionManager) -> Self {
        Self {
            receiver: manager.subscribe_events(),
        }
    }

    /// 条件に合うメッセージが届くまで受信を続ける。
    pub async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&ServerMessage) -> bool,
    ) -> ServerMessage {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match timeout(remaining, self.receiver.recv()).await {
                Ok(Ok(message)) => {
                    if matches(&message) {
                        return message;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    panic!("配信が閉じられました。{what} を待っていました")
                }
                Err(_) => panic!("{TIMEOUT:?} 以内に {what} が届きませんでした"),
            }
        }
    }
}
