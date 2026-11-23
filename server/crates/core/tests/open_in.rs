//! エクスプローラ・VSCode で開く口（`サイドバーにエクスプローラで開くボタンが欲しい` 設計§4・§6）。
//!
//! **本物の道具は1つも起こさない。** 起こし口は偽物（呼ばれた引数を控え、待ちは手で終わらせる）を
//! 差し込む。接続元は一番外側の layer で差し替える（`common::TestServer` と同じ形）。

#![allow(non_snake_case)]

mod common;

use agentdashboard_core::open_api::{self, OpenApiState, WslLink, WslLinkCache};
use session_host_core::open_in::{
    App, BlockedLauncher, OPENED_CAP, OpenError, OpenLauncher, OpenedBook, Target, ToolState,
    Tools, Waiter,
};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// 部品

/// 偽の起こし口。呼ばれた引数を控え、VSCode の待ちは [`Fake::close_all`] で終わらせる。
#[derive(Debug)]
struct Fake {
    tools: Tools,
    calls: Mutex<Vec<(App, PathBuf, bool)>>,
    closers: Mutex<Vec<oneshot::Sender<()>>>,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            tools: Tools {
                explorer: ToolState::ok(),
                vscode: ToolState::ok(),
            },
            calls: Mutex::new(Vec::new()),
            closers: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<(App, PathBuf, bool)> {
        self.calls.lock().unwrap().clone()
    }

    fn close_all(&self) {
        for closer in self.closers.lock().unwrap().drain(..) {
            closer.send(()).ok();
        }
    }
}

impl OpenLauncher for Fake {
    fn tools(&self) -> Tools {
        self.tools.clone()
    }

    fn explorer(&self, target: &Target) -> Result<(), OpenError> {
        self.calls
            .lock()
            .unwrap()
            .push((App::Explorer, target.path.clone(), false));
        Ok(())
    }

    fn vscode(&self, target: &Target, wait: bool) -> Result<Option<Waiter>, OpenError> {
        self.calls
            .lock()
            .unwrap()
            .push((App::Vscode, target.path.clone(), wait));
        if !wait {
            return Ok(None);
        }
        let (tx, rx) = oneshot::channel();
        self.closers.lock().unwrap().push(tx);
        Ok(Some(Box::pin(async move {
            rx.await.ok();
            Ok(())
        })))
    }
}

/// 起こす段で「使えない」と分かる起こし口。道具の有無を読む段では使えると答える。
#[derive(Debug)]
struct LateUnavailable;

const LATE_REASON: &str = "起こす段で使えないと分かった";

impl OpenLauncher for LateUnavailable {
    fn tools(&self) -> Tools {
        Tools {
            explorer: ToolState::ok(),
            vscode: ToolState::ok(),
        }
    }

    fn explorer(&self, _target: &Target) -> Result<(), OpenError> {
        Err(OpenError::Unavailable(LATE_REASON.to_string()))
    }

    fn vscode(&self, _target: &Target, _wait: bool) -> Result<Option<Waiter>, OpenError> {
        Err(OpenError::Unavailable(LATE_REASON.to_string()))
    }
}

/// そのパスの押しで出た `open_in_failed`（`stage=unavailable`）の行。
fn unavailable_rows(
    sink: &session_host_core::logging::capture::Sink,
    mark: usize,
    path: &str,
) -> Vec<serde_json::Value> {
    sink.matching(mark, "path", path)
        .into_iter()
        .filter(|row| row["kind"] == "open_in_failed" && row["stage"] == "unavailable")
        .collect()
}

/// WSL の仮想スイッチの網（実機の形）。
fn link() -> WslLink {
    WslLink {
        gateway: Ipv4Addr::new(192, 168, 144, 1),
        net: Ipv4Addr::new(192, 168, 147, 44),
        prefix: 20,
    }
}

fn gateway_peer() -> SocketAddr {
    "192.168.144.1:5000".parse().unwrap()
}

fn lan_peer() -> SocketAddr {
    "192.168.1.50:54321".parse().unwrap()
}

fn state_with(launcher: Arc<dyn OpenLauncher>) -> OpenApiState {
    OpenApiState {
        launcher,
        book: OpenedBook::new(OPENED_CAP),
        link: Arc::new(WslLinkCache::fixed(Some(link()))),
        serves_local: true,
    }
}

/// 使い捨てのフォルダ。中に `dir/` と `file.txt` を作る。
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "agentdashboard-open-in-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();
        Self(root)
    }

    fn dir(&self) -> String {
        self.0.join("dir").to_string_lossy().into_owned()
    }

    fn file(&self) -> String {
        self.0.join("file.txt").to_string_lossy().into_owned()
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// 口だけを立てる。`peer` を渡すと接続元をその番号に差し替える。`lan_password` なら
/// 待ち受けを広げた構成（LAN パスワード）の鍵をかける。
async fn start(state: OpenApiState, peer: Option<SocketAddr>, lan_password: bool) -> SocketAddr {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-open-in-db-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = server_core::db::connect(&format!("sqlite://{}", dir.join("dashboard.db").display()))
        .await
        .expect("使い捨ての DB へ繋げること");
    let config = server_core::config::ServerConfig {
        bind_addr: if lan_password { "0.0.0.0" } else { "127.0.0.1" }.to_string(),
        ..server_core::config::ServerConfig::default()
    };
    let auth = server_core::auth::AuthContext::local(db, &config);
    let mut router = server_core::auth::with_sessions(
        server_core::guard(open_api::routes(state), Arc::clone(&auth)),
        &auth,
    );
    // 接続元を差し替えるなら一番外側で（鍵の判定より外）
    if let Some(peer) = peer {
        router = router.layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| async move {
                request
                    .extensions_mut()
                    .insert(axum::extract::ConnectInfo(peer));
                next.run(request).await
            },
        ));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .ok();
    });
    addr
}

/// 生の HTTP を1往復する。**`Host` と `Content-Type` を自分で決める**（`testkit::request_raw`
/// はどちらも決め打ちするので使わない）。
async fn send(
    addr: SocketAddr,
    method: &str,
    path: &str,
    host: &str,
    content_type: Option<&str>,
    body: Option<&str>,
) -> (u16, String) {
    let method = method.to_string();
    let path = path.to_string();
    let host = host.to_string();
    let content_type = content_type.map(str::to_string);
    let body = body.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        if let Some(content_type) = &content_type {
            head.push_str(&format!("Content-Type: {content_type}\r\n"));
        }
        if let Some(body) = &body {
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
        if let Some(body) = &body {
            stream.write_all(body.as_bytes()).unwrap();
        }
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let parsed = testkit::parse_raw_response(&raw).expect("応答を読めること");
        (
            parsed.status,
            String::from_utf8_lossy(&parsed.body).into_owned(),
        )
    })
    .await
    .unwrap()
}

const OPEN: &str = "/api/hosts/local/open";

fn open_body(app: &str, path: &str) -> String {
    serde_json::json!({ "app": app, "path": path }).to_string()
}

async fn post_json(addr: SocketAddr, url: &str, host: &str, body: &str) -> (u16, String) {
    send(
        addr,
        "POST",
        url,
        host,
        Some("application/json"),
        Some(body),
    )
    .await
}

async fn get(addr: SocketAddr, url: &str, host: &str) -> (u16, String) {
    send(addr, "GET", url, host, None, None).await
}

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|err| panic!("JSON でない（{err}）: {body}"))
}

// ---------------------------------------------------------------------------
// 口（TP3）

#[tokio::test]
async fn localでない名とサーバモードは501() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let host = addr.to_string();

    let (status, _) = get(addr, "/api/hosts/pc-1/open", &host).await;
    assert_eq!(status, 501, "local でない名の GET は 501");
    let (status, body) = post_json(
        addr,
        "/api/hosts/pc-1/open",
        &host,
        &open_body("explorer", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 501, "local でない名の POST は 501: {body}");

    let server = start(OpenApiState::server_mode(), None, false).await;
    let host = server.to_string();
    let (status, _) = get(server, OPEN, &host).await;
    assert_eq!(status, 501, "サーバモードは local でも GET が 501");
    let (status, body) =
        post_json(server, OPEN, &host, &open_body("explorer", &scratch.dir())).await;
    assert_eq!(status, 501, "サーバモードは local でも POST が 501: {body}");

    assert!(fake.calls().is_empty(), "起こし口は呼ばれないこと");
}

#[tokio::test]
async fn LANから開いた画面には窓を開かせない() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), Some(gateway_peer()), false).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let (status, body) = post_json(
        addr,
        OPEN,
        "192.168.0.12:8787",
        &open_body("explorer", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 403, "LAN の番号を打った接続は 403: {body}");
    assert!(body.contains("親PC の上で開かれていない"), "{body}");
    assert!(fake.calls().is_empty(), "起こし口は呼ばれないこと");
    assert!(
        !sink.matching(mark, "kind", "open_in_refused").is_empty(),
        "断ったことがログに残ること"
    );
}

#[tokio::test]
async fn 親PCからはエクスプローラで開ける() {
    let scratch = Scratch::new();

    // ① ループバックから
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let (status, body) = post_json(
        addr,
        OPEN,
        &addr.to_string(),
        &open_body("explorer", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(json(&body)["outcome"], "launched");
    assert_eq!(
        fake.calls(),
        vec![(App::Explorer, PathBuf::from(scratch.dir()), false)]
    );
    let rows = sink.matching(mark, "kind", "open_in");
    let row = rows.last().expect("開いたことがログに残ること");
    assert_eq!(row["app"], "explorer");
    assert_eq!(row["target_kind"], "dir");
    assert_eq!(row["outcome"], "launched");
    assert!(
        row.get("path_class").is_some() && row.get("path").is_some(),
        "{row}"
    );

    // ② ゲートウェイから、localhost を打って。ファイルも開ける
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), Some(gateway_peer()), false).await;
    let mark = sink.mark();
    let (status, body) = post_json(
        addr,
        OPEN,
        "localhost:8787",
        &open_body("explorer", &scratch.file()),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        fake.calls(),
        vec![(App::Explorer, PathBuf::from(scratch.file()), false)]
    );
    let rows = sink.matching(mark, "kind", "open_in");
    assert_eq!(rows.last().expect("ログ")["target_kind"], "file");
}

#[tokio::test]
async fn VSCodeで開くと閉じるまで印が残り二度押しは前に出すだけ() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let host = addr.to_string();

    let (status, body) = post_json(addr, OPEN, &host, &open_body("vscode", &scratch.dir())).await;
    assert_eq!(status, 200, "{body}");
    let first = json(&body);
    assert_eq!(first["outcome"], "opened");
    assert_eq!(
        first["view"]["opened"][0]["path"],
        scratch.dir(),
        "送ったパスのまま返る"
    );
    assert_eq!(first["view"]["opened"][0]["kind"], "dir");

    let (status, body) = post_json(addr, OPEN, &host, &open_body("vscode", &scratch.dir())).await;
    assert_eq!(status, 200, "{body}");
    let second = json(&body);
    assert_eq!(second["outcome"], "fronted");
    assert_eq!(second["view"]["opened"].as_array().unwrap().len(), 1);
    assert_eq!(
        fake.calls(),
        vec![
            (App::Vscode, PathBuf::from(scratch.dir()), true),
            (App::Vscode, PathBuf::from(scratch.dir()), false),
        ],
        "1回目は待ち付き、2回目は待ちを増やさない"
    );

    fake.close_all();
    let mut emptied = false;
    for _ in 0..40 {
        let (_, body) = get(addr, OPEN, &host).await;
        if json(&body)["opened"].as_array().unwrap().is_empty() {
            emptied = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(emptied, "待ちが終わったら印が消えること");
}

#[tokio::test]
async fn 相対パスとNULは400で無いパスは404() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let host = addr.to_string();

    let (status, body) = post_json(addr, OPEN, &host, &open_body("explorer", "rel/x")).await;
    assert_eq!(status, 400, "相対パスは 400: {body}");
    let (status, body) = post_json(addr, OPEN, &host, &open_body("explorer", "/tmp/a\u{0}b")).await;
    assert_eq!(status, 400, "NUL を含むパスは 400: {body}");
    let missing = scratch.path("無い").to_string_lossy().into_owned();
    let (status, body) = post_json(addr, OPEN, &host, &open_body("explorer", &missing)).await;
    assert_eq!(status, 404, "無いパスは 404: {body}");
    assert!(fake.calls().is_empty(), "起こし口は呼ばれないこと");
}

#[tokio::test]
async fn 塞いだ起こし口は503で理由を返す() {
    let scratch = Scratch::new();
    let addr = start(state_with(Arc::new(BlockedLauncher)), None, false).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let (status, body) = post_json(
        addr,
        OPEN,
        &addr.to_string(),
        &open_body("vscode", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 503, "{body}");
    assert!(
        body.contains("AGENTDASHBOARD_OPEN_IN=off"),
        "理由をそのまま返す: {body}"
    );
    let failed = unavailable_rows(sink, mark, &scratch.dir());
    assert_eq!(
        failed.len(),
        1,
        "使えずに断った押しは open_in_failed（stage=unavailable）がちょうど1行: {failed:?}"
    );

    let mark = sink.mark();
    let (status, body) = get(addr, OPEN, &addr.to_string()).await;
    assert_eq!(status, 200, "{body}");
    let failed = sink.matching(mark, "kind", "open_in_failed");
    assert!(failed.is_empty(), "GET ではログを出さない: {failed:?}");
}

#[tokio::test]
async fn 起こす段で使えないと分かったら503と1行のログ() {
    let scratch = Scratch::new();
    let addr = start(state_with(Arc::new(LateUnavailable)), None, false).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();
    let (status, body) = post_json(
        addr,
        OPEN,
        &addr.to_string(),
        &open_body("vscode", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 503, "{body}");
    assert!(body.contains(LATE_REASON), "理由をそのまま返す: {body}");
    let failed = unavailable_rows(sink, mark, &scratch.dir());
    assert_eq!(
        failed.len(),
        1,
        "起こす段で使えずに断った押しは open_in_failed（stage=unavailable）がちょうど1行: {failed:?}"
    );
}

#[tokio::test]
async fn 上限まで抱えると409で8件と言う() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let host = addr.to_string();
    for n in 0..=OPENED_CAP {
        std::fs::create_dir_all(scratch.path(&format!("d{n}"))).unwrap();
    }
    for n in 0..OPENED_CAP {
        let path = scratch
            .path(&format!("d{n}"))
            .to_string_lossy()
            .into_owned();
        let (status, body) = post_json(addr, OPEN, &host, &open_body("vscode", &path)).await;
        assert_eq!(status, 200, "{n} 件目は開ける: {body}");
    }
    let path = scratch
        .path(&format!("d{OPENED_CAP}"))
        .to_string_lossy()
        .into_owned();
    let (status, body) = post_json(addr, OPEN, &host, &open_body("vscode", &path)).await;
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("8 件"), "{body}");
    fake.close_all();
}

#[tokio::test]
async fn GETは親PCでなくても200で理由を添える() {
    let sink = session_host_core::logging::capture::sink();

    let lan = start(state_with(Fake::new()), Some(gateway_peer()), false).await;
    let mark = sink.mark();
    let (status, body) = get(lan, OPEN, "192.168.0.12:8787").await;
    assert_eq!(status, 200, "{body}");
    let view = json(&body);
    assert_eq!(view["same_machine"], false);
    assert!(view["same_machine_reason"].is_string(), "{view}");

    let here = start(state_with(Fake::new()), None, false).await;
    let (status, body) = get(here, OPEN, &here.to_string()).await;
    assert_eq!(status, 200, "{body}");
    let view = json(&body);
    assert_eq!(view["same_machine"], true);
    assert_eq!(view["explorer"]["available"], true);
    assert_eq!(view["vscode"]["available"], true);
    assert!(view["opened"].is_array(), "{view}");

    let open_rows: Vec<_> = sink
        .since(mark)
        .into_iter()
        .filter(|row| {
            row["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("open_in"))
        })
        .collect();
    assert!(
        open_rows.is_empty(),
        "GET ではログを出さない: {open_rows:?}"
    );
}

#[tokio::test]
async fn JSONでない体は415で起こし口まで届かない() {
    // 門が無ければ通ってしまう条件（親PC・在るフォルダ・正しい JSON の本文）で送る
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let body = open_body("explorer", &scratch.dir());

    let (status, text) = send(
        addr,
        "POST",
        OPEN,
        "localhost:8787",
        Some("text/plain"),
        Some(&body),
    )
    .await;
    assert_eq!(status, 415, "JSON でない体は 415: {text}");
    assert!(fake.calls().is_empty(), "起こし口は呼ばれないこと");

    // 対照：同じ本文を JSON として送ると通る
    let (status, text) = post_json(addr, OPEN, "localhost:8787", &body).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(fake.calls().len(), 1);
}

#[tokio::test]
async fn 既定のLocalServerには口が無い() {
    let scratch = Scratch::new();
    let server = common::TestServer::start().await;
    let host = server.addr.to_string();

    let (status, body) = get(server.addr, OPEN, &host).await;
    let has_view = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .is_some_and(|value| value.get("same_machine").is_some());
    assert!(
        !has_view,
        "with_open_in を呼ばない LocalServer に口が在る（{status}）: {body}"
    );

    let (status, body) = post_json(
        server.addr,
        OPEN,
        &host,
        &open_body("explorer", &scratch.dir()),
    )
    .await;
    assert_ne!(status, 200, "POST が通ってはいけない: {body}");
    assert_eq!(status, 405, "受け皿は GET だけなので 405: {body}");
}

#[tokio::test]
async fn 鍵の内側にある() {
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), Some(lan_peer()), true).await;

    let (status, body) = get(addr, OPEN, "192.168.0.12:8787").await;
    assert_eq!(status, 401, "合言葉無しの GET は断られる: {body}");
    let (status, body) = post_json(
        addr,
        OPEN,
        "192.168.0.12:8787",
        &open_body("explorer", &scratch.dir()),
    )
    .await;
    assert_eq!(status, 401, "合言葉無しの POST は断られる: {body}");
    assert!(fake.calls().is_empty(), "起こし口は呼ばれないこと");

    // 対照：同じ構成で 127.0.0.1 から（免除）なら通る
    let here = start(state_with(Fake::new()), None, true).await;
    let (status, body) = get(here, OPEN, &here.to_string()).await;
    assert_eq!(status, 200, "{body}");
}

// ---------------------------------------------------------------------------
// CLI（TP4）。CLI の関数を直に呼ぶ（実行ファイルは起こさない）

fn target_of(addr: SocketAddr) -> agentdashboard_core::client::Target {
    agentdashboard_core::client::Target::from_url(&format!("http://{addr}")).unwrap()
}

#[tokio::test]
async fn CLIで様子を読むと人の読む形と生のJSONが出る() {
    use agentdashboard_core::client::open_in;
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let target = target_of(addr);

    open_in::open(
        &target,
        "local",
        &scratch.dir(),
        App::Vscode,
        std::path::Path::new("/"),
    )
    .await
    .expect("VSCode で開けること");
    let (view, raw) = open_in::status(&target, "local")
        .await
        .expect("様子を読めること");
    let text = open_in::render_opened(&view, i64::MAX / 2);
    assert!(text.contains("この端末：親PC（ボタンが出ます）"), "{text}");
    assert!(text.contains("エクスプローラ：使えます"), "{text}");
    assert!(text.contains("VSCode：使えます"), "{text}");
    assert!(
        text.contains(&format!("- {}（フォルダ）", scratch.dir())),
        "{text}"
    );
    assert!(json(&raw).get("same_machine").is_some(), "{raw}");
    fake.close_all();
}

#[tokio::test]
async fn CLIで開くと3つの結果の文が出る() {
    use agentdashboard_core::client::open_in;
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    let target = target_of(addr);
    let root = std::path::Path::new("/");

    // 200 で返ること自体が、CLI の POST に Content-Type: application/json が付いている証拠
    // （付いていなければ 415）
    let (result, _) = open_in::open(&target, "local", &scratch.dir(), App::Explorer, root)
        .await
        .expect("エクスプローラで開けること");
    assert_eq!(
        open_in::render_open_result(&result),
        "エクスプローラで開きました"
    );
    let (result, _) = open_in::open(&target, "local", &scratch.dir(), App::Vscode, root)
        .await
        .expect("VSCode で開けること");
    assert_eq!(
        open_in::render_open_result(&result),
        "VSCode で開きました。閉じるまで印が付きます"
    );
    let (result, _) = open_in::open(&target, "local", &scratch.dir(), App::Vscode, root)
        .await
        .expect("二度目も通ること");
    assert_eq!(
        open_in::render_open_result(&result),
        "もう VSCode で開いていたので、窓を前に出しました"
    );
    fake.close_all();
}

#[tokio::test]
async fn CLIの相対パスは作業フォルダからの絶対パスで届く() {
    use agentdashboard_core::client::open_in;
    let scratch = Scratch::new();
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;

    open_in::open(&target_of(addr), "local", "dir", App::Explorer, &scratch.0)
        .await
        .expect("相対パスでも開けること");
    assert_eq!(
        fake.calls(),
        vec![(App::Explorer, scratch.path("dir"), false)],
        "作業フォルダからの絶対パスで届くこと"
    );
}

#[tokio::test]
async fn CLIの断りは本文がそのまま出て終了コードが0でない() {
    use agentdashboard_core::client::open_in;
    let scratch = Scratch::new();
    let root = std::path::Path::new("/");

    // 404
    let addr = start(state_with(Fake::new()), None, false).await;
    let missing = scratch.path("無い").to_string_lossy().into_owned();
    let err = open_in::open(&target_of(addr), "local", &missing, App::Explorer, root)
        .await
        .expect_err("無いパスは断られること");
    assert!(err.to_string().contains("そのパスは在りません"), "{err}");
    assert_ne!(err.exit_code(), 0);

    // 503：本文の理由をそのまま（DB の断の文に置き換えない）
    let addr = start(state_with(Arc::new(BlockedLauncher)), None, false).await;
    let err = open_in::open(&target_of(addr), "local", &scratch.dir(), App::Vscode, root)
        .await
        .expect_err("塞いだ起こし口は断られること");
    assert!(
        err.to_string().contains("AGENTDASHBOARD_OPEN_IN=off"),
        "理由がそのまま出ること: {err}"
    );
    assert!(
        !err.to_string().contains("記録"),
        "DB の断の文ではないこと: {err}"
    );
    assert_ne!(err.exit_code(), 0);

    // 409
    let fake = Fake::new();
    let addr = start(state_with(fake.clone()), None, false).await;
    for n in 0..OPENED_CAP {
        let dir = scratch.path(&format!("d{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        open_in::open(
            &target_of(addr),
            "local",
            &dir.to_string_lossy(),
            App::Vscode,
            root,
        )
        .await
        .expect("上限までは開けること");
    }
    let err = open_in::open(&target_of(addr), "local", &scratch.dir(), App::Vscode, root)
        .await
        .expect_err("上限を超えると断られること");
    assert!(err.to_string().contains("8 件"), "{err}");
    assert_ne!(err.exit_code(), 0);
    fake.close_all();

    // 403：LAN の端末から
    let addr = start(state_with(Fake::new()), Some(lan_peer()), false).await;
    let err = open_in::open(
        &target_of(addr),
        "local",
        &scratch.dir(),
        App::Explorer,
        root,
    )
    .await
    .expect_err("親PC でない接続は断られること");
    assert!(
        err.to_string().contains("親PC の上で開かれていない"),
        "{err}"
    );
    assert_ne!(err.exit_code(), 0);
}
