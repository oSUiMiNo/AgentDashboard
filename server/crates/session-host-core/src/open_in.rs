//! エクスプローラ・VSCode で開く起こし口と、VSCode の待ちを抱える帳面。
//!
//! 設計：`サイドバーにエクスプローラで開くボタンが欲しい` 設計 §3。
//! 起こし口は差し替えられる形にしてあり、本物（[`RealLauncher`]）・記録だけ（[`RecordLauncher`]）・
//! 塞ぐ（[`BlockedLauncher`]）の3つを環境変数 [`OPEN_IN_ENV`] で選ぶ。**分からない値は塞ぐ側へ倒す**
//! ——本物へ倒すと、綴りを1字間違えたテストが開発者の画面に窓を出す。

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    future::Future,
    io::Write as _,
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::resources::{WslSense, is_wsl};

/// 起こし口の選び方を決める環境変数。綴りは `testkit::OPEN_IN_ENV` と一致させる（テストが見張る）。
pub const OPEN_IN_ENV: &str = "AGENTDASHBOARD_OPEN_IN";

/// VSCode の待ちを同時に抱える上限。
///
/// 当初は 32 だったが、実機で WSL の中のフォルダ1本の待ちが約 110 MB だったので 8 にした
/// （設計 §3-6・§10 の M7）。
pub const OPENED_CAP: usize = 8;

/// 絶対パスで指す。`PATH` に Windows の道が載らない構成でも通るようにするため（`compact.rs` の
/// `SCHTASKS` と同じ理由）。
const EXPLORER: &str = "/mnt/c/Windows/explorer.exe";
const WSLPATH: &str = "/usr/bin/wslpath";
/// Windows の実行ファイルを起こすときの作業フォルダ。UNC の作業フォルダから起こすと警告が出る。
const WINDOWS_DIR: &str = "/mnt/c/Windows";
const WINDOWS_USERS: &str = "/mnt/c/Users";
const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const CONVERT_TIMEOUT: Duration = Duration::from_secs(5);
const TOOLS_TTL: Duration = Duration::from_secs(30);
const RECORD_POLL: Duration = Duration::from_millis(200);

const BLOCKED_REASON: &str =
    "この起動では外の道具を起こさない設定です（AGENTDASHBOARD_OPEN_IN=off）";
const NOT_WSL_REASON: &str = "この機械ではまだ使えません（WSL で動くダッシュボードだけが対象です）";
const NO_EXPLORER_REASON: &str = "explorer.exe が見つかりません";
const NO_VSCODE_REASON: &str = "VSCode が見つかりません（PATH と既定の入れ場所を探しました）";
const NO_DISTRO_REASON: &str = "WSL のディストロ名が分かりません";
const OUTSIDE_RUNTIME: &str = "tokio の実行環境の外から呼ばれました";

/// 子へ渡してよい環境変数（名前の完全一致）。
///
/// **許す一覧にしてあるのは、`wslCode.sh` が呼ばれた環境を丸ごと VSCode の WSL 側へ持ち込む
/// ため**（設計 §3-4）。ダッシュボードや claude 向けの変数を窓の中まで運ばない。
const PASSED_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "TZ",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "PULSE_SERVER",
    "WSL_INTEROP",
    "WSLENV",
];

/// 前置で許すもの。
const PASSED_ENV_PREFIX: &[&str] = &["LC_"];

// ---------------------------------------------------------------------------
// 型

/// どの道具で開くか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum App {
    Explorer,
    Vscode,
}

impl App {
    /// ログの欄と記録の行に使う綴り。
    pub fn label(self) -> &'static str {
        match self {
            Self::Explorer => "explorer",
            Self::Vscode => "vscode",
        }
    }
}

/// 開く相手がフォルダかファイルか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Dir,
    File,
}

impl TargetKind {
    /// ログの欄と記録の行に使う綴り。
    pub fn label(self) -> &'static str {
        match self {
            Self::Dir => "dir",
            Self::File => "file",
        }
    }
}

/// パスの種類。起こし方がこれで分かれる（設計 §3-4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathClass {
    /// `/mnt/<ドライブ>` の下。Windows の VSCode でそのまま開く
    WindowsDrive { letter: char },
    /// WSL の中。Remote-WSL の窓で開く
    Wsl,
}

impl PathClass {
    /// ログの欄 `path_class` に使う綴り。
    pub fn label(self) -> &'static str {
        match self {
            Self::WindowsDrive { .. } => "windows_drive",
            Self::Wsl => "wsl",
        }
    }
}

/// 開く相手。**在るか・種類は組む側（口）が確かめてから渡す**——存在しないパスをエクスプローラへ
/// 渡すと、黙って別の場所を開く。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub path: PathBuf,
    pub kind: TargetKind,
    pub class: PathClass,
}

/// 道具が使えるか。使えないときは人が読む理由を添える。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolState {
    pub available: bool,
    pub reason: Option<String>,
}

impl ToolState {
    pub fn ok() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

/// 2つの道具の様子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tools {
    pub explorer: ToolState,
    pub vscode: ToolState,
}

impl Tools {
    fn both(state: ToolState) -> Self {
        Self {
            explorer: state.clone(),
            vscode: state,
        }
    }
}

/// VSCode で開いているもの1つ。`path` は押されたときに送られてきたパスのまま。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedEntry {
    pub path: PathBuf,
    pub kind: TargetKind,
    pub since: SystemTime,
}

/// 起こせなかった理由。口がこれを HTTP の番号へ写す（503・409・500・500）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    /// 道具が無い・塞いである
    #[error("{0}")]
    Unavailable(String),
    /// 抱える数の上限
    #[error("VSCode で開いているものが上限（{cap} 件）に達しています")]
    Full { cap: usize },
    /// 起こせなかった
    #[error("起こせませんでした：{0}")]
    Spawn(String),
    /// `wslpath` が失敗した
    #[error("パスを Windows の形に直せませんでした：{0}")]
    Convert(String),
}

/// VSCode で開いた結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VscodeOutcome {
    /// 新しく開いて、閉じるまで抱えた
    Opened,
    /// 既に抱えていたので、窓を前へ出しただけ（待ちは増やさない）
    Fronted,
}

/// 「閉じるまで終わらない待ち」。
pub type Waiter = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

// ---------------------------------------------------------------------------
// 純関数

/// パスの種類を決める。`/mnt/<英字1字>` とその下なら Windows のドライブ（大小は無視）。
pub fn classify(path: &Path) -> PathClass {
    let mut parts = path.components();
    if parts.next() != Some(Component::RootDir) {
        return PathClass::Wsl;
    }
    let (Some(Component::Normal(mnt)), Some(Component::Normal(drive))) =
        (parts.next(), parts.next())
    else {
        return PathClass::Wsl;
    };
    if mnt != "mnt" {
        return PathClass::Wsl;
    }
    match drive.to_str().map(str::as_bytes) {
        Some([letter]) if letter.is_ascii_alphabetic() => PathClass::WindowsDrive {
            letter: char::from(letter.to_ascii_lowercase()),
        },
        _ => PathClass::Wsl,
    }
}

/// エクスプローラへ渡す引数。
///
/// **ファイルは `/select,` とパスを別々の2つの引数で渡す。** 1つにまとめると、空白入りのパスで
/// 全体が `"…"` に包まれ、エクスプローラが `/select,` を読めずに「ドキュメント」を開く（実機で
/// 確かめた。設計 §10 の M5）。`/select,` が抜けると、エクスプローラはファイルを**開いて**しまう。
pub fn explorer_args(kind: TargetKind, win: &str) -> Vec<String> {
    match kind {
        TargetKind::Dir => vec![win.to_string()],
        TargetKind::File => vec!["/select,".to_string(), win.to_string()],
    }
}

fn is_passed_env(name: &str) -> bool {
    PASSED_ENV.contains(&name)
        || PASSED_ENV_PREFIX
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// 子へ渡す環境を組む（呼ぶ側は `env_clear()` してからこれを積む）。
///
/// - 許す一覧の外は全部落とす
/// - `WSL_DISTRO_NAME` は**親に無くても足す**。無いと `code` script が WSL2 を見分けられない
///   （実機で確かめた。設計 §3-4）。`distro` が空なら足さない
/// - Windows のドライブのときだけ、`ELECTRON_RUN_AS_NODE=1` と、`WSLENV` の先頭に
///   `ELECTRON_RUN_AS_NODE/w` を足す。これが無いと `Code.exe` は CLI ではなく本体として起き、
///   それでも窓は開くので見落とす
/// - `PATH` が無ければ既定の道を足す（`code` script が `realpath` などを使うため）
pub fn child_env<I>(parent: I, distro: &str, class: PathClass) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env: BTreeMap<String, String> = parent
        .into_iter()
        .filter(|(name, _)| is_passed_env(name))
        .collect();
    if env.get("PATH").is_none_or(String::is_empty) {
        env.insert("PATH".to_string(), DEFAULT_PATH.to_string());
    }
    if !distro.is_empty() {
        env.insert("WSL_DISTRO_NAME".to_string(), distro.to_string());
    }
    if let PathClass::WindowsDrive { .. } = class {
        env.insert("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string());
        let wslenv = match env.get("WSLENV").filter(|value| !value.is_empty()) {
            Some(value) => format!("ELECTRON_RUN_AS_NODE/w:{value}"),
            None => "ELECTRON_RUN_AS_NODE/w".to_string(),
        };
        env.insert("WSLENV".to_string(), wslenv);
    }
    env.into_iter().collect()
}

/// script の中の `NAME="…"` の行の中身。行が無い・中身が空なら `None`。
pub fn script_value(script: &str, name: &str) -> Option<String> {
    let head = format!("{name}=\"");
    script.lines().find_map(|line| {
        let value = line.trim().strip_prefix(&head)?.strip_suffix('"')?;
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// `code` script が指す版のフォルダ（`VERSIONFOLDER`）。VSCode を上げるたびに変わるので固定しない。
pub fn version_folder(script: &str) -> Option<String> {
    script_value(script, "VERSIONFOLDER")
}

/// VSCode の `code` script らしいか。`PATH` の同名の別物を弾くため（設計 §3-5）。
pub fn looks_like_vscode_script(script: &str) -> bool {
    script.contains("VSCODE_PATH=")
}

/// `wslpath -w /` の答え（`\\wsl.localhost\<名前>\`・`\\wsl$\<名前>\`）からディストロ名を読む。
pub fn distro_from_unc(s: &str) -> Option<String> {
    let s = s.trim();
    let lower = s.to_ascii_lowercase();
    let rest = [r"\\wsl.localhost\", r"\\wsl$\"]
        .iter()
        .find_map(|prefix| lower.starts_with(prefix).then(|| &s[prefix.len()..]))?;
    let name = rest.split('\\').next().unwrap_or_default();
    (!name.is_empty()).then(|| name.to_string())
}

/// `code` を探す候補。上から順に見る（実在の確かめは見つける側がする）。
pub fn code_candidates(path_var: Option<&str>, windows_users: &[String]) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = path_var
        .unwrap_or_default()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("code"))
        .collect();
    candidates.extend(windows_users.iter().map(|user| {
        Path::new(WINDOWS_USERS)
            .join(user)
            .join("AppData/Local/Programs/Microsoft VS Code/bin/code")
    }));
    candidates.push(PathBuf::from(
        "/mnt/c/Program Files/Microsoft VS Code/bin/code",
    ));
    candidates
}

/// WSL のパスで VSCode を開く引数（`code` script へ渡す）。
pub fn vscode_args_wsl(path: &Path, wait: bool) -> Vec<OsString> {
    let mut args = Vec::new();
    if wait {
        args.push(OsString::from("--wait"));
    }
    args.push(path.as_os_str().to_os_string());
    args
}

/// Windows のドライブのパスで VSCode を開く引数（`Code.exe` へ渡す。先頭が `cli.js`）。
pub fn vscode_args_drive(cli_win: &str, target_win: &str, wait: bool) -> Vec<String> {
    let mut args = vec![cli_win.to_string()];
    if wait {
        args.push("--wait".to_string());
    }
    args.push(target_win.to_string());
    args
}

/// 実機の材料から、道具が使えるかを決める（読む側と決める側を分ける。`is_wsl` と同じ考え）。
pub fn tools_from(
    sense: &WslSense,
    explorer_present: bool,
    wslpath_present: bool,
    code: Option<&Path>,
) -> Tools {
    if !cfg!(unix) || !is_wsl(sense) {
        return Tools::both(ToolState::unavailable(NOT_WSL_REASON));
    }
    Tools {
        explorer: if explorer_present && wslpath_present {
            ToolState::ok()
        } else {
            ToolState::unavailable(NO_EXPLORER_REASON)
        },
        vscode: if code.is_some() && wslpath_present {
            ToolState::ok()
        } else {
            ToolState::unavailable(NO_VSCODE_REASON)
        },
    }
}

// ---------------------------------------------------------------------------
// 起こし口

/// 外の道具を起こす口。**トレイトにしてあるのはテストのため**——本物を撃つと開発者の画面に
/// 窓が出るので、テストからは呼べない。
///
/// **tokio の実行環境の中から呼ぶこと**（子の引き取り・待ちを `tokio::spawn`／`tokio::process`
/// で行うため）。口は `spawn_blocking` の中から呼ぶ（その中も実行環境の内側）。
pub trait OpenLauncher: Send + Sync + std::fmt::Debug {
    /// 道具が使えるか。GET のたびに呼ぶので軽いこと（本物は 30 秒覚える）。
    fn tools(&self) -> Tools;
    /// エクスプローラで開く。起こせたら `Ok`。終わりは待たない（引き取りは裏で）。
    fn explorer(&self, target: &Target) -> Result<(), OpenError>;
    /// VSCode で開く。`wait` なら「閉じるまで終わらない待ち」を返す。
    fn vscode(&self, target: &Target, wait: bool) -> Result<Option<Waiter>, OpenError>;
}

/// 塞いだ起こし口。道具は2つとも使えないと答え、押されたら断る。
#[derive(Debug, Clone, Copy, Default)]
pub struct BlockedLauncher;

impl OpenLauncher for BlockedLauncher {
    fn tools(&self) -> Tools {
        Tools::both(ToolState::unavailable(BLOCKED_REASON))
    }

    fn explorer(&self, _target: &Target) -> Result<(), OpenError> {
        Err(OpenError::Unavailable(BLOCKED_REASON.to_string()))
    }

    fn vscode(&self, _target: &Target, _wait: bool) -> Result<Option<Waiter>, OpenError> {
        Err(OpenError::Unavailable(BLOCKED_REASON.to_string()))
    }
}

/// 記録だけする起こし口（E2E 用）。起こさずに `<dir>/requests.jsonl` へ1行ずつ書く。
///
/// VSCode の待ちは `<dir>/close-<id>` が現れるまで続く——E2E が印の消えるところまで通すため。
/// `close-<id>` は置いた側（E2E）が片付ける。
#[derive(Debug)]
pub struct RecordLauncher {
    dir: PathBuf,
    next_id: AtomicU64,
}

impl RecordLauncher {
    /// フォルダが無ければ作ってから組む。
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            next_id: AtomicU64::new(1),
        })
    }

    fn record(&self, app: App, target: &Target, wait: bool) -> Result<u64, OpenError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let line = serde_json::json!({
            "id": id,
            "app": app.label(),
            "kind": target.kind.label(),
            "path": target.path.to_string_lossy(),
            "wait": wait,
        });
        let mut bytes = line.to_string().into_bytes();
        bytes.push(b'\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("requests.jsonl"))
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|err| OpenError::Spawn(format!("記録を書けません：{err}")))?;
        Ok(id)
    }
}

impl OpenLauncher for RecordLauncher {
    fn tools(&self) -> Tools {
        Tools::both(ToolState::ok())
    }

    fn explorer(&self, target: &Target) -> Result<(), OpenError> {
        self.record(App::Explorer, target, false).map(|_| ())
    }

    fn vscode(&self, target: &Target, wait: bool) -> Result<Option<Waiter>, OpenError> {
        let id = self.record(App::Vscode, target, wait)?;
        if !wait {
            return Ok(None);
        }
        let close = self.dir.join(format!("close-{id}"));
        Ok(Some(Box::pin(async move {
            while !close.exists() {
                tokio::time::sleep(RECORD_POLL).await;
            }
        })))
    }
}

/// 本物の起こし口。
#[derive(Debug, Default)]
pub struct RealLauncher {
    tools_cache: Mutex<Option<(Instant, Tools)>>,
    distro: OnceLock<Option<String>>,
}

fn in_runtime() -> Result<(), OpenError> {
    tokio::runtime::Handle::try_current()
        .map(|_| ())
        .map_err(|_| OpenError::Spawn(OUTSIDE_RUNTIME.to_string()))
}

/// 親の環境のうち、名前も値も UTF-8 として読めるもの（`std::env::vars` は読めない値で panic する）。
fn parent_env() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// `wslpath <flag> <path>` の答え。`proc::run` は標準エラーも後ろに連結するので、最初の行を使う。
fn to_windows(path: &Path, flag: &str) -> Result<String, OpenError> {
    let outcome = crate::proc::run(
        std::process::Command::new(WSLPATH).arg(flag).arg(path),
        CONVERT_TIMEOUT,
    );
    let first = outcome
        .output
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if outcome.success && !first.is_empty() {
        Ok(first)
    } else {
        Err(OpenError::Convert(outcome.output.trim().to_string()))
    }
}

fn windows_users() -> Vec<String> {
    match std::fs::read_dir(WINDOWS_USERS) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn is_vscode_script(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    let executable = std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false);
    executable
        && std::fs::read_to_string(path)
            .map(|script| looks_like_vscode_script(&script))
            .unwrap_or(false)
}

fn find_code() -> Option<PathBuf> {
    code_candidates(std::env::var("PATH").ok().as_deref(), &windows_users())
        .into_iter()
        .find(|candidate| is_vscode_script(candidate))
}

/// 起こした子を裏で引き取る（ゾンビを残さない）。**終了コードは見ない**——`explorer.exe` は
/// 成功しても 1 を返す（設計 §10 の M5）。
fn reap(mut child: tokio::process::Child, app: App, path: PathBuf) {
    tokio::spawn(async move {
        if let Err(err) = child.wait().await {
            warn_wait_failed(app, &path, &err);
        }
    });
}

fn warn_wait_failed(app: App, path: &Path, err: &std::io::Error) {
    tracing::warn!(
        kind = "open_in_failed",
        app = app.label(),
        stage = "wait",
        reason = %err,
        path = %path.display(),
        "外の道具の終わりを待てませんでした"
    );
}

/// 子の終わりを待つだけの待ち。
fn waiter_of(mut child: tokio::process::Child, path: PathBuf) -> Waiter {
    Box::pin(async move {
        if let Err(err) = child.wait().await {
            warn_wait_failed(App::Vscode, &path, &err);
        }
    })
}

/// 素の Windows の VSCode を起こす材料（`Code.exe` と `cli.js`）。
struct DriveTools {
    exe: PathBuf,
    cli: PathBuf,
}

/// `code` script の実体の2つ上が VSCode のフォルダ（script の `VSCODE_PATH` と同じ求め方）。
fn drive_tools(code: &Path) -> Result<DriveTools, String> {
    let real =
        std::fs::canonicalize(code).map_err(|err| format!("code の実体を辿れません：{err}"))?;
    let vscode_dir = real
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "VSCode のフォルダが分かりません".to_string())?;
    let script =
        std::fs::read_to_string(code).map_err(|err| format!("code を読めません：{err}"))?;
    let folder =
        version_folder(&script).ok_or_else(|| "VERSIONFOLDER の行がありません".to_string())?;
    let name = script_value(&script, "NAME").unwrap_or_else(|| "Code".to_string());
    let cli = vscode_dir.join(&folder).join("resources/app/out/cli.js");
    let exe = vscode_dir.join(format!("{name}.exe"));
    if !cli.is_file() {
        return Err(format!("cli.js がありません：{}", cli.display()));
    }
    if !exe.is_file() {
        return Err(format!("{name}.exe がありません：{}", exe.display()));
    }
    Ok(DriveTools { exe, cli })
}

impl RealLauncher {
    /// ディストロ名。自分の `WSL_DISTRO_NAME`、無ければ `wslpath -w /` の答えから読む（1回だけ）。
    fn distro(&self) -> Option<String> {
        self.distro
            .get_or_init(|| {
                std::env::var("WSL_DISTRO_NAME")
                    .ok()
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        to_windows(Path::new("/"), "-w")
                            .ok()
                            .and_then(|unc| distro_from_unc(&unc))
                    })
            })
            .clone()
    }

    fn spawn_wsl_code(
        &self,
        code: &Path,
        target: &Target,
        wait: bool,
    ) -> Result<tokio::process::Child, OpenError> {
        let distro = self
            .distro()
            .ok_or_else(|| OpenError::Unavailable(NO_DISTRO_REASON.to_string()))?;
        let home = std::env::var("HOME")
            .ok()
            .filter(|home| Path::new(home).is_dir())
            .unwrap_or_else(|| "/".to_string());
        tokio::process::Command::new(code)
            .args(vscode_args_wsl(&target.path, wait))
            .env_clear()
            .envs(child_env(parent_env(), &distro, PathClass::Wsl))
            .current_dir(home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map_err(|err| OpenError::Spawn(err.to_string()))
    }

    fn spawn_drive_code(
        &self,
        tools: &DriveTools,
        target: &Target,
        wait: bool,
    ) -> Result<tokio::process::Child, OpenError> {
        let cli_win = to_windows(&tools.cli, "-m")?;
        let target_win = to_windows(&target.path, "-w")?;
        tokio::process::Command::new(&tools.exe)
            .args(vscode_args_drive(&cli_win, &target_win, wait))
            .env_clear()
            .envs(child_env(
                parent_env(),
                self.distro().as_deref().unwrap_or_default(),
                target.class,
            ))
            .current_dir(WINDOWS_DIR)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map_err(|err| OpenError::Spawn(err.to_string()))
    }
}

impl OpenLauncher for RealLauncher {
    fn tools(&self) -> Tools {
        let mut cache = self
            .tools_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, tools)) = cache.as_ref() {
            if at.elapsed() < TOOLS_TTL {
                return tools.clone();
            }
        }
        let tools = tools_from(
            &WslSense::read(),
            Path::new(EXPLORER).exists(),
            Path::new(WSLPATH).exists(),
            find_code().as_deref(),
        );
        *cache = Some((Instant::now(), tools.clone()));
        tools
    }

    fn explorer(&self, target: &Target) -> Result<(), OpenError> {
        in_runtime()?;
        if !Path::new(EXPLORER).exists() {
            return Err(OpenError::Unavailable(NO_EXPLORER_REASON.to_string()));
        }
        let win = to_windows(&target.path, "-w")?;
        let child = tokio::process::Command::new(EXPLORER)
            .args(explorer_args(target.kind, &win))
            .env_clear()
            .envs(child_env(
                parent_env(),
                self.distro().as_deref().unwrap_or_default(),
                PathClass::Wsl,
            ))
            .current_dir(WINDOWS_DIR)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| OpenError::Spawn(err.to_string()))?;
        reap(child, App::Explorer, target.path.clone());
        Ok(())
    }

    fn vscode(&self, target: &Target, wait: bool) -> Result<Option<Waiter>, OpenError> {
        in_runtime()?;
        let code =
            find_code().ok_or_else(|| OpenError::Unavailable(NO_VSCODE_REASON.to_string()))?;
        let child = match target.class {
            PathClass::Wsl => self.spawn_wsl_code(&code, target, wait)?,
            PathClass::WindowsDrive { .. } => match drive_tools(&code) {
                Ok(tools) => self.spawn_drive_code(&tools, target, wait)?,
                Err(reason) => {
                    // **止めずに Remote-WSL の窓で開く。** 利用者は VSCode で開けるので困らない
                    tracing::warn!(
                        kind = "open_in_fallback",
                        reason = %reason,
                        "素の Windows の VSCode を起こす材料が揃わないので、Remote-WSL の窓で開きます"
                    );
                    self.spawn_wsl_code(&code, target, wait)?
                }
            },
        };
        if wait {
            Ok(Some(waiter_of(child, target.path.clone())))
        } else {
            reap(child, App::Vscode, target.path.clone());
            Ok(None)
        }
    }
}

/// 環境変数の値から、どの起こし口を使うかを決める（純関数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LauncherChoice {
    Real,
    Blocked,
    Record(PathBuf),
    Invalid(String),
}

/// 値の表は設計 §3-2。**分からない値は `Invalid`**（呼ぶ側が塞ぐ側へ倒す）。
pub fn choose_launcher(value: Option<&str>) -> LauncherChoice {
    match value {
        None | Some("") | Some("real") => LauncherChoice::Real,
        Some("off") => LauncherChoice::Blocked,
        Some(other) => match other.strip_prefix("record:") {
            Some(dir) if !dir.is_empty() => LauncherChoice::Record(PathBuf::from(dir)),
            _ => LauncherChoice::Invalid(other.to_string()),
        },
    }
}

/// 値から起こし口を作る。記録のフォルダを作れないとき・分からない値のときは塞ぐ側へ倒して WARN。
pub fn launcher_from_value(value: Option<&str>) -> Arc<dyn OpenLauncher> {
    match choose_launcher(value) {
        LauncherChoice::Real => Arc::new(RealLauncher::default()),
        LauncherChoice::Blocked => Arc::new(BlockedLauncher),
        LauncherChoice::Record(dir) => match RecordLauncher::new(dir.clone()) {
            Ok(launcher) => Arc::new(launcher),
            Err(err) => {
                tracing::warn!(
                    kind = "open_in_env",
                    value = %format!("record:{}", dir.display()),
                    reason = %err,
                    "記録の置き場所を作れないので、外の道具を起こす口を塞ぎます"
                );
                Arc::new(BlockedLauncher)
            }
        },
        LauncherChoice::Invalid(value) => {
            tracing::warn!(
                kind = "open_in_env",
                value = %value,
                "AGENTDASHBOARD_OPEN_IN の値が分からないので、外の道具を起こす口を塞ぎます"
            );
            Arc::new(BlockedLauncher)
        }
    }
}

/// いまの環境（[`OPEN_IN_ENV`]）から起こし口を作る。
pub fn launcher_from_env() -> Arc<dyn OpenLauncher> {
    launcher_from_value(std::env::var(OPEN_IN_ENV).ok().as_deref())
}

// ---------------------------------------------------------------------------
// 帳面

/// VSCode の待ちを抱える帳面。**メモリだけ**に持つ（版の入れ替え・起こし直しで消える）。
///
/// 鍵は正規化したパス（同じ実体の2回押しを見分ける）、見せるのは送られてきたパス（画面が文字の
/// まま突き合わせるため）。
#[derive(Debug)]
pub struct OpenedBook {
    inner: Mutex<HashMap<PathBuf, Held>>,
    cap: usize,
    next_token: AtomicU64,
}

#[derive(Debug)]
struct Held {
    shown: PathBuf,
    kind: TargetKind,
    since: SystemTime,
    started: Instant,
    /// どの回の待ちかを見分ける札。古い回の待ちが、後から入れ直した新しい回を消さないため
    token: u64,
    /// 起こし終わったか。起こしている間は予約として場所だけ取り、一覧には出さない
    ready: bool,
}

impl OpenedBook {
    pub fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
            cap,
            next_token: AtomicU64::new(1),
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<PathBuf, Held>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// VSCode で開いているもの。古い順。
    pub fn list(&self) -> Vec<OpenedEntry> {
        let inner = self.lock();
        let mut held: Vec<&Held> = inner.values().filter(|held| held.ready).collect();
        held.sort_by_key(|held| (held.since, held.token));
        held.iter()
            .map(|held| OpenedEntry {
                path: held.shown.clone(),
                kind: held.kind,
                since: held.since,
            })
            .collect()
    }

    /// VSCode で開き、閉じるまで抱える。
    ///
    /// **錠を握ったまま起こし口を呼ばない。** 本物は `wslpath` で最長5秒止まるので、握ったままだと
    /// 一覧（GET）まで止まる。代わりに札つきの予約で場所を取ってから起こす。
    pub fn open_vscode(
        self: &Arc<Self>,
        launcher: &dyn OpenLauncher,
        target: Target,
    ) -> Result<VscodeOutcome, OpenError> {
        in_runtime()?;
        let key = std::fs::canonicalize(&target.path).unwrap_or_else(|_| target.path.clone());

        let reserved = {
            let mut inner = self.lock();
            if inner.contains_key(&key) {
                None
            } else if inner.len() >= self.cap {
                return Err(OpenError::Full { cap: self.cap });
            } else {
                let token = self.next_token.fetch_add(1, Ordering::Relaxed);
                inner.insert(
                    key.clone(),
                    Held {
                        shown: target.path.clone(),
                        kind: target.kind,
                        since: SystemTime::now(),
                        started: Instant::now(),
                        token,
                        ready: false,
                    },
                );
                Some(token)
            }
        };

        let Some(token) = reserved else {
            // **待ちを増やさない。** 同じものの2回目も待たせると印が二重になる（設計 §10 の M1）
            if let Some(waiter) = launcher.vscode(&target, false)? {
                tokio::spawn(waiter);
            }
            return Ok(VscodeOutcome::Fronted);
        };

        match launcher.vscode(&target, true) {
            Err(err) => {
                self.forget(&key, token);
                Err(err)
            }
            Ok(None) => {
                self.forget(&key, token);
                Ok(VscodeOutcome::Opened)
            }
            Ok(Some(waiter)) => {
                if let Some(held) = self.lock().get_mut(&key) {
                    if held.token == token {
                        held.ready = true;
                    }
                }
                // **入れ終わってから待ちを走らせる。** 先に走らせると、すぐ終わった待ちが
                // 入る前の帳面を消しに行き、印だけが残る
                let book = Arc::clone(self);
                tokio::spawn(async move {
                    waiter.await;
                    book.finish(&key, token);
                });
                Ok(VscodeOutcome::Opened)
            }
        }
    }

    /// 札が一致する予約を黙って消す（起こせなかった回に印を残さない）。
    fn forget(&self, key: &Path, token: u64) {
        let mut inner = self.lock();
        if inner.get(key).is_some_and(|held| held.token == token) {
            inner.remove(key);
        }
    }

    /// 待ちが終わった。札が一致するときだけ消して1行残す。
    fn finish(&self, key: &Path, token: u64) {
        let removed = {
            let mut inner = self.lock();
            if inner.get(key).is_some_and(|held| held.token == token) {
                inner.remove(key)
            } else {
                None
            }
        };
        if let Some(held) = removed {
            tracing::info!(
                kind = "open_in_closed",
                target_kind = held.kind.label(),
                held_secs = held.started.elapsed().as_secs(),
                path = %held.shown.display(),
                "VSCode の窓が閉じられたので、開いている印を外しました"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::capture;
    use std::sync::atomic::AtomicBool;

    /// 使い終わったら消える一時フォルダ（`tempfile` を足さない。`compact.rs` と同じ作り）。
    struct 捨てるフォルダ(PathBuf);

    impl 捨てるフォルダ {
        fn 作る() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentdashboard-open-in-{}-{}",
                std::process::id(),
                protocol::CardId::new()
            ));
            std::fs::create_dir_all(&dir).expect("一時フォルダ");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for 捨てるフォルダ {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 呼ばれた引数を控え、待ちは合図を送るまで終わらない偽の起こし口。
    #[derive(Debug, Default)]
    struct 偽の起こし口 {
        呼ばれた: Mutex<Vec<(App, PathBuf, bool)>>,
        待ちの合図: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
        失敗させる: AtomicBool,
    }

    impl 偽の起こし口 {
        fn 呼ばれた(&self) -> Vec<(App, PathBuf, bool)> {
            self.呼ばれた.lock().unwrap().clone()
        }

        fn 待ちを終わらせる(&self) {
            for tx in self.待ちの合図.lock().unwrap().drain(..) {
                let _ = tx.send(());
            }
        }
    }

    impl OpenLauncher for 偽の起こし口 {
        fn tools(&self) -> Tools {
            Tools::both(ToolState::ok())
        }

        fn explorer(&self, target: &Target) -> Result<(), OpenError> {
            self.呼ばれた
                .lock()
                .unwrap()
                .push((App::Explorer, target.path.clone(), false));
            Ok(())
        }

        fn vscode(&self, target: &Target, wait: bool) -> Result<Option<Waiter>, OpenError> {
            self.呼ばれた
                .lock()
                .unwrap()
                .push((App::Vscode, target.path.clone(), wait));
            if self.失敗させる.load(Ordering::Relaxed) {
                return Err(OpenError::Spawn("偽の失敗".to_string()));
            }
            if !wait {
                return Ok(None);
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.待ちの合図.lock().unwrap().push(tx);
            Ok(Some(Box::pin(async move {
                let _ = rx.await;
            })))
        }
    }

    fn フォルダ(path: impl Into<PathBuf>) -> Target {
        let path = path.into();
        let class = classify(&path);
        Target {
            path,
            kind: TargetKind::Dir,
            class,
        }
    }

    async fn 空になるまで待つ(book: &OpenedBook) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !book.list().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("待ちが終わったら帳面から消えること");
    }

    // ---- classify

    #[test]
    fn ドライブ文字のパスはwindowsのドライブと分かる() {
        assert_eq!(
            classify(Path::new("/mnt/c/x")),
            PathClass::WindowsDrive { letter: 'c' }
        );
        assert_eq!(
            classify(Path::new("/mnt/C")),
            PathClass::WindowsDrive { letter: 'c' }
        );
        assert_eq!(
            classify(Path::new("/mnt/d")),
            PathClass::WindowsDrive { letter: 'd' }
        );
    }

    #[test]
    fn ドライブ文字でないmntの下はwslのまま() {
        for path in [
            "/mnt/wsl/x",
            "/mnt/wslg",
            "/home/u",
            "/mnt",
            "/mnt/cc",
            "mnt/c/x",
        ] {
            assert_eq!(classify(Path::new(path)), PathClass::Wsl, "{path}");
        }
    }

    // ---- explorer_args

    #[test]
    fn フォルダはパス1つだけを渡す() {
        assert_eq!(
            explorer_args(TargetKind::Dir, r"C:\a b"),
            vec![r"C:\a b".to_string()]
        );
    }

    #[test]
    fn ファイルは_select_とパスを別の引数で渡す() {
        for win in [
            r"C:\a b\日本語 ファイル.txt",
            r"\\wsl.localhost\Ubuntu-24.04\home\u\空白 と.txt",
        ] {
            let args = explorer_args(TargetKind::File, win);
            assert_eq!(
                args,
                vec!["/select,".to_string(), win.to_string()],
                "`/select,` とパスが別々の2つの引数になっていない"
            );
        }
    }

    // ---- child_env

    fn 親の環境() -> Vec<(String, String)> {
        [
            ("AGENTDASHBOARD_X", "1"),
            ("AGENTDASHBOARD_OPEN_IN", "off"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CONFIG_DIR", "/x"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("VSCODE_IPC_HOOK", "/tmp/h"),
            ("ELECTRON_RUN_AS_NODE", "0"),
            ("WSL_DISTRO_NAME", "Other"),
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin"),
            ("LC_ALL", "C.UTF-8"),
            ("WSLENV", "FOO/u"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn 値(env: &[(String, String)], name: &str) -> Option<String> {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn 許す一覧の変数だけが残る() {
        let env = child_env(親の環境(), "Ubuntu-24.04", PathClass::Wsl);
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec!["HOME", "LC_ALL", "PATH", "WSLENV", "WSL_DISTRO_NAME"]
        );
    }

    #[test]
    fn ダッシュボードとclaudeとvscodeの変数は渡らない() {
        for class in [PathClass::Wsl, PathClass::WindowsDrive { letter: 'c' }] {
            let env = child_env(親の環境(), "Ubuntu-24.04", class);
            for name in [
                "AGENTDASHBOARD_X",
                "AGENTDASHBOARD_OPEN_IN",
                "CLAUDECODE",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
                "VSCODE_IPC_HOOK",
            ] {
                assert!(
                    !env.iter().any(|(k, _)| k == name),
                    "{name} が入っている（{class:?}）"
                );
            }
        }
    }

    #[test]
    fn ディストロ名は親に無くても入る() {
        let env = child_env(Vec::new(), "Ubuntu-24.04", PathClass::Wsl);
        assert_eq!(値(&env, "WSL_DISTRO_NAME").as_deref(), Some("Ubuntu-24.04"));
        let env = child_env(親の環境(), "Ubuntu-24.04", PathClass::Wsl);
        assert_eq!(
            値(&env, "WSL_DISTRO_NAME").as_deref(),
            Some("Ubuntu-24.04"),
            "親の Other ではない"
        );
        let env = child_env(Vec::new(), "", PathClass::Wsl);
        assert_eq!(
            値(&env, "WSL_DISTRO_NAME"),
            None,
            "空のディストロ名は足さない"
        );
    }

    #[test]
    fn ドライブのときだけelectron_run_as_nodeとwslenvの先頭が入る() {
        let env = child_env(親の環境(), "Ubuntu-24.04", PathClass::Wsl);
        assert_eq!(値(&env, "ELECTRON_RUN_AS_NODE"), None);
        assert_eq!(値(&env, "WSLENV").as_deref(), Some("FOO/u"));

        let env = child_env(
            親の環境(),
            "Ubuntu-24.04",
            PathClass::WindowsDrive { letter: 'c' },
        );
        assert_eq!(値(&env, "ELECTRON_RUN_AS_NODE").as_deref(), Some("1"));
        assert_eq!(
            値(&env, "WSLENV").as_deref(),
            Some("ELECTRON_RUN_AS_NODE/w:FOO/u")
        );

        let env = child_env(
            Vec::new(),
            "Ubuntu-24.04",
            PathClass::WindowsDrive { letter: 'c' },
        );
        assert_eq!(
            値(&env, "WSLENV").as_deref(),
            Some("ELECTRON_RUN_AS_NODE/w")
        );

        let names: Vec<String> = env.iter().map(|(k, _)| k.clone()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "名前の順に並ぶ");
    }

    #[test]
    fn pathが無ければ既定の道を足す() {
        let env = child_env(Vec::new(), "Ubuntu-24.04", PathClass::Wsl);
        assert_eq!(値(&env, "PATH").as_deref(), Some(DEFAULT_PATH));
        let env = child_env(親の環境(), "Ubuntu-24.04", PathClass::Wsl);
        assert_eq!(値(&env, "PATH").as_deref(), Some("/usr/bin"));
    }

    // ---- script

    /// 実物の `code` script の冒頭の写し（個人のパスは含まない）。
    const SCRIPT_HEAD: &str = r#"#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
if [ "$VSCODE_WSL_DEBUG_INFO" = true ]; then
	set -x
fi

COMMIT="8a14f0cc1b08d531eb83255ea3764ae22aa932b5"
APP_NAME="code"
QUALITY="stable"
NAME="Code"
SERVERDATAFOLDER=".vscode-server"
VERSIONFOLDER="8a14f0cc1b"
VSCODE_PATH="$(dirname "$(dirname "$(realpath "$0")")")"
ELECTRON="$VSCODE_PATH/$NAME.exe"
"#;

    #[test]
    fn scriptの写しから版のフォルダを読む() {
        assert_eq!(version_folder(SCRIPT_HEAD).as_deref(), Some("8a14f0cc1b"));
        assert_eq!(script_value(SCRIPT_HEAD, "NAME").as_deref(), Some("Code"));
        assert!(looks_like_vscode_script(SCRIPT_HEAD));
        assert!(!looks_like_vscode_script("#!/bin/sh\necho hi\n"));
    }

    #[test]
    fn 版のフォルダの行が無ければ読めない() {
        assert_eq!(version_folder("#!/bin/sh\necho hi\n"), None);
        assert_eq!(version_folder("VERSIONFOLDER=\"\"\n"), None);
    }

    #[test]
    fn uncの形からディストロ名を読む() {
        assert_eq!(
            distro_from_unc("\\\\wsl.localhost\\Ubuntu-24.04\\").as_deref(),
            Some("Ubuntu-24.04")
        );
        assert_eq!(
            distro_from_unc("\\\\wsl.localhost\\Ubuntu-24.04\\\n").as_deref(),
            Some("Ubuntu-24.04")
        );
        assert_eq!(
            distro_from_unc("\\\\wsl$\\Ubuntu\\").as_deref(),
            Some("Ubuntu")
        );
        assert_eq!(
            distro_from_unc("\\\\WSL.LOCALHOST\\Debian\\").as_deref(),
            Some("Debian")
        );
        assert_eq!(distro_from_unc("C:\\Windows"), None);
        assert_eq!(distro_from_unc("\\\\wsl.localhost\\"), None);
        assert_eq!(distro_from_unc(""), None);
    }

    #[test]
    fn codeを探す順はpathから既定の入れ場所へ() {
        let found = code_candidates(Some("/a:/b::/c"), &["u1".to_string()]);
        assert_eq!(
            found,
            vec![
                PathBuf::from("/a/code"),
                PathBuf::from("/b/code"),
                PathBuf::from("/c/code"),
                PathBuf::from("/mnt/c/Users/u1/AppData/Local/Programs/Microsoft VS Code/bin/code"),
                PathBuf::from("/mnt/c/Program Files/Microsoft VS Code/bin/code"),
            ]
        );
    }

    #[test]
    fn vscodeの引数はwaitの有無で変わる() {
        assert_eq!(
            vscode_args_wsl(Path::new("/home/u/p"), true),
            vec![OsString::from("--wait"), OsString::from("/home/u/p")]
        );
        assert_eq!(
            vscode_args_wsl(Path::new("/home/u/p"), false),
            vec![OsString::from("/home/u/p")]
        );
        assert_eq!(
            vscode_args_drive("C:/v/cli.js", r"C:\p", true),
            vec![
                "C:/v/cli.js".to_string(),
                "--wait".to_string(),
                r"C:\p".to_string()
            ]
        );
    }

    // ---- tools_from

    fn wsl() -> WslSense {
        WslSense {
            osrelease: "6.6.87.2-microsoft-standard-WSL2".to_string(),
            run_wsl_exists: true,
        }
    }

    #[test]
    fn wslでない機械では2つとも使えない() {
        let tools = tools_from(&WslSense::default(), true, true, Some(Path::new("/x/code")));
        assert_eq!(tools.explorer, ToolState::unavailable(NOT_WSL_REASON));
        assert_eq!(tools.vscode, ToolState::unavailable(NOT_WSL_REASON));
    }

    #[test]
    fn 道具が無ければ理由を添えて使えない() {
        let tools = tools_from(&wsl(), true, true, Some(Path::new("/x/code")));
        assert_eq!(tools, Tools::both(ToolState::ok()));

        let tools = tools_from(&wsl(), false, true, Some(Path::new("/x/code")));
        assert_eq!(tools.explorer, ToolState::unavailable(NO_EXPLORER_REASON));
        assert_eq!(tools.vscode, ToolState::ok());

        let tools = tools_from(&wsl(), true, true, None);
        assert_eq!(tools.explorer, ToolState::ok());
        assert_eq!(tools.vscode, ToolState::unavailable(NO_VSCODE_REASON));
    }

    // ---- 選び方

    #[test]
    fn 起こし口の選び方の表() {
        assert_eq!(choose_launcher(None), LauncherChoice::Real);
        assert_eq!(choose_launcher(Some("")), LauncherChoice::Real);
        assert_eq!(choose_launcher(Some("real")), LauncherChoice::Real);
        assert_eq!(choose_launcher(Some("off")), LauncherChoice::Blocked);
        assert_eq!(
            choose_launcher(Some("record:.e2e-state/open-in")),
            LauncherChoice::Record(PathBuf::from(".e2e-state/open-in"))
        );
        for value in ["of", "REAL", "Off", "record", "record:", " off", "off "] {
            assert_eq!(
                choose_launcher(Some(value)),
                LauncherChoice::Invalid(value.to_string()),
                "{value:?}"
            );
        }
    }

    #[test]
    fn 分からない値は塞ぐ側へ倒れる() {
        let sink = capture::sink();
        let mark = sink.mark();
        for value in ["of", "REAL", "record"] {
            let launcher = launcher_from_value(Some(value));
            assert!(
                format!("{launcher:?}").starts_with("BlockedLauncher"),
                "分からない値 {value:?} は塞ぐ側へ倒れること（{launcher:?} だった）"
            );
            let lines: Vec<_> = sink
                .matching(mark, "kind", "open_in_env")
                .into_iter()
                .filter(|line| line["value"] == value)
                .collect();
            assert_eq!(lines.len(), 1, "{value:?} の行が1つ出ること：{lines:#?}");
        }
    }

    #[test]
    fn 記録のフォルダを作れなければ塞ぐ側へ倒れる() {
        let dir = 捨てるフォルダ::作る();
        let file = dir.path().join("ファイル");
        std::fs::write(&file, "x").unwrap();
        let value = format!("record:{}", file.join("下").display());

        let sink = capture::sink();
        let mark = sink.mark();
        let launcher = launcher_from_value(Some(&value));
        assert!(
            format!("{launcher:?}").starts_with("BlockedLauncher"),
            "{launcher:?}"
        );
        let lines: Vec<_> = sink
            .matching(mark, "kind", "open_in_env")
            .into_iter()
            .filter(|line| line["value"] == value.as_str())
            .collect();
        assert_eq!(lines.len(), 1, "{lines:#?}");
    }

    #[test]
    fn 塞いだ起こし口は道具を使えないと答え理由に綴りを含む() {
        assert!(BLOCKED_REASON.contains(OPEN_IN_ENV));
        let blocked = BlockedLauncher;
        assert_eq!(
            blocked.tools(),
            Tools::both(ToolState::unavailable(BLOCKED_REASON))
        );
        let target = フォルダ("/home/u/p");
        assert_eq!(
            blocked.explorer(&target),
            Err(OpenError::Unavailable(BLOCKED_REASON.to_string()))
        );
        assert!(matches!(
            blocked.vscode(&target, true),
            Err(OpenError::Unavailable(_))
        ));
    }

    #[test]
    fn 外の道具を起こす口の環境変数の綴りが土台と一致している() {
        assert_eq!(
            OPEN_IN_ENV,
            testkit::OPEN_IN_ENV,
            "食い違うと、テストが起こした実行ファイルが押されたら窓を出す"
        );
    }

    // ---- RecordLauncher

    #[tokio::test]
    async fn 記録の起こし口は押すたびに1行書く() {
        let dir = 捨てるフォルダ::作る();
        let launcher = RecordLauncher::new(dir.path().join("rec")).unwrap();
        launcher.explorer(&フォルダ("/home/u/p")).unwrap();
        let file = Target {
            path: PathBuf::from("/home/u/p/a b.txt"),
            kind: TargetKind::File,
            class: PathClass::Wsl,
        };
        assert!(launcher.vscode(&file, true).unwrap().is_some());

        let text = std::fs::read_to_string(dir.path().join("rec/requests.jsonl")).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![
                serde_json::json!({"id": 1, "app": "explorer", "kind": "dir", "path": "/home/u/p", "wait": false}),
                serde_json::json!({"id": 2, "app": "vscode", "kind": "file", "path": "/home/u/p/a b.txt", "wait": true}),
            ]
        );
    }

    #[tokio::test]
    async fn close_idを置くと待ちが終わる() {
        let dir = 捨てるフォルダ::作る();
        let launcher = RecordLauncher::new(dir.path().to_path_buf()).unwrap();
        launcher.explorer(&フォルダ("/home/u/p")).unwrap();
        let mut waiter = launcher
            .vscode(&フォルダ("/home/u/q"), true)
            .unwrap()
            .unwrap();

        let early = tokio::time::timeout(Duration::from_millis(500), &mut waiter).await;
        assert!(early.is_err(), "close-2 を置く前は終わらない");

        std::fs::write(dir.path().join("close-2"), "").unwrap();
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("close-2 を置くと待ちが終わる");
        assert!(
            dir.path().join("close-2").exists(),
            "close は消さない（置いた側が片付ける）"
        );
    }

    // ---- OpenedBook

    #[tokio::test]
    async fn 開くと一覧に出て待ちが終わると消える() {
        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        let outcome = book.open_vscode(&launcher, フォルダ("/home/u/p")).unwrap();
        assert_eq!(outcome, VscodeOutcome::Opened);
        let list = book.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, PathBuf::from("/home/u/p"));
        assert_eq!(list[0].kind, TargetKind::Dir);
        assert_eq!(
            launcher.呼ばれた(),
            vec![(App::Vscode, PathBuf::from("/home/u/p"), true)]
        );

        launcher.待ちを終わらせる();
        空になるまで待つ(&book).await;
    }

    #[tokio::test]
    async fn 同じものの2回目は前に出すだけで待ちを増やさない() {
        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        book.open_vscode(&launcher, フォルダ("/home/u/p")).unwrap();
        let outcome = book.open_vscode(&launcher, フォルダ("/home/u/p")).unwrap();
        assert_eq!(outcome, VscodeOutcome::Fronted);
        assert_eq!(
            launcher.呼ばれた(),
            vec![
                (App::Vscode, PathBuf::from("/home/u/p"), true),
                (App::Vscode, PathBuf::from("/home/u/p"), false),
            ]
        );
        assert_eq!(
            launcher.待ちの合図.lock().unwrap().len(),
            1,
            "待ちは1つだけ"
        );
        assert_eq!(book.list().len(), 1);
    }

    #[tokio::test]
    async fn 上限に達したらそれ以上抱えない() {
        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        for i in 0..OPENED_CAP {
            book.open_vscode(&launcher, フォルダ(format!("/home/u/p{i}")))
                .unwrap();
        }
        let err = book
            .open_vscode(&launcher, フォルダ("/home/u/over"))
            .unwrap_err();
        assert_eq!(err, OpenError::Full { cap: 8 });
        assert_eq!(book.list().len(), 8);
    }

    #[tokio::test]
    async fn 起こせなかったら帳面に残らない() {
        let launcher = 偽の起こし口::default();
        launcher.失敗させる.store(true, Ordering::Relaxed);
        let book = OpenedBook::new(OPENED_CAP);
        let err = book
            .open_vscode(&launcher, フォルダ("/home/u/p"))
            .unwrap_err();
        assert_eq!(err, OpenError::Spawn("偽の失敗".to_string()));
        assert!(book.list().is_empty());
        assert!(book.lock().is_empty(), "予約も残らない");

        launcher.失敗させる.store(false, Ordering::Relaxed);
        assert_eq!(
            book.open_vscode(&launcher, フォルダ("/home/u/p")).unwrap(),
            VscodeOutcome::Opened,
            "やり直せば新しく開ける"
        );
    }

    #[tokio::test]
    async fn 一覧は古い順() {
        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        for name in ["/home/u/b", "/home/u/a", "/home/u/c"] {
            book.open_vscode(&launcher, フォルダ(name)).unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let paths: Vec<PathBuf> = book.list().into_iter().map(|entry| entry.path).collect();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/home/u/b"),
                PathBuf::from("/home/u/a"),
                PathBuf::from("/home/u/c")
            ]
        );
    }

    #[tokio::test]
    async fn symlinkを通るパスは送ったまま見せ同じ実体の2回目は前に出すだけ() {
        let dir = 捨てるフォルダ::作る();
        let real = dir.path().join("実体");
        let link = dir.path().join("近道");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        assert_eq!(
            book.open_vscode(&launcher, フォルダ(&link)).unwrap(),
            VscodeOutcome::Opened
        );
        assert_eq!(
            book.list()[0].path,
            link,
            "送ったパス（symlink 側）の文字のまま見せる"
        );
        assert_eq!(
            book.open_vscode(&launcher, フォルダ(&real)).unwrap(),
            VscodeOutcome::Fronted
        );
        assert_eq!(book.list().len(), 1);
    }

    #[tokio::test]
    async fn 待ちが終わるとopen_in_closedが出る() {
        let sink = capture::sink();
        let mark = sink.mark();
        let launcher = 偽の起こし口::default();
        let book = OpenedBook::new(OPENED_CAP);
        let path = format!("/home/u/closed-{}", protocol::CardId::new());
        book.open_vscode(&launcher, フォルダ(&path)).unwrap();
        launcher.待ちを終わらせる();
        空になるまで待つ(&book).await;

        let lines: Vec<_> = sink
            .matching(mark, "kind", "open_in_closed")
            .into_iter()
            .filter(|line| line["path"] == path.as_str())
            .collect();
        assert_eq!(lines.len(), 1, "{lines:#?}");
        assert_eq!(lines[0]["target_kind"], "dir");
        assert!(lines[0]["held_secs"].is_u64());
    }

    #[tokio::test]
    async fn 古い回の待ちは入れ直した新しい回を消さない() {
        let book = OpenedBook::new(OPENED_CAP);
        let key = PathBuf::from("/home/u/p");
        book.lock().insert(
            key.clone(),
            Held {
                shown: key.clone(),
                kind: TargetKind::Dir,
                since: SystemTime::now(),
                started: Instant::now(),
                token: 99,
                ready: true,
            },
        );
        book.finish(&key, 1);
        assert_eq!(book.list().len(), 1, "札の違う古い回は消さない");
        book.finish(&key, 99);
        assert!(book.list().is_empty());
    }
}
