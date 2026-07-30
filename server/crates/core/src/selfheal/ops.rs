//! 自己修復が「外の世界」に触る操作をまとめた口（設計§9）。
//!
//! カナリアの実行・テスト・ビルド・git の操作をトレイトにしてあるのは、**テストから
//! 差し替えるため**。この環境では差し替えが必須で、理由は2つある。
//!
//! 1. **コンテナの中から docker は叩けない。** Rust のテストは `scripts/cargo`
//!    （＝ `docker run`）の中で走る。その中からもう一度 `scripts/cargo` を呼ぶことは
//!    できないので、本物のツールチェーンを使うテストは書けない
//! 2. **本物の claude はクォータを消費する。** 毎回のテストで走らせるわけにいかない
//!
//! 差し替えるのは**外の世界に出る部分だけ**で、順序・判定・差し替え・再開位置の扱いは
//! 本物を通す。そこが壊れやすい場所だからである。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// ゲート（ゴールデンテスト）の結果。
#[derive(Debug, Clone)]
pub struct GateOutcome {
    pub passed: bool,
    /// 失敗したときに修復セッションへ渡す出力。合格時も残す（記録のため）
    pub output: String,
}

/// カナリアで採ったサンプル。
#[derive(Debug, Clone)]
pub struct CanarySample {
    /// 採取した Claude Code の版
    pub version: String,
    /// worktree の中に置いたサンプルの場所
    pub dir: PathBuf,
    /// ツールコールが含まれていたか
    pub has_tool_use: bool,
    /// サブエージェントが含まれていたか
    pub has_subagent: bool,
}

impl CanarySample {
    /// 採り直すべきか。
    ///
    /// カナリアの目的は「新しい版の JSONL を**構造の全部入りで**採る」こと。
    /// ツールコールもサブエージェントも無いサンプルでゲートを通しても、
    /// 一番壊れやすい部分を確かめないまま「対応済み」と記録することになる。
    pub fn is_thin(&self) -> bool {
        !self.has_tool_use || !self.has_subagent
    }
}

/// 自己修復が外の世界へ出るときの口。
pub trait SelfhealOps: Send + Sync {
    /// 作業用の git worktree を用意して、その場所を返す。
    fn prepare_worktree(&self, branch: &str) -> anyhow::Result<PathBuf>;

    /// カナリアを走らせ、採ったサンプルを worktree の `fixtures/` へ置く。
    fn run_canary(&self, model: &str, worktree: &Path) -> anyhow::Result<CanarySample>;

    /// ゴールデンテスト（自己修復のゲート）を worktree に対して実行する。
    fn run_gate(&self, worktree: &Path) -> GateOutcome;

    /// 画面側のゲート（型検査と単体テスト）を worktree に対して実行する。
    ///
    /// モデル別名の表を書き換えたときに使う（設計§14）。既定では**不合格**にしてある。
    /// 実装していない環境で「通った」ことにすると、確かめずに採用してしまう。
    fn run_web_gate(&self, _worktree: &Path) -> GateOutcome {
        GateOutcome {
            passed: false,
            output: "この環境では画面側のゲートを実行できません".to_string(),
        }
    }

    /// パーサをビルドし、出来上がった実行ファイルの場所を返す。
    fn build_parser(&self, worktree: &Path) -> anyhow::Result<PathBuf>;

    /// worktree で変更されたファイル（リポジトリ相対）を返す。
    fn changed_files(&self, worktree: &Path) -> anyhow::Result<Vec<String>>;

    /// worktree の変更をコミットする。**プッシュはしない。**
    fn commit(&self, worktree: &Path, message: &str) -> anyhow::Result<()>;
}

/// ホスト上で本物のツールチェーンと git を動かす実装。
///
/// 本PJTでは cargo が Docker の中にあるため、呼び出しは必ず `scripts/cargo` を経由する
/// （PJTガイドライン）。ここが唯一の入口であることを崩さない。
pub struct HostOps {
    repo: PathBuf,
    claude_program: String,
    canary_prompt: String,
}

/// worktree を置く場所（リポジトリ相対）。
///
/// リポジトリの**外**には置けない。`scripts/cargo` はリポジトリだけをコンテナへ
/// マウントするので、外に作るとコンテナから見えず、worktree の `.git` が指す親の
/// 場所も辿れなくなる。
pub const WORKTREE_DIR: &str = ".selfheal/worktrees";

/// ビルド成果物の置き場所（リポジトリ相対）。本体の `target/` と混ぜない。
const WORKTREE_TARGET_DIR: &str = ".selfheal/target";

/// `scripts/cargo` に作業ディレクトリを伝える環境変数（リポジトリ相対）。
pub const CARGO_DIR_ENV: &str = "AGENTDASHBOARD_CARGO_DIR";
/// `scripts/cargo` にビルド成果物の置き場所を伝える環境変数（リポジトリ相対）。
pub const CARGO_TARGET_ENV: &str = "AGENTDASHBOARD_CARGO_TARGET_DIR";

/// ゲートと ビルドの待ち上限。返らないまま自己修復が居座らないようにする。
const CARGO_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// カナリア（本物の claude）の待ち上限。
const CANARY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// git 操作の待ち上限。
const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// 画面側のゲートに許す時間。npm install 済みの前提で、型検査とテストだけ。
const WEB_GATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// カナリアに投げる既定のプロンプト（設計§9）。
///
/// ツールコールとサブエージェントの両方を必ず通らせるのが狙い。ここで採ったサンプルが
/// そのままゴールデンフィクスチャになるので、**構造の全部入り**でなければ意味がない。
pub const DEFAULT_CANARY_PROMPT: &str = "notes.md を Read で読み、Edit ツールで1行書き換えてください。次に Task ツールでサブエージェントを1つ起動し、このディレクトリのファイル一覧を調べさせてください。最後に結果を1行で要約してください。";

impl HostOps {
    pub fn new(repo: PathBuf, claude_program: String) -> Self {
        Self {
            repo,
            claude_program,
            canary_prompt: DEFAULT_CANARY_PROMPT.to_string(),
        }
    }

    pub fn repo(&self) -> &Path {
        &self.repo
    }

    /// `scripts/cargo` を worktree に対して走らせる。
    fn cargo(&self, worktree: &Path, args: &[&str]) -> Outcome {
        let Some(relative) = self.relative(worktree) else {
            return Outcome::failed(format!(
                "worktree がリポジトリの外にあります: {}",
                worktree.display()
            ));
        };
        let cargo_dir = format!("{relative}/server");
        let target_dir = format!("{WORKTREE_TARGET_DIR}/{}", leaf(worktree));

        run(
            Command::new(self.repo.join("scripts").join("cargo"))
                .args(args)
                .current_dir(&self.repo)
                .env(CARGO_DIR_ENV, &cargo_dir)
                .env(CARGO_TARGET_ENV, &target_dir),
            CARGO_TIMEOUT,
        )
    }

    /// worktree の中でシェル1行を走らせる。
    fn shell(&self, cwd: &Path, line: &str, timeout: Duration) -> Outcome {
        let mut command = Command::new("sh");
        command.arg("-c").arg(line).current_dir(cwd);
        run(&mut command, timeout)
    }

    fn git(&self, cwd: &Path, args: &[&str], timeout: Duration) -> Outcome {
        run(Command::new("git").args(args).current_dir(cwd), timeout)
    }

    /// リポジトリからの相対パスにする。
    fn relative(&self, path: &Path) -> Option<String> {
        path.strip_prefix(&self.repo)
            .ok()
            .map(|rest| rest.to_string_lossy().replace('\\', "/"))
    }
}

/// web の依存が置かれる場所（リポジトリ相対）。
const NODE_MODULES: &str = "web/node_modules";

/// 本体側の `web/node_modules` を worktree から見えるようにする。
///
/// # なぜ複製ではなくリンクなのか
///
/// worktree ごとに `npm ci` を走らせると、見直しのたびに数分とネットワークが要る。
/// 見ているのは**同じコミットの同じ `package-lock.json`** なので、本体側に入っている
/// ものと中身は一致する。リンクなら一瞬で済み、ディスクも増えない。
///
/// 本体側に無いときは**エラーにする**。黙って飛ばすと「依存が無いので確かめられません」が
/// 「確かめたら通りました」に化ける。
fn link_node_modules(repo: &Path, worktree: &Path) -> anyhow::Result<()> {
    let source = repo.join(NODE_MODULES);
    if !source.is_dir() {
        anyhow::bail!(
            "本体側に {} がありません（web の依存を入れてください）",
            source.display()
        );
    }

    let link = worktree.join(NODE_MODULES);
    // `is_dir` はリンクを辿るので、正しく張られていればここで帰る
    if link.is_dir() {
        return Ok(());
    }
    // 辿れないのに何かある＝壊れたリンクか別物。張り直す前にどける
    if link.symlink_metadata().is_ok() {
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&link);
    }
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    symlink_dir(&source, &link)?;
    Ok(())
}

#[cfg(unix)]
fn symlink_dir(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(not(unix))]
fn symlink_dir(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, link)
}

fn leaf(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "work".to_string())
}

impl SelfhealOps for HostOps {
    fn prepare_worktree(&self, branch: &str) -> anyhow::Result<PathBuf> {
        let worktree = self.repo.join(WORKTREE_DIR).join(leaf(Path::new(branch)));

        if worktree.join(".git").exists() {
            // 使い回す。前回の修復の残りを持ち込むと、変更範囲の検査が意味を失う
            self.git(&worktree, &["reset", "--hard", "HEAD"], GIT_TIMEOUT)
                .into_result("git reset")?;
            self.git(&worktree, &["clean", "-fd"], GIT_TIMEOUT)
                .into_result("git clean")?;
            return Ok(worktree);
        }

        std::fs::create_dir_all(worktree.parent().unwrap_or(&self.repo))?;
        let path = worktree.to_string_lossy().into_owned();
        // -B で既存のブランチも作り直す。前回の修復ブランチが残っていても止まらない
        self.git(
            &self.repo,
            &["worktree", "add", "--force", "-B", branch, &path, "HEAD"],
            GIT_TIMEOUT,
        )
        .into_result("git worktree add")?;
        Ok(worktree)
    }

    fn run_canary(&self, model: &str, worktree: &Path) -> anyhow::Result<CanarySample> {
        let version = claude_version(&self.claude_program)?;
        let work = tempdir("agentdashboard-canary")?;
        std::fs::write(
            work.join("notes.md"),
            "# サンプルメモ\n\n- [ ] TODO: 集計処理のテストを書く\n",
        )?;

        let session_id = protocol::ClaudeSessionId::new().to_string();
        // 環境は最小限にする。Claude 関連の変数を継承させると、別セッションが同じIDを
        // 名乗る事故が起きる（設計§6 の許可リスト方式と同じ考え方）
        let outcome = run(
            Command::new(&self.claude_program)
                .current_dir(&work)
                .env_clear()
                .envs(crate::session::lifecycle::sanitized_env())
                .args([
                    "--session-id",
                    &session_id,
                    "--model",
                    model,
                    "--permission-mode",
                    "acceptEdits",
                    "--allowed-tools",
                    "Read",
                    "Edit",
                    "Write",
                    "Bash",
                    "Glob",
                    "Grep",
                    "Task",
                    "Agent",
                    "-p",
                    &self.canary_prompt,
                ]),
            CANARY_TIMEOUT,
        );
        if !outcome.success {
            let _ = std::fs::remove_dir_all(&work);
            anyhow::bail!("カナリアが失敗しました: {}", outcome.output);
        }

        let transcript = find_transcript(&session_id)
            .ok_or_else(|| anyhow::anyhow!("カナリアのトランスクリプトが見つかりません"))?;
        let dir = worktree
            .join("fixtures")
            .join(format!("v{version}"))
            .join("canary");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        std::fs::copy(&transcript, dir.join("session.jsonl"))?;
        // サブエージェントは <セッションID>/subagents/ に別ファイルで置かれる
        let session_dir = transcript.with_extension("");
        if session_dir.is_dir() {
            copy_tree(&session_dir, &dir.join("session"))?;
        }

        // 本リポジトリは公開。採取物には環境の構成情報が混ざるので必ず落とす
        // （PJTガイドライン「フィクスチャを採取するとき」）
        let sanitize = run(
            Command::new("python3")
                .arg(self.repo.join("scripts").join("sanitize-fixtures.py"))
                .arg(&dir)
                .arg("--extra")
                .arg(format!("{}=/work/sample", work.display())),
            GIT_TIMEOUT,
        );
        let _ = std::fs::remove_dir_all(&work);
        if !sanitize.success {
            anyhow::bail!("匿名化に失敗しました: {}", sanitize.output);
        }

        let body = std::fs::read_to_string(dir.join("session.jsonl")).unwrap_or_default();
        Ok(CanarySample {
            version,
            has_tool_use: body.contains(r#""tool_use""#),
            has_subagent: dir.join("session").join("subagents").is_dir(),
            dir,
        })
    }

    fn run_gate(&self, worktree: &Path) -> GateOutcome {
        let outcome = self.cargo(worktree, &["nextest", "run", "-p", "transcript-parser"]);
        GateOutcome {
            passed: outcome.success,
            output: outcome.output,
        }
    }

    fn run_web_gate(&self, worktree: &Path) -> GateOutcome {
        // **worktree には node_modules が無い。** `.gitignore` で除外されているので
        // git は持ってこない。本体側の実体を見せてやらないと `vitest: not found` で
        // 必ず落ちる（これに気づかないまま出荷して、自動追随が全環境で死んでいた）
        if let Err(error) = link_node_modules(&self.repo, worktree) {
            return GateOutcome {
                passed: false,
                output: format!("画面側のゲートを実行できません: {error:#}"),
            };
        }

        // 型検査と単体テストを1回で。cargo と違って Docker には入っていないので
        // ホストの npm をそのまま使う（web の開発は元からホストで行う）。
        //
        // `--force` を付けるのは、増分ビルド情報の置き場所（`tsBuildInfoFile`）が
        // `node_modules/.tmp/` を指しているため。リンクを張ると本体と worktree で
        // それを共有するので、増分判定に任せると**変更したのに型検査を飛ばして
        // 「通った」**が起こりうる。ゲートは毎回きっちり見るのが仕事である
        let outcome = self.shell(
            worktree,
            "cd web && npx tsc -b --force && npm run test",
            WEB_GATE_TIMEOUT,
        );
        GateOutcome {
            passed: outcome.success,
            output: outcome.output,
        }
    }

    fn build_parser(&self, worktree: &Path) -> anyhow::Result<PathBuf> {
        self.cargo(worktree, &["build", "--release", "-p", "transcript-parser"])
            .into_result("cargo build")?;
        let built = self
            .repo
            .join(WORKTREE_TARGET_DIR)
            .join(leaf(worktree))
            .join("release")
            .join("transcript-parser");
        if !built.is_file() {
            anyhow::bail!("ビルドしたパーサが見つかりません: {}", built.display());
        }
        Ok(built)
    }

    fn changed_files(&self, worktree: &Path) -> anyhow::Result<Vec<String>> {
        let outcome = self.git(worktree, &["status", "--porcelain"], GIT_TIMEOUT);
        let outcome = outcome.into_result("git status")?;
        Ok(outcome
            .lines()
            .filter_map(|line| line.get(3..))
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect())
    }

    fn commit(&self, worktree: &Path, message: &str) -> anyhow::Result<()> {
        self.git(worktree, &["add", "-A"], GIT_TIMEOUT)
            .into_result("git add")?;
        self.git(worktree, &["commit", "-m", message], GIT_TIMEOUT)
            .into_result("git commit")?;
        Ok(())
    }
}

/// コマンド1回の結果。
struct Outcome {
    success: bool,
    output: String,
}

impl Outcome {
    fn failed(output: String) -> Self {
        Self {
            success: false,
            output,
        }
    }

    fn into_result(self, what: &str) -> anyhow::Result<String> {
        if self.success {
            Ok(self.output)
        } else {
            anyhow::bail!("{what} に失敗しました: {}", self.output)
        }
    }
}

/// 標準出力と標準エラーをまとめて受け取り、上限時間で打ち切る。
///
/// 打ち切りを入れているのは、返らないコマンドが1つあるだけで自己修復が
/// 「作業中のまま永久に終わらない」状態になるため。
fn run(command: &mut Command, timeout: Duration) -> Outcome {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return Outcome::failed(format!("起動できません: {error}")),
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map(collect).unwrap_or_default();
                return Outcome {
                    success: status.success(),
                    output,
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Outcome::failed(format!("{timeout:?} を過ぎても終わりませんでした"));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Outcome::failed(format!("待ち受けに失敗しました: {error}")),
        }
    }
}

fn collect(output: std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    text
}

fn claude_version(program: &str) -> anyhow::Result<String> {
    let outcome = run(Command::new(program).arg("--version"), GIT_TIMEOUT);
    let text = outcome.into_result("claude --version")?;
    // 「2.1.220 (Claude Code)」のような行から数字だけを取り出す
    text.split_whitespace()
        .find(|token| {
            let mut parts = token.split('.');
            parts.clone().count() == 3 && parts.all(|part| part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("claude の版を読み取れません: {text}"))
}

/// 採取したセッションのトランスクリプトを `~/.claude/projects` から探す。
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let root = PathBuf::from(home).join(".claude").join("projects");
    let wanted = format!("{session_id}.jsonl");
    for project in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = project.path().join(&wanted);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn tempdir(prefix: &str) -> anyhow::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        protocol::CardId::new()
    ));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn copy_tree(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 版の文字列から数字だけを取り出す() {
        // 実際の出力は「2.1.220 (Claude Code)」のような形
        let outcome = run(
            Command::new("sh").args(["-c", "echo '2.1.220 (Claude Code)'"]),
            GIT_TIMEOUT,
        );
        assert!(outcome.success);
        assert!(outcome.output.contains("2.1.220"));
    }

    #[test]
    fn 終わらないコマンドは打ち切られる() {
        // 打ち切りが無いと、自己修復が「作業中」のまま永久に居座る
        let outcome = run(
            Command::new("sh").args(["-c", "sleep 30"]),
            Duration::from_millis(300),
        );
        assert!(!outcome.success);
        assert!(
            outcome.output.contains("終わりませんでした"),
            "実際: {}",
            outcome.output
        );
    }

    #[test]
    fn 失敗したコマンドは出力ごと理由になる() {
        let outcome = run(
            Command::new("sh").args(["-c", "echo だめでした >&2; exit 1"]),
            GIT_TIMEOUT,
        );
        let error = outcome.into_result("試験").unwrap_err().to_string();
        assert!(error.contains("試験 に失敗しました"), "実際: {error}");
        assert!(error.contains("だめでした"), "実際: {error}");
    }

    // ---- 依存のリンク（設計§14 の画面側ゲートの前提）--------------------------------

    /// 本体と worktree に見立てた2つの場所を作る。
    fn link_fixture(label: &str, with_source: bool) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "agentdashboard-link-{label}-{}-{}",
            std::process::id(),
            protocol::CardId::new()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let (repo, worktree) = (root.join("repo"), root.join("worktree"));
        std::fs::create_dir_all(worktree.join("web")).unwrap();
        if with_source {
            std::fs::create_dir_all(repo.join(NODE_MODULES).join(".bin")).unwrap();
            std::fs::write(
                repo.join(NODE_MODULES).join(".bin").join("vitest"),
                "#!/bin/sh",
            )
            .unwrap();
        }
        (repo, worktree)
    }

    #[test]
    fn 本体の依存が_worktree_から見えるようになる() {
        let (repo, worktree) = link_fixture("fresh", true);
        link_node_modules(&repo, &worktree).expect("張れること");
        // 辿った先に本体の中身があること。リンクが張られただけでは意味がない
        assert!(
            worktree
                .join(NODE_MODULES)
                .join(".bin")
                .join("vitest")
                .is_file()
        );
    }

    #[test]
    fn すでに張ってあれば触らない() {
        // 見直しは同じ worktree を使い回すので、2回目以降が壊れないこと
        let (repo, worktree) = link_fixture("again", true);
        link_node_modules(&repo, &worktree).expect("1回目");
        link_node_modules(&repo, &worktree).expect("2回目");
        assert!(worktree.join(NODE_MODULES).join(".bin").is_dir());
    }

    #[test]
    fn 壊れたリンクが残っていたら張り直す() {
        // 本体を入れ直したあとなど、前のリンクが宙に浮いていることがある
        let (repo, worktree) = link_fixture("broken", true);
        symlink_dir(
            Path::new("/存在しないはずの場所"),
            &worktree.join(NODE_MODULES),
        )
        .unwrap();

        link_node_modules(&repo, &worktree).expect("張り直せること");
        assert!(worktree.join(NODE_MODULES).join(".bin").is_dir());
    }

    #[test]
    fn 本体に依存が無ければ理由が読めるエラーになる() {
        // 「確かめられなかった」を「通った」にしないための入口
        let (repo, worktree) = link_fixture("missing", false);
        let error = link_node_modules(&repo, &worktree)
            .expect_err("エラーになること")
            .to_string();
        assert!(error.contains("web/node_modules"), "実際: {error}");
        assert!(!worktree.join(NODE_MODULES).exists());
    }

    #[test]
    fn サンプルが薄いかどうかを判定できる() {
        let full = CanarySample {
            version: "2.1.220".to_string(),
            dir: PathBuf::from("/tmp"),
            has_tool_use: true,
            has_subagent: true,
        };
        assert!(!full.is_thin());

        let thin = CanarySample {
            has_subagent: false,
            ..full.clone()
        };
        assert!(thin.is_thin(), "サブエージェントが無ければ採り直す");
    }
}
