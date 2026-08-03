//! 入口の鍵（セルフホスト化設計§8-1〜§8-3、テスト計画フェーズ5）。
//!
//! 見るのは3通り。
//!
//! | 動かし方 | 誰が通るか |
//! |---|---|
//! | ローカル・127.0.0.1 だけ | 鍵なし（現行どおり素通し） |
//! | ローカル・LAN 開放 | 共有パスワード。**127.0.0.1 は常に免除** |
//! | セルフホスト | アカウントログイン |
//!
//! # 「免除されない側」を踏むための仕掛け
//!
//! テストの接続元は必ず 127.0.0.1 になるので、素直に叩くと**免除される側しか通らない**。
//! `TestServer::start_from` で接続元を差し替え、LAN の向こうから来た形を作っている。
//! 本番はこの値を接続そのものから取るので、差し替えているのは「どこから来たか」だけで、
//! 判定の経路は同じものを踏む。

mod common;

use std::net::SocketAddr;

/// LAN の向こうにいる端末のふり。
fn lan_peer() -> SocketAddr {
    "192.168.1.50:54321".parse().expect("読めること")
}

/// 待ち受けを広げた設定（＝ LAN 開放）。**待ち受け自体は 127.0.0.1 のまま**で、
/// 鍵の判定だけがこの値を見る。
fn opened_config() -> agentdashboard_core::config::Config {
    agentdashboard_core::config::Config {
        bind_addr: "0.0.0.0".to_string(),
        ..agentdashboard_core::config::Config::default()
    }
}

/// `GET /api/me` を読む（鍵の向こうではないので、通っていなくても答える）。
async fn me(server: &common::TestServer) -> serde_json::Value {
    let (status, body) = server.get("/api/me").await;
    assert_eq!(status, 200, "認証の要否を聞けない: {body}");
    serde_json::from_str(&body).expect("AuthView として読めること")
}

// --- ローカル・鍵なし --------------------------------------------------------

#[tokio::test]
async fn 手元だけの構成では鍵をかけない() {
    // 実機（127.0.0.1 のローカルモード）の見え方が**このフェーズでも変わらない**こと。
    // ここが落ちると、既存の利用者が突然ログインを求められる
    let server = common::TestServer::start().await;

    let view = me(&server).await;
    assert_eq!(view["mode"], "open");
    assert_eq!(view["authenticated"], true);
    // ローカルはアカウントを表に出さない
    assert_eq!(view["account"], serde_json::Value::Null);

    let (status, _) = server.get("/api/sessions").await;
    assert_eq!(status, 200, "鍵が無いのに断られた");
}

#[tokio::test]
async fn 鍵の無い構成にログインという概念は無い() {
    // 「成功した」と嘘をつくより、そんな口は無いと言う
    let mut server = common::TestServer::start().await;
    let (status, body) = server.login(None, "なんでもよい").await;
    assert_eq!(status, 400, "実際: {body}");
}

// --- ローカル・LAN 開放 ------------------------------------------------------

#[tokio::test]
async fn 広げてもローカルからは素通しできる() {
    // 直結で使っている本人を締め出さない（設計§8-3）。**パスワードは未設定のまま**でも
    // 127.0.0.1 からは通る——そうでないと、登録する画面そのものへ入れない
    let server = common::TestServer::start_with(opened_config()).await;

    let view = me(&server).await;
    assert_eq!(view["mode"], "lan_password");
    assert_eq!(view["authenticated"], true);
    assert_eq!(view["from_loopback"], true);

    let (status, _) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn 広げた先からはパスワードを通らないと断られる() {
    let server = common::TestServer::start_from(opened_config(), lan_peer()).await;

    let view = me(&server).await;
    assert_eq!(view["mode"], "lan_password");
    assert_eq!(view["authenticated"], false);
    assert_eq!(view["from_loopback"], false);

    let (status, _) = server.get("/api/sessions").await;
    assert_eq!(status, 401, "鍵がかかっていない");
}

#[tokio::test]
async fn 偽装したヘッダでは免除を得られない() {
    // **穴の閉鎖を確かめる回帰テスト。** `X-Forwarded-For: 127.0.0.1` を信じると、
    // ヘッダ1行で LAN の鍵が無効になる（設計§8-3 が「X-Forwarded-For は見ない」と
    // 明記している理由）
    let server = common::TestServer::start_from(opened_config(), lan_peer()).await;

    let (addr, cookie) = (server.addr, server.cookie.clone());
    let response = tokio::task::spawn_blocking(move || {
        let request = format!(
            "GET /api/sessions HTTP/1.1\r\nHost: {addr}\r\n\
             X-Forwarded-For: 127.0.0.1\r\nX-Real-IP: 127.0.0.1\r\n\
             Connection: close\r\n\r\n"
        );
        use std::io::{Read as _, Write as _};
        let mut stream = std::net::TcpStream::connect(addr).expect("繋げること");
        stream.write_all(request.as_bytes()).expect("送れること");
        let mut text = String::new();
        stream.read_to_string(&mut text).expect("読めること");
        text
    })
    .await
    .expect("HTTPスレッドが落ちないこと");
    let _ = cookie;

    assert!(
        response.starts_with("HTTP/1.1 401"),
        "偽装ヘッダで免除を取れてしまった: {response}"
    );
}

#[tokio::test]
async fn 共有パスワードを通れば広げた先からも入れる() {
    // 動線の確認（設計§8-3）：127.0.0.1 で登録 → LAN から要求される → 通れば入れる
    let config = opened_config();
    // **設定の持ち主も立てる**（本番のローカルモードは必ず立っている）。立てないと
    // `/api/settings` が 404 になり、確かめたい経路の手前で終わる
    let toml = std::env::temp_dir().join(format!(
        "agentdashboard-lan-{}.toml",
        uuid::Uuid::new_v4().simple()
    ));
    let here = common::TestServer::start_with_settings(config.clone(), toml.clone()).await;
    let (status, body) = here
        .put(
            "/api/settings",
            &serde_json::json!({ "lan_password": "とてもながいあいことば" }).to_string(),
        )
        .await;
    assert_eq!(status, 200, "127.0.0.1 から登録できない: {body}");
    let database_url = here.config.resolved_database_url();
    drop(here);
    let _ = std::fs::remove_file(&toml);

    // 同じ DB を指す別のサーバを、LAN の向こうから見る
    let mut there = common::TestServer::start_from(
        agentdashboard_core::config::Config {
            database_url: Some(database_url),
            ..config
        },
        lan_peer(),
    )
    .await;

    let (status, _) = there.get("/api/sessions").await;
    assert_eq!(status, 401, "登録の前後で扱いが変わっていない");

    let (status, body) = there.login(None, "ちがうあいことば").await;
    assert_eq!(status, 401, "実際: {body}");

    let (status, body) = there.login(None, "とてもながいあいことば").await;
    assert_eq!(status, 200, "実際: {body}");
    let (status, _) = there.get("/api/sessions").await;
    assert_eq!(status, 200, "通ったのに断られた");
}

#[tokio::test]
async fn 短すぎるパスワードは登録できない() {
    let server = common::TestServer::start_with(opened_config()).await;
    let (status, body) = server
        .put(
            "/api/settings",
            &serde_json::json!({ "lan_password": "みじかい" }).to_string(),
        )
        .await;
    assert_eq!(status, 400, "実際: {body}");
}

// --- セルフホスト・アカウント -------------------------------------------------

/// アカウントログインの構成だけを立てる。
///
/// [`common::TestServer`] を使わないのは、**セルフホストには PC 側が無い**ため
/// （PTY もマネージャも持たない）。ここで見たいのは入口の鍵だけなので、
/// エージェントの居ない最小の組み立てで足りる。
struct Selfhost {
    addr: SocketAddr,
    db: sea_orm::DatabaseConnection,
    cookie: Option<String>,
    dir: std::path::PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Selfhost {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Selfhost {
    async fn start() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-auth-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");

        let db =
            server_core::db::connect(&format!("sqlite://{}", dir.join("dashboard.db").display()))
                .await
                .expect("使い捨ての DB へ繋げること");

        let config = std::sync::Arc::new(server_core::config::ServerConfig::default());
        let registry = server_core::registry::SessionRegistry::load(db.clone(), 100, None)
            .await
            .expect("記録層を立てられること");
        let auth = server_core::auth::AuthContext::server(db.clone(), &config);
        let hub = server_core::gateway::AgentHub::new(db.clone(), std::sync::Arc::clone(&registry));
        let agent: std::sync::Arc<dyn server_core::agent::AgentHost> = std::sync::Arc::new(
            server_core::gateway::RemoteAgent::new(std::sync::Arc::clone(&hub)),
        );
        let ws_state = server_core::ws::AppState::new(agent, registry, config);

        let router = server_core::auth::with_sessions(
            server_core::routes(ws_state, std::sync::Arc::clone(&auth)).merge(server_core::guard(
                agentdashboard_core::settings_api::server_routes(hub).merge(
                    agentdashboard_core::versions_api::routes(
                        agentdashboard_core::versions_api::VersionsState {
                            state_dir: dir.clone(),
                            auth: std::sync::Arc::clone(&auth),
                        },
                    ),
                ),
                std::sync::Arc::clone(&auth),
            )),
            &auth,
        );

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr = listener.local_addr().expect("待ち受け先を取れること");
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        Self {
            addr,
            db,
            cookie: None,
            dir,
            task,
        }
    }

    async fn request(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
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

    async fn get(&self, path: &str) -> (u16, String) {
        self.request("GET", path, None).await
    }

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

    async fn setup(&mut self, name: &str, password: &str) -> (u16, String) {
        let body = serde_json::json!({ "name": name, "password": password }).to_string();
        self.authenticate("/api/setup", body).await
    }

    async fn login(&mut self, name: &str, password: &str) -> (u16, String) {
        let body = serde_json::json!({ "name": name, "password": password }).to_string();
        self.authenticate("/api/login", body).await
    }

    async fn logout(&mut self) {
        self.authenticate("/api/logout", "{}".to_string()).await;
        self.cookie = None;
    }

    /// 管理者ではないアカウントを1つ足す。
    ///
    /// パスワードは管理者のハッシュをそのまま写す。**ハッシュを作る道具を持ち込まずに
    /// 済ませる**ためで、同じ合言葉で入れるようになる。
    async fn add_member(&self, name: &str) {
        use sea_orm::{ColumnTrait as _, EntityTrait as _, QueryFilter as _, QuerySelect as _};
        use server_core::db::entity::accounts;

        let account_id = server_core::db::pairing::ensure_account(&self.db, name)
            .await
            .expect("アカウントを作れること");
        let hash: Option<Option<String>> = accounts::Entity::find()
            .filter(accounts::Column::IsAdmin.eq(true))
            .select_only()
            .column(accounts::Column::PasswordHash)
            .into_tuple()
            .one(&self.db)
            .await
            .expect("管理者を読めること");
        let hash = hash.flatten().expect("管理者はパスワードを持つこと");
        accounts::Entity::update_many()
            .col_expr(
                accounts::Column::PasswordHash,
                sea_orm::sea_query::Expr::value(hash),
            )
            .filter(accounts::Column::Id.eq(account_id))
            .exec(&self.db)
            .await
            .expect("パスワードを付けられること");
    }

    async fn me(&self) -> serde_json::Value {
        let (status, body) = self.get("/api/me").await;
        assert_eq!(status, 200, "認証の要否を聞けない: {body}");
        serde_json::from_str(&body).expect("AuthView として読めること")
    }
}

async fn selfhost() -> Selfhost {
    Selfhost::start().await
}

#[tokio::test]
async fn ログインしないと何も見えない() {
    let server = selfhost().await;

    let view = server.me().await;
    assert_eq!(view["mode"], "account");
    assert_eq!(view["authenticated"], false);
    assert_eq!(view["setup_open"], true, "まだ管理者が居ないので開いている");

    for path in ["/api/sessions", "/api/settings", "/api/versions"] {
        let (status, _) = server.get(path).await;
        assert_eq!(status, 401, "{path} が鍵の向こうにない");
    }
}

#[tokio::test]
async fn 管理者を作れるのは一度きり() {
    // 空判定が漏れると**誰でも管理者を作れる**（テスト計画フェーズ5）
    let mut server = selfhost().await;

    let (status, body) = server.setup("わたし", "つよいあいことば").await;
    assert_eq!(status, 200, "実際: {body}");
    // 作った本人はそのまま入れる（決めたばかりのパスワードを打ち直させない）
    let (status, _) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    assert_eq!(server.me().await["setup_open"], false, "窓が閉じていない");

    let (status, body) = server.setup("よそのひと", "べつのあいことば").await;
    assert_eq!(status, 409, "2人目の管理者を作れてしまった: {body}");
}

#[tokio::test]
async fn ログアウトすると見えなくなる() {
    let mut server = selfhost().await;
    server.setup("わたし", "つよいあいことば").await;
    assert_eq!(server.get("/api/sessions").await.0, 200);

    server.logout().await;
    assert_eq!(
        server.get("/api/sessions").await.0,
        401,
        "ログアウトしたのに見えている"
    );

    // 入り直せる
    let (status, body) = server.login("わたし", "つよいあいことば").await;
    assert_eq!(status, 200, "実際: {body}");
    assert_eq!(server.get("/api/sessions").await.0, 200);
}

#[tokio::test]
async fn 名前が無い場合とパスワード違いを呼び分けない() {
    // 分けると、どの名前が実在するかを総当たりで調べられる
    let mut server = selfhost().await;
    server.setup("わたし", "つよいあいことば").await;
    server.logout().await;

    let (wrong_password, first) = server.login("わたし", "ちがうあいことば").await;
    let (unknown_name, second) = server.login("だれでもない", "つよいあいことば").await;
    assert_eq!(wrong_password, 401);
    assert_eq!(unknown_name, 401);
    assert_eq!(first, second, "理由が呼び分けられている");
}

#[tokio::test]
async fn パスワードを持たないアカウントでは入れない() {
    // トークン発行の CLI が作る行は `password_hash` が `None`＝ログインできない
    // （設計§20 読み替え3）。ここが漏れると、名前を知っているだけで入れる
    let mut server = selfhost().await;
    server.setup("かんりしゃ", "つよいあいことば").await;
    server.logout().await;

    server_core::db::pairing::ensure_account(&server.db, "トークンだけの人")
        .await
        .expect("アカウントを作れること");

    let (status, _) = server.login("トークンだけの人", "").await;
    assert_eq!(status, 401);
    let (status, _) = server.login("トークンだけの人", "なんでもよい").await;
    assert_eq!(status, 401, "パスワードの無いアカウントで入れてしまった");
}

#[tokio::test]
async fn 先に発行したトークンのアカウントへ後からパスワードを付けられる() {
    // 5分セットアップの動線（§14-4）。**別の行を作ってはいけない**——作ると、
    // そのトークンで繋いだ PC のカードが管理者から見えなくなる
    let mut server = selfhost().await;
    let account_id = server_core::db::pairing::ensure_account(&server.db, "わたし")
        .await
        .expect("アカウントを作れること");

    let (status, body) = server.setup("わたし", "つよいあいことば").await;
    assert_eq!(status, 200, "実際: {body}");

    let same = server_core::db::pairing::ensure_account(&server.db, "わたし")
        .await
        .expect("引けること");
    assert_eq!(same, account_id, "同じ名前で別の行ができている");
}

// --- 起動時検査 ---------------------------------------------------------------

#[tokio::test]
async fn 鍵の無いまま広げようとしたら起動を拒否する() {
    // 「鍵なしで開ける事故を仕組みで防ぐ」（要件1-1）の実装点。**警告ではなく起動を止める**
    // ——警告は読まれないことがあるし、読まれたときには既に開いている
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-lan-gate-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
    let db = server_core::db::connect(&format!("sqlite://{}", dir.join("dashboard.db").display()))
        .await
        .expect("使い捨ての DB へ繋げること");

    let opened = server_core::config::ServerConfig {
        bind_addr: "0.0.0.0".to_string(),
        ..server_core::config::ServerConfig::default()
    };
    let err = server_core::auth::ensure_lan_password(&db, &opened)
        .await
        .expect_err("鍵が無いのに起動できてしまった");
    // 止めるだけでなく**直し方を出す**。何が悪いか分かっても、どうすればよいかが
    // 分からないと bind_addr を戻すしかなくなる
    let message = format!("{err}");
    assert!(message.contains("bind_addr"), "実際: {message}");
    assert!(message.contains("127.0.0.1"), "実際: {message}");

    // 手元だけの設定なら、鍵が無くても通る
    server_core::auth::ensure_lan_password(&db, &server_core::config::ServerConfig::default())
        .await
        .expect("127.0.0.1 だけなら鍵は要らない");

    // 登録すれば広げられる
    server_core::auth::set_lan_password(&db, "とてもながいあいことば")
        .await
        .expect("登録できること");
    server_core::auth::ensure_lan_password(&db, &opened)
        .await
        .expect("登録したのに拒否された");

    let _ = std::fs::remove_dir_all(dir);
}

// --- 版の切替は誰が押せるか（CICD設計§13） -----------------------------------

/// 一覧の応答を読む。
async fn versions(body: &str) -> serde_json::Value {
    serde_json::from_str(body).expect("VersionsView として読めること")
}

#[tokio::test]
async fn ローカルでは同じ機械からだけ版を触れる() {
    // 版の入れ替えは、突き詰めれば**外から実行ファイルを取ってきて走らせる**こと。
    // ログインを通っただけの相手に開ける操作ではない
    let here = common::TestServer::start().await;
    let (status, body) = here.get("/api/versions").await;
    assert_eq!(status, 200, "一覧を読めない: {body}");
    assert_eq!(
        versions(&body).await["editable"],
        true,
        "127.0.0.1 からは押せる"
    );

    let there =
        common::TestServer::start_from(agentdashboard_core::config::Config::default(), lan_peer())
            .await;
    let (status, body) = there.get("/api/versions").await;
    assert_eq!(status, 200, "見るのは誰でもよい（見えないと押せないことも分からない）");
    assert_eq!(
        versions(&body).await["editable"],
        false,
        "LAN の向こうからは押せない"
    );

    let (status, body) = there.request("DELETE", "/api/versions/0.0.1", None).await;
    assert_eq!(status, 403, "断られていない: {body}");
    assert!(body.contains("127.0.0.1"), "どこからなら通るかを書く: {body}");
}

#[tokio::test]
async fn セルフホストでは管理者だけが版を触れる() {
    let mut server = selfhost().await;
    server.setup("あるじ", "とてもながいあいことば").await;

    let (status, body) = server.get("/api/versions").await;
    assert_eq!(status, 200, "一覧を読めない: {body}");
    assert_eq!(versions(&body).await["editable"], true, "管理者は押せる");

    server.add_member("ひとり").await;
    let (status, body) = server.login("ひとり", "とてもながいあいことば").await;
    assert_eq!(status, 200, "入れない: {body}");

    let (status, body) = server.get("/api/versions").await;
    assert_eq!(status, 200, "見るのは誰でもよい: {body}");
    assert_eq!(
        versions(&body).await["editable"],
        false,
        "管理者でなければ押せない"
    );

    let (status, body) = server.request("DELETE", "/api/versions/0.0.1", None).await;
    assert_eq!(status, 403, "断られていない: {body}");
    assert!(body.contains("管理者"), "誰なら押せるかを書く: {body}");
}
