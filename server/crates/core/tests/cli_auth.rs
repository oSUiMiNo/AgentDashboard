//! CLI の札（`--token`）がサーバモードを通ることの統合（CLIテスト計画 F3「札」・F4）。
//!
//! 型紙は `tests/auth.rs` の `Selfhost`——**セルフホストには PC 側が無い**ので、
//! セッションホストの居ない最小の組み立てで足りる。ここで見るのは
//! **CLI のクライアント層（`client::`）が札を線に載せ、サーバモードを通ること**。
//! 口ごとの enforcement（用途違い・失効・Cookie へ落ちない）はサーバ側の総当たり
//! （`server-core/tests/tenancy.rs`）が受け持つ。

#![allow(non_snake_case)]

mod common;

use agentdashboard_core::client;
use common::TestServer;
use server_core::db::pairing;
use std::net::SocketAddr;

/// アカウントログインの構成だけを立てる（`tests/auth.rs` の `Selfhost` の写し。
/// あちらは入口の鍵そのものを見る場所なので、CLI の都合でいじらないよう別に持つ）。
struct Selfhost {
    addr: SocketAddr,
    db: sea_orm::DatabaseConnection,
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
            "agentdashboard-cli-auth-{}",
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
        let hub =
            server_core::gateway::SessionHostHub::new(db.clone(), std::sync::Arc::clone(&registry));
        let agent: std::sync::Arc<dyn server_core::session_host::SessionHost> = std::sync::Arc::new(
            server_core::gateway::RemoteSessionHost::new(std::sync::Arc::clone(&hub)),
        );
        let ws_state = server_core::ws::AppState::new(agent, registry, config);

        // `account` 群の口も鍵の内側へ（`serve_server` と同じ合成。CLI設計§12-3）
        let router = server_core::auth::with_sessions(
            server_core::routes(ws_state, std::sync::Arc::clone(&auth)).merge(server_core::guard(
                server_core::account::routes(std::sync::Arc::clone(&hub)),
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
            dir,
            task,
        }
    }

    /// `cli` の札を1本発行して、それを持った接続先を返す。
    async fn cli_target(&self) -> client::Target {
        let account_id = pairing::ensure_account(&self.db, "わたし")
            .await
            .expect("アカウントを用意できること");
        let token = pairing::issue_token(&self.db, account_id, "CLI", pairing::TokenKind::Cli)
            .await
            .expect("札を発行できること");
        client::Target::from_url(&format!("http://{}", self.addr))
            .expect("接続先を作れること")
            .with_token(Some(token))
    }
}

#[tokio::test]
async fn cliの札でサーバモードのrestとwsが通る() {
    let server = Selfhost::start().await;
    let target = server.cli_target().await;

    // REST：鍵の内側の一覧が通る（PC が居ないので空。誰のカードが見えるかは tenancy が見る）
    let (sessions, _) = client::sessions(&target).await.expect("一覧を引けること");
    assert!(sessions.is_empty());

    // account 群も同じ札で通り、いま使っている札が kind つきで見える
    let (tokens, raw) = client::account_tokens(&target)
        .await
        .expect("札の一覧を引けること");
    assert_eq!(tokens.len(), 1, "実際: {raw}");
    assert_eq!(tokens[0].kind, "cli");
    assert!(!raw.contains("adp_"), "一覧に平文が混ざっている: {raw}");

    // WS：`/ws` も同じ札で通る（Hello が返れば upgrade を通っている。CLI設計§5-1）
    let ws = client::ws::Ws::connect(&target)
        .await
        .expect("札で /ws へ繋げること");
    ws.close().await;
}

#[tokio::test]
async fn 札なしのcliは次の一手が分かる言葉で断られる() {
    let server = Selfhost::start().await;
    let target =
        client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を作れること");

    let err = client::sessions(&target).await.expect_err("断られること");
    assert_eq!(err.exit_code(), 1, "断られた＝送り直さない族");
    let text = err.to_string();
    assert!(text.contains("ADASH_TOKEN"), "次の一手が無い: {text}");
}

#[tokio::test]
async fn 失効させた札のwsは切れる() {
    // コードレビュー対応3。revoke は PC の接続（/agent/ws）だけでなく、同じ札で
    // 張られたブラウザ側の口（/ws。follow や画面の購読が座る席）も畳む——
    // 「この札で繋がっていた接続は切れます」という CLI の言葉を嘘にしない
    let server = Selfhost::start().await;
    let target = server.cli_target().await;

    let mut ws = client::ws::Ws::connect(&target)
        .await
        .expect("札で /ws へ繋げること");

    // 自分の札を本物の口（DELETE /api/account/tokens/{id}）で失効させる
    let (tokens, _) = client::account_tokens(&target)
        .await
        .expect("札の一覧を引けること");
    assert_eq!(tokens.len(), 1);
    client::account_revoke(&target, &tokens[0].id.to_string())
        .await
        .expect("失効させられること");

    // 開きっぱなしの購読が畳まれる（Close が届いて next_event が線の切れを返す）
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if ws.next_event().await.is_err() {
                return;
            }
        }
    })
    .await
    .expect("失効から10秒以内に接続が畳まれること");
}

#[tokio::test]
async fn ローカルモードは札を持っていても素通しのまま() {
    // コードレビュー対応2。外のサーバ用に ADASH_TOKEN を rcfile へ書いた利用者が、
    // 認証の要らないローカルから全コマンド 401 で締め出されてはいけない——
    // Open モードに札の概念は無いので、来ていても無視する（identify のモード内判定）
    let server = TestServer::start().await;
    let target = client::Target::from_url(&format!("http://{}", server.addr))
        .expect("接続先を作れること")
        .with_token(Some("adp_よそのサーバの札".to_string()));

    let (sessions, _) = client::sessions(&target)
        .await
        .expect("札があっても読めること");
    assert!(sessions.is_empty());

    let ws = client::ws::Ws::connect(&target)
        .await
        .expect("札があっても /ws が開くこと");
    ws.close().await;
}

#[tokio::test]
async fn ローカルモードのaccount群はアカウントが無いという言葉で断られる() {
    // CLI設計§3-4。404 と言い分ける——口が無いことと、打ち間違いを区別できる形にする
    let server = TestServer::start().await;
    let target =
        client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を作れること");

    let err = client::account_tokens(&target)
        .await
        .expect_err("断られること");
    assert_eq!(err.exit_code(), 1);
    let text = err.to_string();
    assert!(
        text.contains("この構成にアカウントはありません"),
        "言葉が違う: {text}"
    );
}

#[tokio::test]
async fn logsの入り口は札を線に乗せる() {
    // `logs --host` の `fetch` が `Authorization: Bearer` を添えること（CLI設計§14-2。
    // ここが無いと `別PCのログを実際に読める道にする` の案Aが満たされない）。
    // 相手はヘッダを控えて答えるだけのスタブ——見たいのは**線に何が乗ったか**
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
    let port = listener.local_addr().expect("番号を読めること").port();
    let (sent, received) = std::sync::mpsc::channel::<String>();
    let serve = std::thread::spawn(move || {
        use std::io::{Read as _, Write as _};
        let (mut stream, _) = listener.accept().expect("接続が来ること");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).expect("読めること");
            buffer.extend_from_slice(&chunk[..read]);
            if read == 0 || buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        sent.send(String::from_utf8_lossy(&buffer).into_owned())
            .expect("控えを渡せること");
        let body = serde_json::to_string(&protocol::logs::LogChunk {
            host: String::new(),
            host_now: "2026-08-11T00:00:00.000Z".to_string(),
            lines: Vec::new(),
            truncated: false,
            broken: 0,
            leaks: 0,
        })
        .expect("組み立てられること");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("書けること");
    });

    let args = session_host_core::logs::LogsArgs {
        host: Some("11111111-1111-4111-8111-111111111111".to_string()),
        token: Some("adp_kore_ga_fuda".to_string()),
        ..Default::default()
    };
    tokio::task::spawn_blocking(move || session_host_core::logs::run_remote(&args, port))
        .await
        .expect("スレッドが落ちないこと")
        .expect("引けること");

    let request = received.recv().expect("要求が届いていること");
    assert!(
        request.contains("Authorization: Bearer adp_kore_ga_fuda\r\n"),
        "札が線に乗っていない:\n{request}"
    );
    serve.join().expect("スタブが最後まで生きること");
}

#[tokio::test]
async fn 改行の混ざった札は送らずに理由を名指しして断る() {
    // 黙って札を外して送ると、無認証の 401 に「失効しているかも」という誤った案内が
    // 付く（コードレビュー対応8）。**繋ぐ前に断る**ので、待ち受けは要らない
    let args = session_host_core::logs::LogsArgs {
        host: Some("11111111-1111-4111-8111-111111111111".to_string()),
        token: Some("adp_kaigyou_iri\n".to_string()),
        ..Default::default()
    };
    // 誰も居ないポートを指す——繋ぎに行ってしまったら「繋げません」で落ちるので、
    // 言葉を見れば「送る前に断った」ことまで分かる
    let err = tokio::task::spawn_blocking(move || session_host_core::logs::run_remote(&args, 1))
        .await
        .expect("スレッドが落ちないこと")
        .expect_err("断られること");
    let text = format!("{err}");
    assert!(
        text.contains("改行"),
        "理由が改行を名指ししていない: {text}"
    );
    assert!(
        !text.contains("繋げません"),
        "繋ぐ前に断ること（線を張ってしまっている）: {text}"
    );
}

#[tokio::test]
async fn dbが引けない間は503で待てと言う() {
    // コードレビュー対応4。401 は「札やログインが悪い・再試行するな」（exit 1）、
    // 503 は「記録が引けない・待って再試行」（exit 4）で、CLI の終了コード契約
    // （CLI設計§10-3）上の意味が違う。DB の一過性の断を 401 へ潰すと、正しい札を
    // 持つエージェントが「失効した」と誤学習して手を引く。
    let server = Selfhost::start().await;
    let target = server.cli_target().await;

    // まず通ることを見る——ここを飛ばすと、503 が「元から壊れていた」と区別できない
    client::sessions(&target).await.expect("札で通ること");

    // プールを畳んで「DB が引けない」を作る。sqlx のプールは clone で共有されるので、
    // テスト側の clone を閉じればサーバ側も引けなくなる
    server.db.clone().close().await.expect("プールを畳めること");

    let err = client::sessions(&target).await.expect_err("断られること");
    assert_eq!(
        err.exit_code(),
        4,
        "待って再試行する族であること（401/exit1 に化けている）: {err:?}"
    );
    let message = err.to_string();
    assert!(
        message.contains("待って"),
        "待つ案内が言葉に入っていること: {message}"
    );
}
