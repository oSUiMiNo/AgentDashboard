//! 版を外から取ってくる窓口（設計§7・§8）。
//!
//! **ここに入るのは「取ってくる」操作だけ。** 行き先に聞くのは門（`core/src/gate.rs`）の
//! 仕事で、あちらが起こすのは自分たちが保管庫へ置いたものだけ——外の世界ではない。
//! こちらへ畳むと「**本物の旧版に聞いて『確かめられません』を返す**」検査が窓口の
//! 差し替えで通せるようになり、名ばかりになる。
//!
//! # なぜ `curl` を呼ぶのか
//! HTTP クライアントのクレートを足さない。理由は配布物の大きさではない（rustls も hyper も
//! 既に入っている）。
//!
//! 1. **取ってくる工程はどのみち `curl` を要求する。** 配布インストーラ自身が `curl` か
//!    `wget` を使う作りなので、献立表だけ別の道を持っても満たせる環境は1つも増えない
//! 2. **リダイレクトが2段あり、2段目でホストが変わる**（`github.com` → 署名付きの配信元）。
//!    自前で書くと追従・相対 `Location`・新しいホストでの TLS の握り直しを全部持つことになる
//! 3. **プロキシ**。`curl` は `http_proxy` / `https_proxy` / `no_proxy` を見る。自前実装は
//!    見ない。設計§8 が「NAT の内側に置いたセルフホスト」を名指しで気にしている以上、
//!    企業の前段は想定内である
//!
//! `wget` の代替は作らない。引数の組み立ての門（`--insecure` の類を混ぜない）が2系統に
//! なる費用に見合わないため。`curl` が無ければ [`Unavailable`] へ落ちる。

use crate::proc::{Outcome, run};
use protocol::VersionId;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

/// リリースの置き場所。
pub const RELEASE_BASE_URL: &str = "https://github.com/oSUiMiNo/AgentDashboard/releases";

/// 取りに行く先を差し替える環境変数。
///
/// **テストが本物のインストーラを手元の置き場所へ向けるための口。** 差し替え口が無いと、
/// 取ってくる工程を確かめるたびにネットワークが要る（[`crate::version::VERSION_SOURCE_ENV`]
/// と同じ作法）。
pub const RELEASE_BASE_ENV: &str = "AGENTDASHBOARD_VERSION_RELEASE_BASE";

/// 献立表を取ってくるまでの上限。実測 0.6 秒なので、遅い回線でも余る。
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 取ってきて展開し終えるまでの上限。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// `curl` 自身に持たせる上限（担ぎ手の打ち切りとは**二重にする**——片方だけだと
/// `curl` が固まったときに担ぎ手が返らない）。
const CURL_MAX_TIME_SECS: u64 = 20;
const CURL_CONNECT_TIMEOUT_SECS: u64 = 10;

/// 献立表から読み取れる「最新版」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Latest {
    pub version: VersionId,
    /// 試作版か。**いまはほぼ常に偽**——`releases/latest` は非試作版を指すため。
    /// 将来 `force_latest` などで効き始めたときのために読んでおく。
    pub prerelease: bool,
    /// 自分の機械向けの箱が実在するか。**無い版は勧めない。**
    pub has_artifact: bool,
}

/// 外の世界へ出る操作。テストから差し替える（`SelfhealOps` と同型）。
pub trait VersionOps: Send + Sync {
    /// 取ってくる道具が無い理由。あるなら `None`。
    ///
    /// **黙って何もしないと原因を辿れない**ので、理由は画面まで出せる形で返す。
    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    /// 献立表を取ってくる（生のまま）。読み解きは [`parse_latest`]（純粋関数）。
    fn fetch_manifest(&self) -> anyhow::Result<String>;

    /// その版のインストーラを取ってきて `staging` へ展開する。
    ///
    /// **後条件（3本だけ揃ったか・版が一致するか）はここでは見ない。**
    /// 見るのは [`crate::version::install_version`]——窓口を差し替えても検査が残るようにする。
    fn install(&self, version: &VersionId, staging: &Path) -> Outcome;
}

/// 取ってくる道具が無い環境の窓口。**必ず失敗を返す。**
///
/// 「取ってこられない環境で取ってこられたことにする」と、確かめずに採用してしまう
/// （`SelfhealOps::run_web_gate` の既定が `passed: false` なのと同じ理屈）。
pub struct Unavailable {
    reason: String,
}

impl Unavailable {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl VersionOps for Unavailable {
    fn unavailable_reason(&self) -> Option<String> {
        Some(self.reason.clone())
    }

    fn fetch_manifest(&self) -> anyhow::Result<String> {
        anyhow::bail!("{}", self.reason)
    }

    fn install(&self, _version: &VersionId, _staging: &Path) -> Outcome {
        Outcome::failed(self.reason.clone())
    }
}

/// 本物の窓口。
pub struct HostOps {
    base: String,
}

impl HostOps {
    pub fn new(base: String) -> Self {
        Self { base }
    }
}

/// この機械で使える窓口を選ぶ。
pub fn detect() -> Arc<dyn VersionOps> {
    if !curl_present() {
        return Arc::new(Unavailable::new(
            "curl が見つかりません。版を取ってくるには curl が要ります",
        ));
    }
    Arc::new(HostOps::new(release_base()))
}

fn release_base() -> String {
    std::env::var(RELEASE_BASE_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RELEASE_BASE_URL.to_string())
}

fn curl_present() -> bool {
    run(
        Command::new("curl").arg("--version"),
        Duration::from_secs(10),
    )
    .success
}

/// 献立表の在り処。
pub fn manifest_url(base: &str) -> String {
    format!("{base}/latest/download/dist-manifest.json")
}

/// その版のインストーラの在り処。**版に `v` を付けるのはここだけ**（タグの綴り）。
pub fn installer_url(base: &str, version: &VersionId) -> String {
    format!("{base}/download/v{version}/agentdashboard-installer.sh")
}

/// `curl` へ渡す引数。
///
/// **`--insecure` の類を混ぜないことを門で見張る**（`curl_args` を純粋関数にしてあるのは
/// そのため）。`--proto-redir '=https'` を付けているのは、**リダイレクト先が平文へ
/// 落ちるのを塞ぐ**ため——配布インストーラ自身は `-sSfL` だけなので、こちらのほうが
/// 1段厳しい。
pub fn curl_args(url: &str, out: &Path) -> Vec<String> {
    vec![
        "--silent".to_string(),
        "--show-error".to_string(),
        "--fail".to_string(),
        "--location".to_string(),
        "--proto".to_string(),
        "=https,file".to_string(),
        "--proto-redir".to_string(),
        "=https".to_string(),
        "--connect-timeout".to_string(),
        CURL_CONNECT_TIMEOUT_SECS.to_string(),
        "--max-time".to_string(),
        CURL_MAX_TIME_SECS.to_string(),
        "--output".to_string(),
        out.display().to_string(),
        url.to_string(),
    ]
}

/// インストーラの子プロセスへ渡す環境。**親のものを引き継がない。**
///
/// 引き継ぐと、開発者の環境に残った `AGENTDASHBOARD_INSTALL_DIR` 1つで、
/// **利用者の rcfile 6本と控え（receipt）が書き換わる**——配布インストーラは
/// あちらを `AGENTDASHBOARD_UNMANAGED_INSTALL` より先に見るため。設計§7 が
/// 名指しで避けた穴が、環境の継承だけで開く。
///
/// 渡すのは4つだけ。`PATH` はインストーラの道具探し（`uname` / `tar` ほか）に、
/// `HOME` は置き場所の解決に要る。
pub fn installer_env(
    staging: &Path,
    download_url: &str,
    path: &str,
    home: &str,
) -> Vec<(String, String)> {
    vec![
        ("PATH".to_string(), path.to_string()),
        ("HOME".to_string(), home.to_string()),
        (
            "AGENTDASHBOARD_UNMANAGED_INSTALL".to_string(),
            staging.display().to_string(),
        ),
        (
            "AGENTDASHBOARD_DOWNLOAD_URL".to_string(),
            download_url.to_string(),
        ),
    ]
}

/// 取ってきた箱の在り処（インストーラへ教える）。
fn download_url(base: &str, version: &VersionId) -> String {
    format!("{base}/download/v{version}")
}

impl VersionOps for HostOps {
    fn fetch_manifest(&self) -> anyhow::Result<String> {
        let out = std::env::temp_dir().join(format!(
            "agentdashboard-manifest-{}.json",
            std::process::id()
        ));
        let outcome = run(
            Command::new("curl").args(curl_args(&manifest_url(&self.base), &out)),
            MANIFEST_TIMEOUT,
        );
        let result = outcome.into_result("献立表の取得").and_then(|_| {
            // curl は失敗しても空のファイルを作る。**中身が読めることまで確かめる**
            std::fs::read_to_string(&out).map_err(|error| anyhow::anyhow!("献立表を開けません: {error}"))
        });
        let _ = std::fs::remove_file(&out);
        result
    }

    fn install(&self, version: &VersionId, staging: &Path) -> Outcome {
        if let Err(error) = std::fs::create_dir_all(staging) {
            return Outcome::failed(format!("置き場所を作れません: {error}"));
        }

        // **ファイルへ落としてから走らせる。** パイプで流し込むと、何を走らせたのかを
        // 後から確かめられないし、失敗の理由も残らない
        let script = installer_path(staging);
        let fetch = run(
            Command::new("curl").args(curl_args(&installer_url(&self.base, version), &script)),
            MANIFEST_TIMEOUT,
        );
        if !fetch.success {
            let _ = std::fs::remove_file(&script);
            return Outcome::failed(format!("インストーラを取ってこられません: {}", fetch.output));
        }

        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
        let home = std::env::var("HOME").unwrap_or_else(|_| staging.display().to_string());
        let mut command = Command::new("sh");
        command.arg(&script);
        command.env_clear();
        command.envs(installer_env(
            staging,
            &download_url(&self.base, version),
            &path,
            &home,
        ));
        let outcome = run(&mut command, INSTALL_TIMEOUT);
        let _ = std::fs::remove_file(&script);
        outcome
    }
}

/// インストーラを落とす先。
///
/// `.staging-` で始まる名前にしてあるので、一覧の走査は拾わない——あちらは
/// **フォルダであること**と**接頭辞**の両方で絞っているので二重に外れる。
fn installer_path(staging: &Path) -> PathBuf {
    let name = staging
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(".staging");
    staging.with_file_name(format!("{name}.installer.sh"))
}

/// 献立表の版は `v0.1.1` の形。
///
/// **剥がし忘れると `versions/v0.1.1/` ができて、一覧に同じ版が二重に並ぶ。**
/// 剥がすのはここ1箇所に閉じ込め、[`VersionId`] を作る前に通す。
pub fn strip_v(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// 献立表を読み解く（純粋関数）。
///
/// `triple` は自分の機械の綴り。分からなければ `None` を渡す——そのときは
/// 「箱があるか」を判定できないので偽にする（**勧められないほうへ倒す**）。
pub fn parse_latest(json: &str, triple: Option<&str>) -> Result<Latest, String> {
    let doc: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("献立表を読めません: {error}"))?;

    let tag = doc
        .get("announcement_tag")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "献立表に版がありません".to_string())?;
    let version = VersionId::new(strip_v(tag));
    if version.as_str().is_empty() {
        return Err("献立表の版が空です".to_string());
    }

    let prerelease = doc
        .get("announcement_is_prerelease")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let has_artifact = triple.is_some_and(|triple| has_box(&doc, triple));

    Ok(Latest {
        version,
        prerelease,
        has_artifact,
    })
}

/// その綴り向けの箱が献立表に載っているか。
///
/// **`kind` が `executable-zip` のものだけを見る。** インストーラの行は
/// 「作っていない綴り」まで挙げている（実測：`x86_64-pc-windows-gnu` の箱は無いのに
/// インストーラの行には載っている）ので、そちらを読むと**在ると誤判定する**。
fn has_box(doc: &serde_json::Value, triple: &str) -> bool {
    let Some(artifacts) = doc.get("artifacts").and_then(|value| value.as_object()) else {
        return false;
    };
    artifacts.values().any(|artifact| {
        artifact.get("kind").and_then(|kind| kind.as_str()) == Some("executable-zip")
            && artifact
                .get("target_triples")
                .and_then(|list| list.as_array())
                .is_some_and(|list| list.iter().any(|item| item.as_str() == Some(triple)))
    })
}

/// ビルド時に決まる ABI。`std::env::consts` に対応するものが無いので手で拾う。
/// **`cfg!` を読むのはここだけ**（材料と判定を割る、設計§21-3）。
const TARGET_ENV: &str = if cfg!(target_env = "musl") {
    "musl"
} else if cfg!(target_env = "msvc") {
    "msvc"
} else if cfg!(target_env = "gnu") {
    "gnu"
} else {
    ""
};

/// いま動いている機械の綴り。
pub fn target_triple() -> Option<String> {
    triple_from(std::env::consts::ARCH, std::env::consts::OS, TARGET_ENV)
}

/// 綴りの組み立て（純粋関数）。読めない組み合わせは `None`——**知らない綴りを
/// でっち上げると「箱が無い」と「綴りが分からない」が混ざる。**
pub fn triple_from(arch: &str, os: &str, env: &str) -> Option<String> {
    match os {
        "linux" if !env.is_empty() => Some(format!("{arch}-unknown-linux-{env}")),
        "macos" => Some(format!("{arch}-apple-darwin")),
        "windows" if !env.is_empty() => Some(format!("{arch}-pc-windows-{env}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
        "announcement_tag": "v0.2.0",
        "announcement_is_prerelease": false,
        "artifacts": {
            "agentdashboard-x86_64-unknown-linux-gnu.tar.xz": {
                "kind": "executable-zip",
                "target_triples": ["x86_64-unknown-linux-gnu"]
            },
            "agentdashboard-installer.sh": {
                "kind": "installer",
                "target_triples": ["x86_64-unknown-linux-gnu", "x86_64-pc-windows-gnu"]
            }
        }
    }"#;

    #[test]
    fn 献立表の版から先頭のvを剥がす() {
        let latest = parse_latest(MANIFEST, Some("x86_64-unknown-linux-gnu")).unwrap();
        assert_eq!(latest.version, VersionId::new("0.2.0"));
    }

    #[test]
    fn 箱があるかは実行ファイルの行だけで決める() {
        // インストーラの行にしかない綴り。**あちらを読むと「箱がある」と誤判定する**
        let latest = parse_latest(MANIFEST, Some("x86_64-pc-windows-gnu")).unwrap();
        assert!(
            !latest.has_artifact,
            "インストーラの行を読んで箱があると誤判定している"
        );

        let latest = parse_latest(MANIFEST, Some("x86_64-unknown-linux-gnu")).unwrap();
        assert!(latest.has_artifact);
    }

    #[test]
    fn 綴りが分からなければ箱は無いことにする() {
        let latest = parse_latest(MANIFEST, None).unwrap();
        assert!(!latest.has_artifact);
    }

    #[test]
    fn 読めない献立表は理由つきで断る() {
        assert!(parse_latest("{", Some("x")).is_err());
        assert!(parse_latest("{}", Some("x")).is_err());
        assert!(parse_latest(r#"{"announcement_tag": "v"}"#, Some("x")).is_err());
    }

    #[test]
    fn 試作版の印を読む() {
        let json = r#"{"announcement_tag":"v9.9.9","announcement_is_prerelease":true}"#;
        assert!(parse_latest(json, None).unwrap().prerelease);
        // 書いていなければ試作版ではない
        let json = r#"{"announcement_tag":"v9.9.9"}"#;
        assert!(!parse_latest(json, None).unwrap().prerelease);
    }

    #[test]
    fn 綴りは組み合わせから決まる() {
        assert_eq!(
            triple_from("x86_64", "linux", "gnu").as_deref(),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            triple_from("aarch64", "macos", "").as_deref(),
            Some("aarch64-apple-darwin")
        );
        assert_eq!(
            triple_from("x86_64", "windows", "msvc").as_deref(),
            Some("x86_64-pc-windows-msvc")
        );
        // 知らない組み合わせをでっち上げない
        assert_eq!(triple_from("x86_64", "freebsd", "gnu"), None);
        assert_eq!(triple_from("x86_64", "linux", ""), None);
    }

    #[test]
    fn 取ってくる先の綴り() {
        let base = "https://example.test/releases";
        assert_eq!(
            manifest_url(base),
            "https://example.test/releases/latest/download/dist-manifest.json"
        );
        assert_eq!(
            installer_url(base, &VersionId::new("0.1.0")),
            "https://example.test/releases/download/v0.1.0/agentdashboard-installer.sh"
        );
        assert_eq!(
            download_url(base, &VersionId::new("0.1.0")),
            "https://example.test/releases/download/v0.1.0"
        );
    }

    #[test]
    fn curlの引数に検証を切る指定を混ぜない() {
        let args = curl_args("https://example.test/x", Path::new("/tmp/x"));
        for forbidden in ["-k", "--insecure", "--no-check-certificate", "--proxy-insecure"] {
            assert!(
                !args.iter().any(|arg| arg == forbidden),
                "TLS の検証を切る指定が混ざっている: {forbidden}"
            );
        }
        // リダイレクト先が平文へ落ちるのを塞いでいること
        assert!(args.iter().any(|arg| arg == "--proto-redir"));
        assert!(args.iter().any(|arg| arg == "=https"));
        // 打ち切りを curl 自身にも持たせていること
        assert!(args.iter().any(|arg| arg == "--max-time"));
    }

    #[test]
    fn インストーラへ渡す環境に入れる場所の指定を混ぜない() {
        let env = installer_env(
            Path::new("/state/versions/.staging-0.2.0"),
            "https://example.test/releases/download/v0.2.0",
            "/usr/bin:/bin",
            "/home/someone",
        );
        let keys: Vec<&str> = env.iter().map(|(key, _)| key.as_str()).collect();

        // **これが混ざると rcfile 6本と控えが書き換わる**（配布インストーラは
        // AGENTDASHBOARD_INSTALL_DIR を UNMANAGED_INSTALL より先に見る）
        assert!(
            !keys.contains(&"AGENTDASHBOARD_INSTALL_DIR"),
            "入れる場所の指定が混ざっている: {keys:?}"
        );
        assert!(keys.contains(&"AGENTDASHBOARD_UNMANAGED_INSTALL"));
        // 道具探しと置き場所の解決に要るもの
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"HOME"));
        // 余計なものを渡さない
        assert_eq!(keys.len(), 4, "渡す環境が増えている: {keys:?}");
    }

    #[test]
    fn インストーラの置き場所は一覧の走査に拾われない() {
        let path = installer_path(Path::new("/state/versions/.staging-0.2.0"));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(
            name.starts_with(crate::version::STAGING_PREFIX),
            "走査に拾われる名前になっている: {name}"
        );
        // 置き場所そのものの中には落とさない（後条件の「3本だけ」に引っかかる）
        assert_eq!(path.parent(), Path::new("/state/versions/.staging-0.2.0").parent());
    }

    #[test]
    fn 道具が無い窓口は必ず失敗を返す() {
        let ops = Unavailable::new("curl がありません");
        assert_eq!(ops.unavailable_reason().as_deref(), Some("curl がありません"));
        assert!(ops.fetch_manifest().is_err());
        let outcome = ops.install(&VersionId::new("0.2.0"), Path::new("/tmp/x"));
        assert!(!outcome.success);
        assert!(outcome.output.contains("curl がありません"));
    }
}
