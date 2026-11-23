//! エクスプローラ・VSCode で開く口（`サイドバーにエクスプローラで開くボタンが欲しい` 設計§4）。
//!
//! # なぜ新しいファイルなのか
//!
//! 縮小の口（[`crate::compact_api`]）と同じ理由である。`/api/hosts/…` の他の口が在る
//! `server-core/src/hosts.rs` は並行して大きく触られており、**この機械（`local`）にだけ
//! 効く口**はそこへ混ぜない。`cli_surface.rs` の `鍵の内側` にこのファイルを名指しで載せる。
//!
//! # 「親PC か」は鍵ではない
//!
//! [`judge`] は、押すと窓が出る機械（親PC）の上でブラウザが開かれているかを、接続元と
//! `Host` の2つで見る。`Host` は送る側が自由に書けるので、これは**出し分けの目安**であって
//! 鍵ではない。鍵は外からかける `server_core::guard`（`require_identity`）である。
//!
//! # remote は作らない
//!
//! 窓が出るのはこの機械の画面なので、別の PC に対して意味を持たない。`local` 以外と
//! サーバモードは 501 で断る。

use axum::{
    Json, Router,
    extract::{ConnectInfo, FromRequestParts, Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header::HOST, request::Parts},
    routing::get,
};
use serde::{Deserialize, Serialize};
use server_core::lan_address;
use session_host_core::open_in::{
    self, App, BlockedLauncher, OPENED_CAP, OpenError, OpenLauncher, OpenedBook, OpenedEntry,
    Target, TargetKind, Tools, VscodeOutcome,
};
use session_host_core::resources::{WslSense, is_wsl};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// 口が抱えるもの。フィールドが pub なのは、結合テストが偽の起こし口と小さい帳面を差し込むため。
#[derive(Clone)]
pub struct OpenApiState {
    /// 外の道具を起こす口（本物・記録だけ・塞ぐ）。
    pub launcher: Arc<dyn OpenLauncher>,
    /// VSCode で開いているものの帳面。
    pub book: Arc<OpenedBook>,
    /// WSL の仮想スイッチの網（親PC の判定に使う）。
    pub link: Arc<WslLinkCache>,
    /// この口が `local` を受け持つか。**サーバモードでは false**（PTY も窓も無い）。
    pub serves_local: bool,
}

impl OpenApiState {
    /// 本番（ローカルモード）。起こし口は `AGENTDASHBOARD_OPEN_IN` で選ぶ。
    pub fn from_env() -> Self {
        Self {
            launcher: open_in::launcher_from_env(),
            book: OpenedBook::new(OPENED_CAP),
            link: Arc::new(WslLinkCache::new()),
            serves_local: true,
        }
    }

    /// サーバモード。**`host` が `local` でも必ず 501**（縮小の口とは違い、`local` を名乗る
    /// 要求を通さない）。
    pub fn server_mode() -> Self {
        Self {
            launcher: Arc::new(BlockedLauncher),
            book: OpenedBook::new(OPENED_CAP),
            link: Arc::new(WslLinkCache::fixed(None)),
            serves_local: false,
        }
    }
}

pub fn routes(state: OpenApiState) -> Router {
    Router::new()
        .route("/api/hosts/{host}/open", get(api_status).post(api_open))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// 応答の形（画面と CLI が共有）

/// 道具1つの様子。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolView {
    pub available: bool,
    pub reason: Option<String>,
}

/// VSCode で開いているもの1つ。`path` は押されたときに送られてきたパスのまま。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenedView {
    pub path: String,
    pub kind: TargetKind,
    pub since_ms: u64,
}

/// GET の答え。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenInView {
    /// このブラウザ（接続）が親PC の上か。偽なら画面は何も描かない
    pub same_machine: bool,
    /// 親PC でないと判定した理由（画面には出さない。CLI と調べもの用）
    pub same_machine_reason: Option<String>,
    pub explorer: ToolView,
    pub vscode: ToolView,
    /// VSCode で開いているもの（古い順）
    pub opened: Vec<OpenedView>,
}

/// POST の結果の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// エクスプローラを起こした
    Launched,
    /// VSCode で開いて、閉じるまで抱えた
    Opened,
    /// 既に抱えていたので、窓を前に出しただけ
    Fronted,
    /// 同じものを起こしている最中だったので、何もしなかった
    Starting,
}

impl Outcome {
    fn label(self) -> &'static str {
        match self {
            Self::Launched => "launched",
            Self::Opened => "opened",
            Self::Fronted => "fronted",
            Self::Starting => "starting",
        }
    }
}

/// POST の答え。`view` は起こした後の様子（画面が次の読み直しを待たずに差し替える）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenResult {
    pub outcome: Outcome,
    pub view: OpenInView,
}

/// POST の体。
#[derive(Debug, Clone, Deserialize)]
pub struct OpenRequest {
    pub app: App,
    pub path: String,
}

fn view(judge: Judge, tools: &Tools, opened: Vec<OpenedEntry>) -> OpenInView {
    let tool = |state: &open_in::ToolState| ToolView {
        available: state.available,
        reason: state.reason.clone(),
    };
    let (same_machine, same_machine_reason) = match judge {
        Judge::Here => (true, None),
        Judge::Elsewhere(reason) => (false, Some(reason.to_string())),
    };
    OpenInView {
        same_machine,
        same_machine_reason,
        explorer: tool(&tools.explorer),
        vscode: tool(&tools.vscode),
        opened: opened
            .into_iter()
            .map(|entry| OpenedView {
                path: entry.path.to_string_lossy().into_owned(),
                kind: entry.kind,
                since_ms: entry
                    .since
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// 「親PC か」の判定（純関数。設計§4-3）

/// WSL の仮想スイッチの網。`gateway` は Windows 側（横流しの接続元）、`net` と `prefix` は
/// WSL 自身のインターフェースの番号と幅（`in_net` が両方に mask を掛ける）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WslLink {
    pub gateway: Ipv4Addr,
    pub net: Ipv4Addr,
    pub prefix: u8,
}

/// 判定。`Elsewhere` には人が読む理由を添える。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Judge {
    Here,
    Elsewhere(&'static str),
}

/// `Host` の名前の部分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostName {
    Loopback,
    Ipv4(Ipv4Addr),
    Other,
}

const NO_PEER: &str = "接続元が分かりません";
const FROM_LAN: &str = "LAN の端末から開かれています（親PC では localhost で開いてください）";
const FROM_ELSEWHERE: &str = "別の端末から開かれています";

/// `Host` を読む。ポートは落とす。`[::1]:8787` の形も受ける。
pub fn host_name(header: &str) -> HostName {
    let header = header.trim();
    if let Some(rest) = header.strip_prefix('[') {
        let inner = rest.split(']').next().unwrap_or("");
        return if inner == "::1" {
            HostName::Loopback
        } else {
            HostName::Other
        };
    }
    let name = match header.matches(':').count() {
        1 => header.split(':').next().unwrap_or(""),
        _ => header,
    };
    if name.eq_ignore_ascii_case("localhost") {
        return HostName::Loopback;
    }
    match name.parse::<Ipv4Addr>() {
        Ok(addr) if addr.is_loopback() => HostName::Loopback,
        Ok(addr) => HostName::Ipv4(addr),
        Err(_) => HostName::Other,
    }
}

/// このブラウザが親PC の上で開かれているか。
///
/// **これは鍵ではない。** `Host` は送る側が書ける。鍵は外の `guard`（`require_identity`）。
///
/// NAT モードの WSL では、親PC のブラウザも同じ Wi-Fi のスマホも、Windows の横流しを通って
/// 同じゲートウェイの番号から届く（接続元だけでは見分けられない）。そこで、ゲートウェイから
/// 来た接続は**ブラウザが打った宛先**で決める——スマホは親PC の `localhost` にも WSL の
/// 仮想スイッチの番号にも届かないので、そこを宛先にして届いた時点で親PC の上に居る。
pub fn judge(peer: Option<SocketAddr>, host_header: Option<&str>, link: Option<WslLink>) -> Judge {
    let Some(peer) = peer else {
        return Judge::Elsewhere(NO_PEER);
    };
    let ip = match peer.ip() {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    if ip.is_loopback() {
        return Judge::Here;
    }
    if let Some(link) = link
        && ip == IpAddr::V4(link.gateway)
    {
        return match host_header.map(host_name) {
            Some(HostName::Loopback) => Judge::Here,
            Some(HostName::Ipv4(addr)) if lan_address::in_net(addr, link.net, link.prefix) => {
                Judge::Here
            }
            _ => Judge::Elsewhere(FROM_LAN),
        };
    }
    Judge::Elsewhere(FROM_ELSEWHERE)
}

/// 接続元のアドレス。**無ければ無いまま渡す。**
///
/// `Option<ConnectInfo<..>>` は取り出し器にならない（axum 0.8）。`client_logs.rs` の同じ形は
/// 非公開なので、ここにも1つ置く。
struct Peer(Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr),
        ))
    }
}

// ---------------------------------------------------------------------------
// WSL の網（設計§4-4）

const LINK_TTL: Duration = Duration::from_secs(60);

/// WSL の網を覚えておく。GET は開いているタブごとに 3 秒おきに来るので、毎回 `ip` を2回
/// 起こさない。**読めなかった結果も同じだけ覚える。**
#[derive(Debug)]
pub struct WslLinkCache {
    fixed: Option<Option<WslLink>>,
    cell: Mutex<Option<(Instant, Option<WslLink>)>>,
}

impl Default for WslLinkCache {
    fn default() -> Self {
        Self::new()
    }
}

impl WslLinkCache {
    /// 実物を読む。
    pub fn new() -> Self {
        Self {
            fixed: None,
            cell: Mutex::new(None),
        }
    }

    /// 決まった値を返す（テスト・サーバモード用）。
    pub fn fixed(link: Option<WslLink>) -> Self {
        Self {
            fixed: Some(link),
            cell: Mutex::new(None),
        }
    }

    pub async fn get(&self) -> Option<WslLink> {
        if let Some(link) = self.fixed {
            return link;
        }
        {
            let cell = self
                .cell
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some((at, link)) = *cell
                && at.elapsed() < LINK_TTL
            {
                return link;
            }
        }
        let link = read_link().await;
        let mut cell = self
            .cell
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cell = Some((Instant::now(), link));
        link
    }
}

async fn read_link() -> Option<WslLink> {
    if !is_wsl(&WslSense::read()) {
        return None;
    }
    let addrs = lan_address::run_with_timeout(
        "ip",
        &["-4", "-o", "addr", "show"],
        lan_address::ASK_TIMEOUT,
    )
    .await
    .ok()?;
    let route = lan_address::run_with_timeout(
        "ip",
        &["route", "show", "default"],
        lan_address::ASK_TIMEOUT,
    )
    .await
    .ok()?;
    let locals = lan_address::parse_ip_addr(&addrs);
    let (gateway, _) = lan_address::parse_default_route(&route)?;
    let (net, prefix) = lan_address::gateway_net(&locals, gateway)?;
    Some(WslLink {
        gateway,
        net,
        prefix,
    })
}

// ---------------------------------------------------------------------------
// ハンドラ（設計§4-5）

type Refusal = (StatusCode, String);

const NOT_LOCAL: &str = "エクスプローラ・VSCode で開くのは、この機械（local）でだけです";
const NOT_HERE: &str = "このブラウザは親PC の上で開かれていないので、窓を開けません。親PC では localhost で開いてください";
const BAD_PATH: &str = "パスは / から始まる絶対パスで渡してください";
const NO_PATH: &str = "そのパスは在りません";
const STOPPED: &str = "外の道具を起こす処理が途中で止まりました";
const UNAVAILABLE: &str = "この道具はいま使えません";

fn local_only(state: &OpenApiState, host: &str) -> Result<(), Refusal> {
    if state.serves_local && host == "local" {
        return Ok(());
    }
    Err((StatusCode::NOT_IMPLEMENTED, NOT_LOCAL.to_string()))
}

/// 道具の有無を読む。**止まりうるので別のスレッドへ逃がす**（本物は 30 秒ごとに `/mnt/c` の
/// 下を見る）。
async fn tools_of(state: &OpenApiState) -> Result<Tools, Refusal> {
    let launcher = Arc::clone(&state.launcher);
    match tokio::task::spawn_blocking(move || launcher.tools()).await {
        Ok(tools) => Ok(tools),
        Err(err) => {
            tracing::warn!(
                kind = "open_in_failed",
                reason = %err,
                "外の道具の様子を読めませんでした"
            );
            Err((StatusCode::INTERNAL_SERVER_ERROR, STOPPED.to_string()))
        }
    }
}

async fn api_status(
    AxumPath(host): AxumPath<String>,
    State(state): State<OpenApiState>,
    Peer(peer): Peer,
    headers: HeaderMap,
) -> Result<Json<OpenInView>, Refusal> {
    local_only(&state, &host)?;
    let host_header = headers.get(HOST).and_then(|v| v.to_str().ok());
    let judge = judge(peer, host_header, state.link.get().await);
    let tools = tools_of(&state).await?;
    // **ログは出さない**——3 秒おきに来るので、いちばん読みたい行が埋まる
    Ok(Json(view(judge, &tools, state.book.list())))
}

/// 開く。
///
/// **体は `axum::Json` で受ける。`Bytes`／`String` で受けて自分で読む形にしない。**
/// `Content-Type: application/json` でない要求は取り出しの段で 415 になる——他のサイトの
/// ページが送れる「単純な要求」（`text/plain`・form）で親PC に窓を出させない門である
/// （設計§4-6）。
async fn api_open(
    AxumPath(host): AxumPath<String>,
    State(state): State<OpenApiState>,
    Peer(peer): Peer,
    headers: HeaderMap,
    Json(body): Json<OpenRequest>,
) -> Result<Json<OpenResult>, Refusal> {
    local_only(&state, &host)?;

    let host_header = headers.get(HOST).and_then(|v| v.to_str().ok());
    let judge = judge(peer, host_header, state.link.get().await);
    if judge != Judge::Here {
        tracing::info!(
            kind = "open_in_refused",
            peer = %peer.map(|p| p.to_string()).unwrap_or_else(|| "-".to_string()),
            host_header = host_header.unwrap_or("-"),
            "親PC でない接続から開こうとしたので断りました"
        );
        return Err((StatusCode::FORBIDDEN, NOT_HERE.to_string()));
    }

    let path = body.path;
    if !Path::new(&path).is_absolute() || path.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, BAD_PATH.to_string()));
    }
    let kind = match tokio::fs::metadata(&path).await {
        Ok(meta) if meta.is_dir() => TargetKind::Dir,
        Ok(meta) if meta.is_file() => TargetKind::File,
        _ => return Err((StatusCode::NOT_FOUND, NO_PATH.to_string())),
    };

    let tools = tools_of(&state).await?;
    let tool = match body.app {
        App::Explorer => &tools.explorer,
        App::Vscode => &tools.vscode,
    };
    if !tool.available {
        let reason = tool
            .reason
            .clone()
            .unwrap_or_else(|| UNAVAILABLE.to_string());
        return Err(unavailable(body.app, &path, reason));
    }

    let class = open_in::classify(Path::new(&path));
    let target = Target {
        path: PathBuf::from(&path),
        kind,
        class,
    };
    let app = body.app;
    let launcher = Arc::clone(&state.launcher);
    let book = Arc::clone(&state.book);
    // **起こしとその後のログは、ハンドラから切り離した task で行う。** 押してすぐタブを
    // 閉じると、axum はハンドラの future を落とす。起こしは `spawn_blocking` の中で続くのに、
    // その後のログ（`open_in`・`open_in_failed`）だけが消えていた（6-A で実測）。
    // `tokio::spawn` の task は JoinHandle を落としても最後まで走る
    let log_path = path.clone();
    let task = tokio::spawn(async move {
        let launched = tokio::task::spawn_blocking(move || match app {
            App::Explorer => launcher.explorer(&target).map(|()| Outcome::Launched),
            App::Vscode => {
                book.open_vscode(launcher.as_ref(), target)
                    .map(|outcome| match outcome {
                        VscodeOutcome::Opened => Outcome::Opened,
                        VscodeOutcome::Fronted => Outcome::Fronted,
                        VscodeOutcome::Starting => Outcome::Starting,
                    })
            }
        })
        .await;
        let outcome = match launched {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(err)) => return Err(refusal_of(app, &log_path, err)),
            Err(err) => return Err(stopped(app, &log_path, &err)),
        };
        tracing::info!(
            kind = "open_in",
            app = app.label(),
            target_kind = kind.label(),
            path_class = class.label(),
            outcome = outcome.label(),
            path = %log_path,
            "外の道具で開きました"
        );
        Ok(outcome)
    });
    let outcome = match task.await {
        Ok(result) => result?,
        Err(err) => return Err(stopped(app, &path, &err)),
    };

    Ok(Json(OpenResult {
        outcome,
        view: view(judge, &tools, state.book.list()),
    }))
}

/// 起こす処理の task が途中で止まった（panic・取り消し）。
fn stopped(app: App, path: &str, err: &tokio::task::JoinError) -> Refusal {
    tracing::warn!(
        kind = "open_in_failed",
        app = app.label(),
        reason = %err,
        path = %path,
        "外の道具を起こせませんでした"
    );
    (StatusCode::INTERNAL_SERVER_ERROR, STOPPED.to_string())
}

/// 道具がいま使えないので断る。手前の確かめと起こす段のどちらか一方だけが出すので、同じ押しで2行にならない。
///
/// **断った押しにも1行残す。** 残さないと、押したのに何も起きなかった理由をログから辿れない（設計§11）。
fn unavailable(app: App, path: &str, reason: String) -> Refusal {
    tracing::warn!(
        kind = "open_in_failed",
        app = app.label(),
        stage = "unavailable",
        reason = %reason,
        path = %path,
        "外の道具がいま使えないので開けませんでした"
    );
    (StatusCode::SERVICE_UNAVAILABLE, reason)
}

/// 起こせなかった理由を HTTP の番号へ写す（設計§4-5）。
fn refusal_of(app: App, path: &str, err: OpenError) -> Refusal {
    match err {
        OpenError::Unavailable(reason) => unavailable(app, path, reason),
        full @ OpenError::Full { .. } => {
            tracing::warn!(
                kind = "open_in_failed",
                app = app.label(),
                stage = "full",
                reason = %full,
                path = %path,
                "VSCode で開いているものが上限なので開けませんでした"
            );
            (
                StatusCode::CONFLICT,
                format!("{full}。どれかを閉じてから押してください"),
            )
        }
        err @ (OpenError::Spawn(_) | OpenError::Convert(_)) => {
            tracing::warn!(
                kind = "open_in_failed",
                app = app.label(),
                reason = %err,
                path = %path,
                "外の道具を起こせませんでした"
            );
            (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn link() -> WslLink {
        WslLink {
            gateway: Ipv4Addr::new(192, 168, 144, 1),
            net: Ipv4Addr::new(192, 168, 147, 44),
            prefix: 20,
        }
    }

    fn peer(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn 接続元が分からなければ別の端末とみなす() {
        assert_eq!(
            judge(None, Some("localhost:8787"), Some(link())),
            Judge::Elsewhere(NO_PEER)
        );
    }

    #[test]
    fn ループバックからは何を打っても親PC() {
        for from in [
            "127.0.0.1:5000",
            "127.5.5.5:5000",
            "[::1]:5000",
            "[::ffff:127.0.0.1]:5000",
        ] {
            for host in [Some("example.com"), Some("192.168.0.12:8787"), None] {
                assert_eq!(
                    judge(peer(from), host, None),
                    Judge::Here,
                    "接続元 {from}・Host {host:?} は親PC と判定されること"
                );
            }
        }
    }

    #[test]
    fn ゲートウェイから来てlocalhostを打っていれば親PC() {
        for host in [
            "localhost:8787",
            "LOCALHOST:8787",
            "127.0.0.1:8787",
            "[::1]:8787",
        ] {
            assert_eq!(
                judge(peer("192.168.144.1:5000"), Some(host), Some(link())),
                Judge::Here,
                "Host {host} は親PC と判定されること"
            );
        }
    }

    #[test]
    fn ゲートウェイから来てWSLの網の番号を打っていれば親PC() {
        for host in ["192.168.147.44:8787", "192.168.144.1:8787"] {
            assert_eq!(
                judge(peer("192.168.144.1:5000"), Some(host), Some(link())),
                Judge::Here,
                "Host {host} は親PC と判定されること"
            );
        }
    }

    #[test]
    fn ゲートウェイから来てLANの番号を打っていればLANの端末() {
        assert_eq!(
            judge(
                peer("192.168.144.1:5000"),
                Some("192.168.0.12:8787"),
                Some(link())
            ),
            Judge::Elsewhere(FROM_LAN)
        );
        assert_eq!(
            judge(peer("192.168.144.1:5000"), None, Some(link())),
            Judge::Elsewhere(FROM_LAN)
        );
    }

    #[test]
    fn WSLの網が分からなければゲートウェイの番号でも別の端末() {
        assert_eq!(
            judge(peer("192.168.144.1:5000"), Some("localhost:8787"), None),
            Judge::Elsewhere(FROM_ELSEWHERE)
        );
    }

    #[test]
    fn それ以外の接続元は別の端末() {
        assert_eq!(
            judge(
                peer("192.168.1.50:5000"),
                Some("localhost:8787"),
                Some(link())
            ),
            Judge::Elsewhere(FROM_ELSEWHERE)
        );
    }

    #[test]
    fn Hostの名前を読む() {
        assert_eq!(host_name("localhost:8787"), HostName::Loopback);
        assert_eq!(host_name("LOCALHOST"), HostName::Loopback);
        assert_eq!(host_name("127.0.0.1:1"), HostName::Loopback);
        assert_eq!(host_name("[::1]:8787"), HostName::Loopback);
        assert_eq!(
            host_name("192.168.144.1:8787"),
            HostName::Ipv4(Ipv4Addr::new(192, 168, 144, 1))
        );
        assert_eq!(host_name("example.com"), HostName::Other);
        assert_eq!(host_name(""), HostName::Other);
    }

    /// 起こしの途中で止まる偽の起こし口。`explorer` は `release` に合図が来るまで戻らない。
    #[derive(Debug)]
    struct Hold {
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl open_in::OpenLauncher for Hold {
        fn tools(&self) -> Tools {
            Tools {
                explorer: open_in::ToolState::ok(),
                vscode: open_in::ToolState::ok(),
            }
        }

        fn explorer(&self, _target: &Target) -> Result<(), OpenError> {
            let release = self.release.lock().unwrap().take();
            if let Some(release) = release {
                release.recv().ok();
            }
            Ok(())
        }

        fn vscode(
            &self,
            _target: &Target,
            _wait: bool,
        ) -> Result<Option<open_in::Waiter>, OpenError> {
            Ok(None)
        }
    }

    /// VSCode の起こしの途中で止まる偽の起こし口。入ったら `entered` へ知らせ、`release` を待つ。
    #[derive(Debug)]
    struct HoldVscode {
        entered: Mutex<std::sync::mpsc::Sender<()>>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl open_in::OpenLauncher for HoldVscode {
        fn tools(&self) -> Tools {
            Tools {
                explorer: open_in::ToolState::ok(),
                vscode: open_in::ToolState::ok(),
            }
        }

        fn explorer(&self, _target: &Target) -> Result<(), OpenError> {
            Ok(())
        }

        fn vscode(
            &self,
            _target: &Target,
            _wait: bool,
        ) -> Result<Option<open_in::Waiter>, OpenError> {
            self.entered.lock().unwrap().send(()).ok();
            let release = self.release.lock().unwrap().take();
            if let Some(release) = release {
                release.recv().ok();
            }
            Ok(None)
        }
    }

    #[tokio::test]
    async fn 起こしている最中の2回目は起こしている最中と答えてそう書く() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-open-api-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let state = OpenApiState {
            launcher: Arc::new(HoldVscode {
                entered: Mutex::new(entered_tx),
                release: Mutex::new(Some(held)),
            }),
            book: open_in::OpenedBook::new(open_in::OPENED_CAP),
            link: Arc::new(WslLinkCache::fixed(None)),
            serves_local: true,
        };
        let press = |state: OpenApiState, path: String| {
            api_open(
                AxumPath("local".to_string()),
                State(state),
                Peer(peer("127.0.0.1:5000")),
                HeaderMap::new(),
                Json(OpenRequest {
                    app: App::Vscode,
                    path,
                }),
            )
        };
        let first = tokio::spawn(press(state.clone(), path.clone()));
        tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .expect("1回目が起こし口に入ること");

        let sink = session_host_core::logging::capture::sink();
        let mark = sink.mark();
        let second = press(state, path.clone()).await.expect("2回目は断らない");
        let rows: Vec<_> = sink
            .matching(mark, "path", &path)
            .into_iter()
            .filter(|row| row["kind"] == "open_in")
            .collect();
        release.send(()).unwrap();
        let first = first.await.unwrap().expect("1回目は開ける");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            second.0.outcome,
            Outcome::Starting,
            "起こしている最中の2回目は、前へ出したではなく起こしている最中と答えること"
        );
        assert_eq!(first.0.outcome, Outcome::Opened);
        assert_eq!(rows.len(), 1, "2回目の open_in の行がちょうど1行: {rows:?}");
        assert_eq!(
            rows[0]["outcome"], "starting",
            "ログも起こしている最中と書くこと: {rows:?}"
        );
    }

    #[tokio::test]
    async fn 押してすぐ切れても開いたログは残る() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-open-api-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        let (release, held) = std::sync::mpsc::channel();
        let state = OpenApiState {
            launcher: Arc::new(Hold {
                release: Mutex::new(Some(held)),
            }),
            book: open_in::OpenedBook::new(open_in::OPENED_CAP),
            link: Arc::new(WslLinkCache::fixed(None)),
            serves_local: true,
        };
        let sink = session_host_core::logging::capture::sink();
        let mark = sink.mark();

        let handler = api_open(
            AxumPath("local".to_string()),
            State(state),
            Peer(peer("127.0.0.1:5000")),
            HeaderMap::new(),
            Json(OpenRequest {
                app: App::Explorer,
                path: path.clone(),
            }),
        );
        // 起こし口が止まっている間にハンドラの future を落とす（押してすぐタブを閉じたとき、
        // axum が切断でハンドラを落とすのと同じ形）
        assert!(
            tokio::time::timeout(Duration::from_millis(200), handler)
                .await
                .is_err(),
            "起こし口が止まっている間は返らないこと"
        );
        release.send(()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let logged = loop {
            let lines = sink.matching(mark, "path", &path);
            if lines.iter().any(|line| line["kind"] == "open_in") {
                break true;
            }
            if Instant::now() > deadline {
                break false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            logged,
            "ハンドラが落とされても、起こした後の open_in の行が残ること"
        );
    }
}
