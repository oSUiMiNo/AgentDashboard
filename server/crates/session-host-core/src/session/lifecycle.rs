//! セッションを起動するときの「条件の組み立て」（設計§6）。
//!
//! ここが担うのは、どの実行ファイルを・どんな引数で・どんな環境変数で・どのディレクトリで
//! 起動するかを決めることだけ。実際に PTY を開いて動かすのは [`super::pty`] の仕事。
//!
//! **環境変数を許可リスト方式にしているのが最重要点**。実機検証で `CLAUDE_CODE_SESSION_ID`
//! などが子プロセスへ継承され、別セッションが同じセッションIDを名乗る事故が起きることを
//! 確認している。「消したい変数を並べる（拒否リスト）」だと、将来 Claude Code が新しい
//! 変数を増やしたときに漏れる。「通す変数を並べる（許可リスト）」なら知らない変数は
//! 自動的に落ちるので、こちらを採る。
//!
//! 環境を組み立てる関数は「親の環境を読む部分」と「絞り込む部分」を分けてある。絞り込みは
//! 引数で受け取った変数だけを見る純粋な関数なので、テストがプロセスの環境を書き換えずに済む。

use super::permission;
use portable_pty::CommandBuilder;
use protocol::{ClaudeSessionId, PermissionMode};
use std::path::Path;

/// 起動する CLI の実行ファイルを差し替えるための環境変数。
///
/// 既定は本物の `claude`。自動テストと E2E では擬似 claude（testkit の `fake-claude`）を
/// 指すために使う。これが無いと、テストのたびに本物の CLI と認証情報が必要になる。
pub const CLAUDE_BIN_ENV: &str = "AGENTDASHBOARD_CLAUDE_BIN";

/// 既定で起動する実行ファイル名。PATH から解決される。
pub const DEFAULT_CLAUDE_PROGRAM: &str = "claude";

/// 子プロセスへ渡してよい環境変数の名前（完全一致）。
const ALLOWED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "TZ",
    "COLORTERM",
    "TMPDIR",
];

/// 子プロセスへ渡してよい環境変数の接頭辞。ロケール系はまとめて通す。
const ALLOWED_ENV_PREFIXES: &[&str] = &["LC_"];

/// 子プロセスに与える `TERM`。継承ではなく固定値にする。
///
/// ブラウザ側の xterm.js が解釈できる能力に合わせるため。親のターミナルの `TERM`（`dumb`
/// かもしれないし、xterm.js に無い機能を宣言しているかもしれない）を引き継ぐと、CLI が
/// 出力する制御シーケンスがブラウザ側と噛み合わなくなる。
pub const TERM_VALUE: &str = "xterm-256color";

/// 起動する実行ファイル名を決める。
pub fn claude_program() -> String {
    std::env::var(CLAUDE_BIN_ENV).unwrap_or_else(|_| DEFAULT_CLAUDE_PROGRAM.to_string())
}

/// その名前の環境変数を子へ渡してよいか。
pub fn is_allowed_env(name: &str) -> bool {
    ALLOWED_ENV.contains(&name)
        || ALLOWED_ENV_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// 渡された環境変数から、子へ通してよいものだけを選び `TERM` を固定値で足す。
///
/// 親の環境を読まない純粋な関数にしてあるので、テストから任意の環境を与えて検証できる。
pub fn sanitize_env<I>(vars: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut kept: Vec<(String, String)> = vars
        .into_iter()
        .filter(|(name, _)| is_allowed_env(name))
        .collect();
    kept.push(("TERM".to_string(), TERM_VALUE.to_string()));
    // 起動のたびに順序が変わると、テストや調査で差分を見るときに邪魔になる
    kept.sort();
    kept
}

/// 実際の親プロセスの環境を絞り込んだもの。
pub fn sanitized_env() -> Vec<(String, String)> {
    sanitize_env(std::env::vars())
}

/// 起動コマンドを組み立てる。
///
/// `--session-id` でダッシュボード側が採番した UUID を渡すのが要点。CLI に採番させると、
/// 起動してからフックが届くまでの間「このPTYがどのセッションなのか」が分からない時間が
/// できてしまう。自己採番なら起動した瞬間から対応が確定する。
///
/// `--settings` にはセッション専用のフック設定を渡す（設計§7）。これは利用者の
/// グローバル設定を**書き換えずに追加で読み込ませる**オプションなので、ダッシュボードが
/// 起動したセッションにだけフックが効く。
pub fn build_command(
    program: &str,
    cwd: &Path,
    start: SessionStart,
    settings: &Path,
) -> CommandBuilder {
    build_command_with_env(program, cwd, start, settings, sanitized_env())
}

/// 起動引数を足して組み立てる（設計§9 の修復セッション用）。
///
/// 足すのは修復セッションだけで、利用者が起動する通常のセッションには何も足さない。
/// 無人で走らせる都合の設定（権限・読み込む設定ソース）を全セッションに広げると、
/// 利用者の意図しない挙動になる。
pub fn build_command_with_extra(
    program: &str,
    cwd: &Path,
    start: SessionStart,
    settings: &Path,
    extra: &[String],
) -> CommandBuilder {
    let mut cmd = build_command_with_env(program, cwd, start, settings, sanitized_env());
    for arg in extra {
        cmd.arg(arg);
    }
    cmd
}

/// 権限モードの起動引数を組み立てる（設計§4）。
///
/// **指定なしのときは何も付けない。** 空文字や `manual` を明示的に渡さないのが要点で、
/// 「指定なし」は利用者の設定（`~/.claude/settings.json` の `permissions.defaultMode`）を
/// 尊重するという意味だから。こちらで `manual` に固定すると、その設定を黙って無視することになる。
///
/// **`--dangerously-skip-permissions` は組み立てない。** `--permission-mode
/// bypassPermissions` と同義の別名だが、同じことを2通りで指定できる状態を持ち込むと、
/// どちらが使われたかで挙動が違うのではという疑いが常に残る。
pub fn permission_mode_args(mode: Option<&PermissionMode>) -> Vec<String> {
    match mode {
        Some(mode) => vec![
            "--permission-mode".to_string(),
            permission::cli_argument(mode),
        ],
        None => Vec::new(),
    }
}

/// セッションを「新しく始める」のか「続きから始める」のか（設計§6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStart {
    /// ダッシュボードが採番したIDで新規に始める
    Fresh(ClaudeSessionId),
    /// 既存のセッションを引き継ぐ。
    ///
    /// このとき**IDは自己採番できない**。CLI 側が新しいIDを振る可能性があるため、
    /// カードに結びつくIDは最初のフックが運んでくるまで決まらない（設計§6 の張り替え）。
    Resume(ClaudeSessionId),
}

/// 環境変数を明示して起動コマンドを組み立てる（テスト用の入口）。
pub fn build_command_with_env(
    program: &str,
    cwd: &Path,
    start: SessionStart,
    settings: &Path,
    env: Vec<(String, String)>,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);

    // CommandBuilder は既定で親の環境を丸ごと引き継ぐので、まず空にしてから積み直す。
    // これを忘れると許可リストが意味を成さない。
    cmd.env_clear();
    for (name, value) in env {
        cmd.env(name, value);
    }

    match start {
        SessionStart::Fresh(session_id) => {
            cmd.arg("--session-id");
            cmd.arg(session_id.to_string());
        }
        SessionStart::Resume(session_id) => {
            cmd.arg("--resume");
            cmd.arg(session_id.to_string());
        }
    }
    cmd.arg("--settings");
    cmd.arg(settings);
    cmd.cwd(cwd);
    cmd
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use std::collections::HashMap;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn env_of(cmd: &CommandBuilder) -> HashMap<String, String> {
        cmd.iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn 許可リストの判定は名前と接頭辞の両方を見る() {
        assert!(is_allowed_env("PATH"));
        assert!(is_allowed_env("HOME"));
        assert!(is_allowed_env("LC_ALL"));
        assert!(is_allowed_env("LC_TIME"));

        assert!(!is_allowed_env("CLAUDE_CODE_SESSION_ID"));
        assert!(!is_allowed_env("CLAUDECODE"));
        assert!(!is_allowed_env("ANTHROPIC_API_KEY"));
        // 部分一致で通してしまわないこと
        assert!(!is_allowed_env("MY_PATH"));
        assert!(!is_allowed_env("PATH_EXTRA"));
    }

    #[test]
    fn 絞り込みで許可リスト外は1つも残らない() {
        // 実機で継承事故を確認した変数を含めて与える
        let sanitized = sanitize_env(vars(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/example"),
            ("LC_ALL", "ja_JP.UTF-8"),
            ("CLAUDE_CODE_SESSION_ID", "継承されてはいけない値"),
            ("CLAUDECODE", "1"),
            ("ANTHROPIC_API_KEY", "秘密"),
            ("MY_PATH", "紛らわしい名前"),
        ]));

        let names: Vec<&str> = sanitized.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["HOME", "LC_ALL", "PATH", "TERM"]);
        assert!(!names.iter().any(|name| name.starts_with("CLAUDE")));
    }

    #[test]
    fn termは継承ではなく固定値になる() {
        let sanitized = sanitize_env(vars(&[("TERM", "dumb"), ("PATH", "/usr/bin")]));
        let term: Vec<&String> = sanitized
            .iter()
            .filter(|(k, _)| k == "TERM")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(
            term,
            [&TERM_VALUE.to_string()],
            "TERM が1つだけ、固定値であること"
        );
    }

    #[test]
    fn 組み立てたコマンドの環境が絞り込み結果と一致する() {
        let cmd = build_command_with_env(
            "/bin/true",
            Path::new("/tmp"),
            SessionStart::Fresh(ClaudeSessionId::new()),
            Path::new("/tmp/settings.json"),
            sanitize_env(vars(&[
                ("PATH", "/usr/bin"),
                ("CLAUDE_CODE_SESSION_ID", "継承されてはいけない値"),
            ])),
        );

        let env = env_of(&cmd);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("TERM").map(String::as_str), Some(TERM_VALUE));
        assert!(
            !env.keys().any(|name| name.starts_with("CLAUDE")),
            "CLAUDE 系が漏れている: {:?}",
            env.keys().collect::<Vec<_>>()
        );
        assert_eq!(env.len(), 2, "余計な変数が増えていない: {env:?}");
    }

    #[test]
    fn session_idとsettingsが起動引数に渡る() {
        let session_id = ClaudeSessionId(uuid::uuid!("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        let cmd = build_command_with_env(
            "claude",
            Path::new("/tmp"),
            SessionStart::Fresh(session_id),
            Path::new("/tmp/ad/settings.json"),
            vec![],
        );

        assert_eq!(
            argv_of(&cmd),
            [
                "claude",
                "--session-id",
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "--settings",
                "/tmp/ad/settings.json",
            ]
        );
        assert_eq!(
            cmd.get_cwd().map(|cwd| cwd.to_string_lossy().into_owned()),
            Some("/tmp".to_string())
        );
    }

    #[test]
    fn 引き継ぎ起動ではidを自己採番しない() {
        // resume では CLI 側が新しいIDを振りうるので、こちらから決めてはいけない。
        // カードに結びつくIDは最初のフックが運んでくる（設計§6）
        let session_id = ClaudeSessionId(uuid::uuid!("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        let cmd = build_command_with_env(
            "claude",
            Path::new("/tmp"),
            SessionStart::Resume(session_id),
            Path::new("/tmp/ad/settings.json"),
            vec![],
        );

        let argv = argv_of(&cmd);
        assert!(argv.contains(&"--resume".to_string()), "実際: {argv:?}");
        assert!(
            !argv.contains(&"--session-id".to_string()),
            "実際: {argv:?}"
        );
    }

    #[test]
    fn モードを指定すると起動引数が2つ増える() {
        assert_eq!(
            permission_mode_args(Some(&PermissionMode::new("acceptEdits"))),
            ["--permission-mode", "acceptEdits"]
        );
        // 正規値 default は、CLI が受け付ける綴り manual に直してから渡す
        assert_eq!(
            permission_mode_args(Some(&PermissionMode::new("default"))),
            ["--permission-mode", "manual"]
        );
    }

    #[test]
    fn 指定なしなら起動引数を付けない() {
        // 利用者の permissions.defaultMode を尊重する。manual を勝手に補わない
        assert!(permission_mode_args(None).is_empty());
    }

    #[test]
    fn 危険な別名はどの経路でも組み立てられない() {
        // --dangerously-skip-permissions は bypassPermissions と同義だが、
        // 同じことを2通りで指定できる状態を持ち込まない
        for mode in [
            "manual",
            "acceptEdits",
            "plan",
            "auto",
            "dontAsk",
            "bypassPermissions",
        ] {
            let args = permission_mode_args(Some(&PermissionMode::new(mode)));
            assert!(
                !args.iter().any(|arg| arg.contains("dangerously")),
                "{mode} で危険な別名が出た: {args:?}"
            );
        }
    }

    #[test]
    fn モードの引数は起動コマンドの末尾に足せる() {
        let cmd = build_command_with_env(
            "claude",
            Path::new("/tmp"),
            SessionStart::Fresh(ClaudeSessionId::new()),
            Path::new("/tmp/settings.json"),
            vec![],
        );
        let mut cmd = cmd;
        for arg in permission_mode_args(Some(&PermissionMode::new("bypassPermissions"))) {
            cmd.arg(arg);
        }
        let argv = argv_of(&cmd);
        assert_eq!(
            &argv[argv.len() - 2..],
            ["--permission-mode", "bypassPermissions"]
        );
    }

    fn argv_of(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }
}
