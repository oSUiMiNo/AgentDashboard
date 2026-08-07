//! ログを読む口の門（ログ設計§11・§14）。
//!
//! **実行ファイルを起こして標準出力を見る。** 単体テストは `session-host-core` の中に
//! あるが、そこでは確かめられないものが3つある——設定より前に処理されていること、
//! 2つの CLI が同じものを呼んでいること、伏せる規則が**実行時に環境から**組み立てられて
//! いること。どれも「プロセスを起こして環境を渡す」ことでしか見られない。
//!
//! ここへ置くのは `CARGO_BIN_EXE_*` が使えるのが実行ファイルを定義しているパッケージ
//! （`crates/dist`）だけだから。

mod common;

use std::path::Path;
use std::process::Command;

use common::FakeHome;

/// 名前は `logging::file_stem` の形（`<proc>-<pid>.<日付>.jsonl`）に合わせる。
/// **形を写しているので、書く側が変わればここも落ちる**——それが狙い。
const DAY: &str = "2026-08-07";

/// 起こしたときに必ず渡すもの。**利用者の本物の環境を1つも渡さない。**
fn command(binary: &str, home: &FakeHome) -> Command {
    // `FakeHome::new` は場所を決めるだけで作らない。**作業ディレクトリとして渡す前に
    // 実在させる**（無いまま渡すと起動そのものが「そんなファイルは無い」で失敗し、
    // 出力を見る前に落ちる）
    std::fs::create_dir_all(home.path()).expect("偽の HOME を作れること");
    let mut command = Command::new(binary);
    command
        .env("HOME", home.path())
        .env_remove("XDG_STATE_HOME")
        // 設定ファイルを拾わせない。リポジトリの中で走ると `config.toml` が居る
        .current_dir(home.path());
    command
}

fn write_log(dir: &Path, stem: &str, lines: &[&str]) {
    std::fs::create_dir_all(dir).expect("置き場所を作れること");
    let body: String = lines.iter().map(|line| format!("{line}\n")).collect();
    std::fs::write(dir.join(format!("{stem}.{DAY}.jsonl")), body).expect("書けること");
}

fn record(ts: &str, level: &str, proc: &str, pid: u32, msg: &str) -> String {
    format!(
        r#"{{"ts":"{ts}","level":"{level}","target":"t","proc":"{proc}","pid":{pid},"run_id":"r","msg":"{msg}"}}"#
    )
}

fn stdout_of(output: &std::process::Output) -> String {
    assert!(
        output.status.success(),
        "失敗しました: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn 複数のプロセスのファイルが時刻順に混ざる() {
    let home = FakeHome::new("logs-merge");
    let state = home.join("state");
    let logs = state.join("logs");
    write_log(
        &logs,
        "dashboard-111",
        &[
            &record("2099-01-01T00:00:00.000Z", "INFO", "dashboard", 111, "だ1"),
            &record("2099-01-01T00:00:02.000Z", "INFO", "dashboard", 111, "だ2"),
        ],
    );
    write_log(
        &logs,
        "session-host-222",
        &[
            &record(
                "2099-01-01T00:00:01.000Z",
                "INFO",
                "session-host",
                222,
                "せ1",
            ),
            &record(
                "2099-01-01T00:00:03.000Z",
                "INFO",
                "session-host",
                222,
                "せ2",
            ),
        ],
    );

    let output = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .args(["logs", "--state-dir"])
        .arg(&state)
        .output()
        .expect("起こせること");
    let text = stdout_of(&output);

    let order: Vec<usize> = ["だ1", "せ1", "だ2", "せ2"]
        .iter()
        .map(|needle| {
            text.find(needle)
                .unwrap_or_else(|| panic!("{needle} が無い: {text}"))
        })
        .collect();
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
}

#[test]
fn 既定は直近一時間とinfo以上() {
    let home = FakeHome::new("logs-defaults");
    let state = home.join("state");
    write_log(
        &state.join("logs"),
        "dashboard-111",
        &[
            // 1時間より前
            &record(
                "2000-01-01T00:00:00.000Z",
                "ERROR",
                "dashboard",
                111,
                "むかしの話",
            ),
            // info 未満
            &record(
                "2099-01-01T00:00:00.000Z",
                "DEBUG",
                "dashboard",
                111,
                "詳しいだけ",
            ),
            &record(
                "2099-01-01T00:00:01.000Z",
                "INFO",
                "dashboard",
                111,
                "これは出る",
            ),
        ],
    );

    let output = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .args(["logs", "--state-dir"])
        .arg(&state)
        .output()
        .expect("起こせること");
    let text = stdout_of(&output);

    assert!(text.contains("これは出る"), "{text}");
    assert!(!text.contains("むかしの話"), "{text}");
    assert!(!text.contains("詳しいだけ"), "{text}");
}

#[test]
fn 設定が壊れていても読める() {
    // 設計§11-2。**ログを見たいのはたいてい設定を触った直後**なので、ここが
    // 設定の失敗に巻き込まれると、いちばん要るときに読めない
    let home = FakeHome::new("logs-broken-config");
    let state = home.join("state");
    write_log(
        &state.join("logs"),
        "dashboard-111",
        &[&record(
            "2099-01-01T00:00:00.000Z",
            "INFO",
            "dashboard",
            111,
            "読めた",
        )],
    );
    std::fs::write(home.join("config.toml"), "これは TOML では [ ない\n").expect("書けること");
    std::fs::write(home.join("agent.toml"), "これも TOML では [ ない\n").expect("書けること");

    for binary in [
        env!("CARGO_BIN_EXE_agentdashboard"),
        env!("CARGO_BIN_EXE_agentdashboard-agent"),
    ] {
        let output = command(binary, &home)
            .args(["logs", "--state-dir"])
            .arg(&state)
            .output()
            .expect("起こせること");
        assert!(stdout_of(&output).contains("読めた"), "{binary}");
    }

    // 対照：同じ壊れた設定で、設定を読む口はちゃんと断る
    let refused = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .arg("config")
        .output()
        .expect("起こせること");
    assert!(
        !refused.status.success(),
        "壊れた設定を通してしまっています"
    );
}

#[test]
fn セッションホストの口は同じ実装を呼ぶ() {
    // 設計§11-3。**写していないこと**を、出力が1バイトも違わないことで見る
    let home = FakeHome::new("logs-same-impl");
    let state = home.join("state");
    write_log(
        &state.join("logs"),
        "session-host-222",
        &[
            &record(
                "2099-01-01T00:00:00.000Z",
                "WARN",
                "session-host",
                222,
                "あ",
            ),
            &record(
                "2099-01-01T00:00:01.000Z",
                "ERROR",
                "session-host",
                222,
                "い",
            ),
        ],
    );

    let run = |binary: &str| {
        stdout_of(
            &command(binary, &home)
                .args(["logs", "--level", "trace", "--state-dir"])
                .arg(&state)
                .output()
                .expect("起こせること"),
        )
    };
    let dashboard = run(env!("CARGO_BIN_EXE_agentdashboard"));
    let agent = run(env!("CARGO_BIN_EXE_agentdashboard-agent"));
    assert!(!dashboard.is_empty());
    assert_eq!(dashboard, agent);
}

#[test]
fn helpに射程の制約が書いてある() {
    // 設計§11-4。**できないことを、できるように見せない**
    let home = FakeHome::new("logs-help");
    let output = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .args(["logs", "--help"])
        .output()
        .expect("起こせること");
    let text = stdout_of(&output);
    assert!(text.contains("この機械の"), "{text}");
    assert!(text.contains("設定ファイルは読まない"), "{text}");
    assert!(text.contains("--state-dir"), "{text}");
}

#[test]
fn 置き場所が無いときは答えを知っている口を名指しする() {
    // この口は設定を読まない（§11-2）ので、設定で移していると既定では見つからない。
    // **実機がまさにそれだった。** 断るだけでは利用者が次に何をすればよいか分からない
    let home = FakeHome::new("logs-missing-dir");
    for (binary, expected) in [
        // ダッシュボードには置き場所を答える口がある
        (
            env!("CARGO_BIN_EXE_agentdashboard"),
            "agentdashboard state-dir",
        ),
        // **セッションホストには無い。** `state-dir` と案内すると存在しない
        // コマンドを名指しすることになる（実際に一度そう書いて、この検査で気づいた）
        (
            env!("CARGO_BIN_EXE_agentdashboard-agent"),
            "`agent.toml` の `state_dir`",
        ),
    ] {
        let output = command(binary, &home)
            .args(["logs", "--state-dir"])
            .arg(home.join("どこにも無い"))
            .output()
            .expect("起こせること");
        let text = String::from_utf8_lossy(&output.stderr);
        assert!(text.contains(expected), "{binary}: {text}");
        assert!(text.contains("--state-dir"), "{binary}: {text}");
    }

    // **案内したコマンドが実在すること。** ここを見ないと、案内だけが独り歩きする
    let asked = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .arg("state-dir")
        .output()
        .expect("起こせること");
    assert!(asked.status.success(), "state-dir が無くなっています");
}

#[test]
fn 別の機械は引けないことを理由つきで断る() {
    let home = FakeHome::new("logs-host");
    let output = command(env!("CARGO_BIN_EXE_agentdashboard"), &home)
        .args(["logs", "--host", "ほかのPC"])
        .output()
        .expect("起こせること");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("まだ引けません"), "{text}");
    assert!(text.contains("agentdashboard-agent logs"), "{text}");
}

/// 伏せる検査。**規則は実行時に環境から組み立てられる**ので、環境ごと渡して確かめる。
mod 伏せる {
    use super::*;

    /// 伏せたい実値。**どれも1つも出てはいけない。**
    const 利用者名: &str = "himitsu-taro";
    const ホスト名: &str = "himitsu-host";
    const 表示名: &str = "Himitsu Yamada";
    const 所属: &str = "Himitsu Corp";
    const メール: &str = "himitsu@real-domain.example-real.jp";
    const トークン: &str = "adp_abcdefghijklmnopqrstuvwxyz01";

    fn 仕込む(label: &str) -> (FakeHome, std::path::PathBuf) {
        let home = FakeHome::new(label);
        let state = home.join("state");
        std::fs::create_dir_all(home.path()).expect("作れること");
        std::fs::write(
            home.join(".claude.json"),
            format!(
                r#"{{"oauthAccount":{{"displayName":"{表示名}","emailAddress":"{メール}","organizationName":"{所属}"}},"知らないキー":1}}"#
            ),
        )
        .expect("書けること");

        let msg = format!(
            "{}/Dev で {利用者名} が {ホスト名} から起こした。{表示名}／{所属}／{メール}／token={トークン}",
            home.path().display()
        );
        write_log(
            &state.join("logs"),
            "dashboard-111",
            &[&record(
                "2099-01-01T00:00:00.000Z",
                "INFO",
                "dashboard",
                111,
                &msg,
            )],
        );
        (home, state)
    }

    fn 起こす(home: &FakeHome, state: &Path, sanitize: bool) -> String {
        let mut command = command(env!("CARGO_BIN_EXE_agentdashboard"), home);
        command
            .env("USER", 利用者名)
            .env("HOSTNAME", ホスト名)
            .args(["logs", "--state-dir"])
            .arg(state);
        if sanitize {
            command.arg("--sanitize");
        }
        stdout_of(&command.output().expect("起こせること"))
    }

    #[test]
    fn 実値が1つも残らない() {
        let (home, state) = 仕込む("logs-sanitize");
        let text = 起こす(&home, &state, true);

        // **否定形で見る。** 「伏せ字が出ている」だけを見ると、伏せる処理を
        // 消しても別の行の伏せ字に当たって緑のまま通る
        for 実値 in [
            home.path().to_string_lossy().as_ref(),
            利用者名,
            ホスト名,
            表示名,
            所属,
            メール,
            トークン,
        ] {
            assert!(!text.contains(実値), "伏せ切れていません（{実値}）: {text}");
        }

        assert!(text.contains("/home/dashboard-user/Dev"), "{text}");
        assert!(text.contains("redacted@example.invalid"), "{text}");
        assert!(text.contains("adp_redacted"), "{text}");
        assert!(text.contains("dashboard-org"), "{text}");
    }

    #[test]
    fn つけなければ伏せない() {
        // 設計§14-1。**書くときには伏せない**ので、既定は素のまま
        let (home, state) = 仕込む("logs-no-sanitize");
        let text = 起こす(&home, &state, false);
        assert!(text.contains(利用者名), "{text}");
        assert!(text.contains(メール), "{text}");
        assert!(text.contains(トークン), "{text}");
    }
}
