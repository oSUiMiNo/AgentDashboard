//! docker への疎通を見る門の機械検査（要件 項目15／テスト計画フェーズ1.5）。
//!
//! # なぜここまでやるのか
//!
//! `docker image inspect` は**2つの理由で失敗し、どちらも同じ終了コードで返る**。
//!
//! - **イメージが本当に無い** — 「`make setup-rust` を実行してください」が正しい
//! - **docker そのものが呼べない** — 同じことを言うと、**言われたとおりに打った人が
//!   あちらも docker を呼ぶので同じところで止まる**
//!
//! 2026-09-07 に実際に起きた（原因は docker-desktop ディストロの停止で、
//! **Docker Desktop の設定そのものは正しかった**）。
//!
//! # 偽の `docker` を PATH に置く
//!
//! `prune_target.rs` が偽の置き場所を作って実物のスクリプトを走らせるのと同じ形。
//! **Docker Desktop を止めて再現してはいけない**——同じ機械で走っている別の作業を
//! 巻き添えにする。
//!
//! この検査は `scripts/cargo` 経由で**イメージの中**で走る。中身を実測したところ
//! `bash` は在り **`docker` は無い**ので、「PATH に置かない」がそのまま成立する。
//! ただし**ホストで直に走らせても壊れないよう**、PATH から docker を持つ場所を
//! 落としてから渡す（`path_without_docker`）。
//!
//! # リポジトリに何も書かない
//!
//! 失敗の3ケースは、どれも `scripts/cargo` が `mkdir` や `flock` や `docker run` に
//! 届く前に `exit 1` する。**正常系（素通り）だけは `scripts/require-docker` を単体で
//! 叩く**——`scripts/cargo` を最後まで通すと本物の `server/target` を触るためで、
//! 見たいのは「足した段が黙って通ること」なのでこれで過不足ない。
//! `scripts/cargo` 全体の正常系は ⛳1.5 の `make ci` が通ることで確かめる。
#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// cargo workspace の根（`server/`）。`crates/core` から2つ上（`prune_target.rs` と同じ）。
fn server_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("server の下")
        .to_path_buf()
}

/// リポジトリの根。`scripts/` はワークスペースの外に居る。
fn repo_root() -> PathBuf {
    server_root()
        .parent()
        .expect("リポジトリの根")
        .to_path_buf()
}

fn cargo_script() -> PathBuf {
    repo_root().join("scripts").join("cargo")
}

fn require_docker_script() -> PathBuf {
    repo_root().join("scripts").join("require-docker")
}

/// `bash` の絶対パス。**PATH を差し替えて子を起こすので、実行ファイルの探索を
/// 子の PATH に頼らない。** 頼ると「PATH を細工した瞬間に bash が見つからない」
/// という、見たいものと関係のない失敗になる。
fn bash() -> PathBuf {
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        let candidate = Path::new(dir).join("bash");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("/bin/bash")
}

/// `docker` を持つ場所を落とした PATH。
///
/// **箱の中には docker が無いので、実際にはたいてい素通りする。** それでも落として
/// いるのは、**ホストで直に走らせたときに本物の docker を掴まないため**である。
fn path_without_docker() -> String {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|dir| !dir.is_empty() && !Path::new(dir).join("docker").is_file())
        .collect::<Vec<_>>()
        .join(":")
}

/// 偽の `docker` を1つだけ置いた場所。**Drop で畳む。**
struct 偽のdocker {
    dir: PathBuf,
}

impl 偽のdocker {
    /// `body` は `docker` として置くシェルスクリプトの中身（シェバン以下）。
    fn new(label: &str, body: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-require-docker-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("作れること");
        let path = dir.join("docker");
        std::fs::write(&path, format!("#!/usr/bin/env bash\n{body}\n")).expect("書けること");
        実行できるようにする(&path);
        Self { dir }
    }

    /// この偽物を先頭に差した PATH。
    fn path(&self) -> String {
        format!("{}:{}", self.dir.display(), path_without_docker())
    }
}

impl Drop for 偽のdocker {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn 実行できるようにする(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).expect("見えること").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).expect("付けられること");
}

#[cfg(not(unix))]
fn 実行できるようにする(_path: &Path) {}

/// `scripts/cargo` を、指定した PATH で走らせる。
///
/// 引数は `--version`。**どのケースでも cargo までは届かない**（届く前に落ちるか、
/// 落ちない正常系はこの関数を使わない）。
fn cargoを走らせる(path: &str) -> Output {
    let mut cmd = Command::new(bash());
    cmd.arg(cargo_script()).arg("--version").env("PATH", path);
    // 呼び出し側の環境が漏れ込むと、作業場所や置き場所が変わって別のところで落ちる
    for key in [
        "AGENTDASHBOARD_CARGO_DIR",
        "AGENTDASHBOARD_CARGO_TARGET_DIR",
        "AGENTDASHBOARD_CARGO_NETWORK",
    ] {
        cmd.env_remove(key);
    }
    cmd.output().expect("bash を実行できること")
}

/// `scripts/require-docker` を単体で走らせる。
fn 門を走らせる(path: &str) -> Output {
    Command::new(bash())
        .arg(require_docker_script())
        .env("PATH", path)
        .output()
        .expect("bash を実行できること")
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// 「イメージがありません」の文言。**`scripts/cargo` から読み取らずここに書く。**
/// 同じ場所から取ると、両方いっしょに変わったときに気づけない。
const イメージが無い文言: &str = "がありません。make setup-rust を実行してください。";

// --- ケースA：docker が PATH に無い -----------------------------------------

#[test]
fn dockerが見つからないときはイメージの話をしない() {
    let out = cargoを走らせる(&path_without_docker());
    let err = stderr(&out);

    assert!(!out.status.success(), "落ちていません: {err}");
    assert!(
        err.contains("docker が呼べません"),
        "疎通の話が出ていません: {err}"
    );
    assert!(
        !err.contains(イメージが無い文言),
        "イメージの話に潰れています（言われたとおり打っても同じ壁で止まる）: {err}"
    );
}

#[test]
fn 見つからないときもWSL統合とwsl_l_vが案内される() {
    let err = stderr(&cargoを走らせる(&path_without_docker()));
    assert!(
        err.contains("WSL Integration"),
        "WSL 統合が名指しされていません: {err}"
    );
    assert!(
        err.contains("wsl -l -v"),
        "ディストロの停止を確かめる手だてが案内されていません: {err}"
    );
}

// --- ケースB：docker は在るが応答しない --------------------------------------

/// 応答しない docker。**`version` で stderr に目印を書いて落ちる。**
fn 応答しない偽物() -> 偽のdocker {
    偽のdocker::new(
        "unreachable",
        r#"if [ "${1:-}" = "version" ]; then
  echo "Cannot connect to the Docker daemon (MARKER-daemon-unreachable)" >&2
  exit 1
fi
exit 1"#,
    )
}

#[test]
fn dockerが応答しないときもイメージの話をしない() {
    let fake = 応答しない偽物();
    let out = cargoを走らせる(&fake.path());
    let err = stderr(&out);

    assert!(!out.status.success(), "落ちていません: {err}");
    assert!(
        err.contains("docker が呼べません"),
        "疎通の話が出ていません: {err}"
    );
    assert!(
        !err.contains(イメージが無い文言),
        "イメージの話に潰れています: {err}"
    );
}

#[test]
fn docker自身の言い分が握り潰されない() {
    let fake = 応答しない偽物();
    let err = stderr(&cargoを走らせる(&fake.path()));
    assert!(
        err.contains("MARKER-daemon-unreachable"),
        "docker 自身の出力が捨てられています（原因を名指しできる唯一の文である）: {err}"
    );
}

#[test]
fn 応答しないときもWSL統合とwsl_l_vが案内される() {
    let fake = 応答しない偽物();
    let err = stderr(&cargoを走らせる(&fake.path()));
    assert!(
        err.contains("WSL Integration"),
        "WSL 統合が名指しされていません: {err}"
    );
    assert!(err.contains("wsl -l -v"), "wsl -l -v がありません: {err}");
}

// --- ケースC：イメージだけ無い -----------------------------------------------

#[test]
fn イメージが本当に無いときの文言は変わらない() {
    let fake = 偽のdocker::new(
        "image-missing",
        r#"case "${1:-}" in
  version) exit 0 ;;
  image) exit 1 ;;
esac
exit 1"#,
    );
    let out = cargoを走らせる(&fake.path());
    let err = stderr(&out);

    assert!(!out.status.success(), "落ちていません: {err}");
    assert!(
        err.contains(イメージが無い文言),
        "これまでどおりの文言が出ていません（区別を足したせいで壊れている）: {err}"
    );
    assert!(
        !err.contains("docker が呼べません"),
        "疎通の話に潰れています（docker は応答しているのに）: {err}"
    );
}

// --- ケースD：正常 -----------------------------------------------------------

#[test]
fn 正常なときは何も出さずに素通りする() {
    let fake = 偽のdocker::new("healthy", "exit 0");
    let out = 門を走らせる(&fake.path());

    assert!(out.status.success(), "素通りしていません: {}", stderr(&out));
    assert!(
        out.stdout.is_empty() && out.stderr.is_empty(),
        "余計な出力が増えています（cargo を呼ぶたびに通る道である）: stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&out.stdout),
        stderr(&out)
    );
}

// --- 読んで確かめるもの -------------------------------------------------------

#[test]
fn wsl_exeを呼びに行っていない() {
    let text = std::fs::read_to_string(require_docker_script()).expect("読めること");
    // **実行して確かめる形にはしない**（呼ばないことを実行で示すのは難しい）。
    //
    // 見たいのは「起動する行が無いこと」なので、**コメントは対象から外す**——
    // 「なぜ呼ばないのか」を書き残すこと自体は正しく、それを禁じると理由が消える。
    // 残るのは案内文の中の `wsl -l -v` だけで、あれは人に見せる字面である。
    for line in text.lines() {
        if !line.contains("wsl") {
            continue;
        }
        if line.trim_start().starts_with('#') {
            continue;
        }
        assert!(
            line.contains("wsl -l -v"),
            "案内文の外で wsl を起動しています。WSL の中で走るので、\
             確かめる手段そのものが同じ理由で落ちる: {line}"
        );
    }
}

#[test]
fn 疎通を見る部分が1つにまとまり両方から呼ばれている() {
    assert!(
        require_docker_script().is_file(),
        "scripts/require-docker がありません"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(require_docker_script())
            .expect("見えること")
            .permissions()
            .mode();
        assert!(mode & 0o111 != 0, "実行できません: mode={mode:o}");
    }

    let cargo = std::fs::read_to_string(cargo_script()).expect("読めること");
    assert!(
        cargo.contains("scripts/require-docker"),
        "scripts/cargo が門を通っていません"
    );

    let makefile = std::fs::read_to_string(repo_root().join("Makefile")).expect("読めること");
    assert!(
        makefile.contains("scripts/require-docker"),
        "Makefile が門を通っていません"
    );
}

#[test]
fn make_setup_rustも同じ区別を持つ() {
    let makefile = std::fs::read_to_string(repo_root().join("Makefile")).expect("読めること");
    let recipe = makefile
        .split("setup-rust:")
        .nth(1)
        .expect("setup-rust がありません");
    // 次のターゲットの手前までがレシピ
    let recipe = recipe.split("\n\n").next().expect("レシピ");

    let gate = recipe
        .find("scripts/require-docker")
        .expect("setup-rust が門を通っていません（案内先が同じ壁で止まる）");
    let build = recipe
        .find("docker build")
        .expect("docker build がありません");
    assert!(
        gate < build,
        "門が docker build より後ろにあります（先に落ちてしまう）"
    );
}
