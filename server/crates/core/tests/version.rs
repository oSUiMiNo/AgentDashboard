//! 選ばれている版で立ち上がることを、**本物の実行ファイルを起こして**確かめる
//! （CICD設計§4・§5・§11・§17、テスト計画フェーズ3）。
//!
//! 乗り換えは `exec` でプロセスそのものが置き換わる。同じプロセスの中では踏めないので、
//! ここだけは実バイナリを起こす（`two_process.rs` と同じ土台）。
//!
//! # 行き先はほとんどが「印を出すだけの小さなスクリプト」
//!
//! 乗り換え**先**が本物である必要は無い。`exec` が届いたかどうかは、行き先が名乗れば
//! 分かる。本物どうしで繋ぐと1回あたり待ち受けの確保まで走るので、**枝分かれの検査は
//! 全部スクリプトで踏み、実バイナリどうしの通しは1本だけ**にしてある。
//!
//! # 乗り換えなかったことを、どう見分けるか
//!
//! 「乗り換えない」は「そのまま自分でサーバとして立ち上がる」なので、そのままだと
//! 待ち受けを確保してしまい、テストが重くなる。そこで**記録の置き場所を壊した設定**を
//! 渡す——乗り換えれば印が出て終わり、乗り換えなければ記録に繋げず落ちる。
//! どちらに転んだかが1回の実行で分かる。

#![allow(non_snake_case)]

use agent_core::version::{
    VERSION_HANDOVER_ENV, VERSION_POINTER, VERSION_SUPPORTED_ENV, VERSIONS_DIR_NAME,
};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

/// 行き先のスクリプトが名乗る合言葉。
const MARKER: &str = "乗り換えました";

/// 待ち受けまで通す1本のための待ち時間。
const TIMEOUT: Duration = Duration::from_secs(30);

/// 使い捨ての作業場所。
struct Fixture {
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn new(label: &str) -> Self {
        Self::at(std::env::temp_dir(), label)
    }

    /// 実行ファイルの隣に作業場所を作る。
    ///
    /// **ハードリンクは同じファイルシステムの中でしか張れない。** 一時領域と
    /// `target/` は別のファイルシステムなので、版を控えるのにリンクを使うテストは
    /// こちらを使う。素直にコピーすると1本 281MB（デバッグビルド）になる。
    fn beside_binaries(label: &str) -> Self {
        let binaries = testkit::binary_path("agentdashboard")
            .parent()
            .expect("実行ファイルの親があること")
            .to_path_buf();
        Self::at(binaries, label)
    }

    fn at(base: PathBuf, label: &str) -> Self {
        let dir = base.join(format!(
            "agentdashboard-version-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(dir.join("state")).expect("作業ディレクトリを作れること");
        Self { dir }
    }

    fn state_dir(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// **記録に繋げない設定。** 乗り換えなければここで落ちるので、乗り換えの有無が分かる。
    ///
    /// ポートは通る値を入れる。`0` は設定の検査が弾くので、**設定が壊れている扱い**に
    /// なってしまい、見たいもの（記録に繋げずに落ちる）とは別の道を通る。
    fn config_that_cannot_start(&self) -> PathBuf {
        self.write_config("sqlite:///dev/null/dashboard.db", free_port())
    }

    fn write_config(&self, database_url: &str, port: u16) -> PathBuf {
        let path = self.dir.join("config.toml");
        std::fs::write(
            &path,
            format!(
                "port = {port}\nstate_dir = \"{state}\"\ndatabase_url = \"{database_url}\"\n",
                state = self.state_dir().display(),
            ),
        )
        .expect("設定を書けること");
        path
    }

    /// 保管庫に「名乗るだけの版」を置く。
    ///
    /// 版の名前をいま走っている版と同じにできるようにしてあるのは、**名前ではなく
    /// 実パスで比べている**ことを確かめるため。
    fn write_marker_version(&self, version: &str) -> PathBuf {
        let dir = self.state_dir().join(VERSIONS_DIR_NAME).join(version);
        std::fs::create_dir_all(&dir).expect("保管庫を作れること");
        let binary = dir.join("agentdashboard");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\n\
                 echo '{MARKER}'\n\
                 echo \"自分=$0\"\n\
                 echo \"印=${{{VERSION_HANDOVER_ENV}:-無し}}\"\n\
                 echo \"フックの入口=${{AGENTDASHBOARD_HOOK_BIN:-無し}}\"\n\
                 echo \"引数=$*\"\n"
            ),
        )
        .expect("書けること");
        make_executable(&binary);
        binary
    }

    fn point_at(&self, target: &Path) {
        std::fs::write(
            self.state_dir().join(VERSION_POINTER),
            target.to_string_lossy().as_bytes(),
        )
        .expect("ポインタを書けること");
    }

    /// ダッシュボードを起こす。**乗り換えの判定を通す**ので、印は外してある。
    fn run(&self, args: &[&std::ffi::OsStr]) -> Output {
        let mut command = testkit::binary_command("agentdashboard");
        command
            // 土台は既定で「乗り換え済み」の印を立てる（開発者の実環境を読まないため）。
            // ここは乗り換えそのものを試すので外す
            .env_remove(VERSION_HANDOVER_ENV)
            // 退避は起こさない。実行ファイル3本ぶんを毎回コピーすることになる
            .env(VERSION_SUPPORTED_ENV, "0")
            .env(
                agent_core::session::lifecycle::CLAUDE_BIN_ENV,
                testkit::fake_claude::path(),
            )
            .args(args);
        command.output().expect("起こせること")
    }

    /// 設定を指してダッシュボードを起こす。
    fn run_with_config(&self, config: &Path, extra: &[&str]) -> Output {
        let mut args: Vec<&std::ffi::OsStr> = vec!["--config".as_ref(), config.as_ref()];
        args.extend(extra.iter().map(|arg| arg.as_ref() as &std::ffi::OsStr));
        self.run(&args)
    }
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("実行できる形にできること");
    }
}

fn text_of(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

// ---------------------------------------------------------------------------
// 乗り換え（設計§4）
// ---------------------------------------------------------------------------

#[test]
fn ポインタが別の版を指していればその実行ファイルで動き出す() {
    let fixture = Fixture::new("hands-over");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    let text = text_of(&out);

    assert!(text.contains(MARKER), "乗り換えていません:\n{text}");
    assert!(
        text.contains(&format!("自分={}", target.display())),
        "行き先が違います:\n{text}"
    );
}

#[test]
fn 版名が同じでも実パスが違えば乗り換える() {
    // **手元でビルドした版と配った同じ番号の版は同じ名前を名乗る**（ワークスペースの
    // 版は1箇所にしか無い）。名前で比べると、この場面で乗り換えが起きない
    let fixture = Fixture::new("same-name");
    let target = fixture.write_marker_version(env!("CARGO_PKG_VERSION"));
    fixture.point_at(&target);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    let text = text_of(&out);

    assert!(
        text.contains(MARKER),
        "版名が同じだからと乗り換えを止めています:\n{text}"
    );
}

#[test]
fn 自分自身を指していても乗り換えは一回で止まる() {
    // ポインタが自分を指していると、素朴な実装は永久に自分を起こし直す
    let fixture = Fixture::new("self-pointer");
    fixture.point_at(&testkit::binary_path("agentdashboard"));

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    let text = text_of(&out);

    assert!(
        !text.contains(MARKER),
        "行き先はスクリプトではないはずです:\n{text}"
    );
    assert!(
        text.contains("DB") || text.contains("スキーマ") || text.contains("データベース"),
        "乗り換えずに自分で続けて、記録に繋げず落ちるはずです:\n{text}"
    );
}

#[test]
fn 門が叩くサブコマンドは乗り換えない() {
    // **消す道は `state-dir` を叩く。** ここが乗り換えると、聞いた相手と答えた相手が
    // 変わり、消す場所が版に振り回される
    let fixture = Fixture::new("subcommands");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);
    let config = fixture.write_config("sqlite:///dev/null/dashboard.db", free_port());

    for subcommand in ["state-dir", "config", "migrations"] {
        let out = fixture.run_with_config(&config, &[subcommand]);
        let text = text_of(&out);
        assert!(
            !text.contains(MARKER),
            "{subcommand} が乗り換えています:\n{text}"
        );
    }

    // `state-dir` は**1行そのものが値**なので、答えが崩れていないことも見る
    let out = fixture.run_with_config(&config, &["state-dir"]);
    let printed = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        printed.trim(),
        fixture.state_dir().display().to_string(),
        "消す道が読む答えが変わっています"
    );
}

#[test]
fn 形の名前は目印つきで一行ずつ出る() {
    // 門は**目印の形が読めるかどうか**で「聞けた」を判定する（設計§9）。
    // 終了コードで見分けようとすると、知らないサブコマンド・起動できない・
    // 将来の版が正当な理由で失敗した、を取り違える
    let fixture = Fixture::new("schema-names");
    let out = fixture.run(&["migrations".as_ref()]);

    assert!(out.status.success(), "答えられていない:\n{}", text_of(&out));
    let printed = String::from_utf8_lossy(&out.stdout);
    let mut lines = printed.lines();
    assert_eq!(
        lines.next(),
        Some(agentdashboard_core::cli::SCHEMA_NAMES_MARKER),
        "先頭は目印:\n{printed}"
    );
    let names: Vec<&str> = lines.collect();
    assert!(!names.is_empty(), "1つも並んでいない:\n{printed}");
    assert!(
        names.iter().all(|name| !name.trim().is_empty()),
        "1行1つ（空行を混ぜない）:\n{printed}"
    );
}

#[test]
fn 形の名前は設定が壊れていても答えられる() {
    // 門は「その設定を読めるか」も**別に**聞く。ここで設定の失敗に巻き込まれると
    // 2つの問いの答えが混ざり、設定が壊れているだけの版を「確かめられません」にしてしまう
    let fixture = Fixture::new("schema-names-broken");
    let broken = fixture.dir.join("broken.toml");
    std::fs::write(&broken, "知らないキー = 1\n").unwrap();

    let out = fixture.run(&["--config".as_ref(), broken.as_os_str(), "migrations".as_ref()]);

    assert!(
        out.status.success(),
        "壊れた設定に巻き込まれている:\n{}",
        text_of(&out)
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).starts_with(agentdashboard_core::cli::SCHEMA_NAMES_MARKER),
        "目印が出ていない:\n{}",
        text_of(&out)
    );
}

// ---------------------------------------------------------------------------
// フックの焼き込み先（設計§5）
// ---------------------------------------------------------------------------

#[test]
fn 乗り換え先へはフックの入口として乗り換え前の自分を渡す() {
    // 渡さないと `current_exe()` が保管庫の版フォルダを指し、**版を消した瞬間に
    // 生きているセッションのフックが全滅する**。しかもフックは返事を待たない
    // 呼び方なので claude は止まらず、症状は「作業中のまま固まる」になる
    let fixture = Fixture::new("hook-bin");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    let text = text_of(&out);

    let entry = testkit::binary_path("agentdashboard");
    assert!(
        text.contains(&format!("フックの入口={}", entry.display())),
        "入れる側が置いた入口を渡していません:\n{text}"
    );
    assert!(
        text.contains("印=1"),
        "二度乗り換えない印がありません:\n{text}"
    );
}

#[test]
fn フックの入口が既に指定されていれば上書きしない() {
    let fixture = Fixture::new("hook-bin-kept");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let mut command = testkit::binary_command("agentdashboard");
    let out = command
        .env_remove(VERSION_HANDOVER_ENV)
        .env(VERSION_SUPPORTED_ENV, "0")
        .env("AGENTDASHBOARD_HOOK_BIN", "/決め打ちの入口")
        .arg("--config")
        .arg(fixture.config_that_cannot_start())
        .output()
        .expect("起こせること");
    let text = text_of(&out);

    assert!(
        text.contains("フックの入口=/決め打ちの入口"),
        "統合テストが指定した入口を上書きしています:\n{text}"
    );
}

// ---------------------------------------------------------------------------
// 起動試行の印（設計§11）
// ---------------------------------------------------------------------------

#[test]
fn 印が残っていたらポインタを無視して自分で続ける() {
    // 待ち受けを確保する前に落ちた版を選び続けると、**二度と起動しなくなる**
    let fixture = Fixture::new("poisoned");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);
    agent_core::version::write_attempt(&fixture.state_dir(), &target);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    let text = text_of(&out);

    assert!(
        !text.contains(MARKER),
        "毒と分かっているポインタで乗り換えています:\n{text}"
    );
    assert!(
        text.contains("待ち受けまで届きませんでした"),
        "無視した理由を伝えていません:\n{text}"
    );

    // 無視したことは**状態として残る**（知らせでは、繋ぐ前に流れたぶんが届かない）
    let outcome =
        agent_core::version::read_outcome(&fixture.state_dir()).expect("結末が残っていること");
    assert_eq!(outcome.attempted_path, target.display().to_string());
    assert!(outcome.failed_reason.is_some());

    // **印は取り出したら消える。** 残ると、直したあとも永久に無視され続ける
    assert!(
        !agent_core::version::attempt_path(&fixture.state_dir()).exists(),
        "印が残っています"
    );
}

#[test]
fn 乗り換える直前に印が書かれる() {
    let fixture = Fixture::new("attempt-written");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    assert!(text_of(&out).contains(MARKER));

    // 行き先は待ち受けを確保しないまま終わるので、印は残ったまま
    assert!(
        agent_core::version::attempt_path(&fixture.state_dir()).exists(),
        "乗り換えたのに印が書かれていません"
    );
}

// ---------------------------------------------------------------------------
// 自己修復との折り合い（設計§17・§20-4）
// ---------------------------------------------------------------------------

#[test]
fn 乗り換えると自己修復のポインタと戻す先が落ちる() {
    // 差し替え済みのパーサは古いソースからビルドされている。**探索順ではあちらが勝つ**
    // ので、外さないと版を切り替えても食い違ったパーサが起動する
    let fixture = Fixture::new("selfheal");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let state_dir = fixture.state_dir();
    let parser = fixture.dir.join("差し替えたパーサ");
    std::fs::write(&parser, b"x").expect("書けること");
    std::fs::write(
        state_dir.join(agent_core::parser::PARSER_POINTER),
        parser.to_string_lossy().as_bytes(),
    )
    .expect("書けること");
    let mut selfheal = agent_core::selfheal::state::SelfhealState::load(&state_dir);
    selfheal.previous_parser = Some(parser.clone());
    selfheal.save(&state_dir);

    let out = fixture.run_with_config(&fixture.config_that_cannot_start(), &[]);
    assert!(text_of(&out).contains(MARKER));

    assert!(
        !state_dir.join(agent_core::parser::PARSER_POINTER).exists(),
        "自己修復のポインタが残っています"
    );
    assert_eq!(
        agent_core::selfheal::state::SelfhealState::load(&state_dir).previous_parser,
        None,
        "版をまたいで生き残ると、前の版が作ったパーサへ戻してしまう"
    );
}

// ---------------------------------------------------------------------------
// 設定が壊れているとき（設計§4、テスト計画フェーズ1 前提3）
// ---------------------------------------------------------------------------

#[test]
fn 設定が壊れていても判定は通り乗り換えないほうへ倒れる() {
    // 判定を設定の読み込みより後ろに置くと袋小路ができる——新しい版が増やしたキーを
    // 書いた利用者が古い版を選ぶと、古い版は知らないキーで起動を拒み、**新しい版へ
    // 戻ることもできなくなる**。だから判定は通す。
    //
    // ただし壊れた設定からは `state_dir` を読めないので、**移した先のポインタは
    // 見えない**。取り違えは「乗り換えないほうへ倒れる」——これを固定する
    let fixture = Fixture::new("broken-config");
    let target = fixture.write_marker_version("0.9.9");
    fixture.point_at(&target);

    let broken = fixture.dir.join("broken.toml");
    std::fs::write(
        &broken,
        format!(
            "state_dir = \"{}\"\nこの版が知らないキー = 1\n",
            fixture.state_dir().display()
        ),
    )
    .expect("書けること");

    let out = fixture.run_with_config(&broken, &[]);
    let text = text_of(&out);

    assert!(
        !text.contains(MARKER),
        "壊れた設定から読めないはずの場所のポインタで乗り換えています:\n{text}"
    );
    assert!(
        text.contains("設定ファイルの書式が不正です"),
        "判定を通したあと、設定の失敗で終わるはずです:\n{text}"
    );
    assert!(!out.status.success(), "設定が壊れているのに成功しています");
}

// ---------------------------------------------------------------------------
// 実バイナリどうしの通し（設計§11、テスト計画フェーズ1 前提2・6）
// ---------------------------------------------------------------------------

#[test]
fn 乗り換えた先が待ち受けまで届くと印は結末へ変わる() {
    // ここだけ本物どうしで繋ぐ。**`current_exe()` が保管庫の版フォルダを指すこと**
    // （前提6）と、印の一生（書く→消える→結末になる）を実物で確かめる。
    //
    // 版フォルダは**ハードリンク**で作る。素直にコピーすると1版あたり数十MB になり、
    // `canonicalize` はハードリンクを解決しないので実パスの比較はそのまま成立する
    // （symlink だと同じパスへ潰れて乗り換えが起きない）
    let fixture = Fixture::beside_binaries("real-handover");
    let state_dir = fixture.state_dir();
    let stored = state_dir.join(VERSIONS_DIR_NAME).join("9.9.9");
    std::fs::create_dir_all(&stored).expect("保管庫を作れること");
    for name in agent_core::version::BINARIES {
        std::fs::hard_link(testkit::binary_path(name), stored.join(name))
            .expect("ハードリンクを張れること");
    }
    let target = stored.join("agentdashboard");
    fixture.point_at(&target);

    let port = free_port();
    let config = fixture.write_config(
        &format!("sqlite://{}", fixture.dir.join("dashboard.db").display()),
        port,
    );

    let log = fixture.dir.join("server.log");
    let mut child = testkit::binary_command("agentdashboard")
        .env_remove(VERSION_HANDOVER_ENV)
        .env(VERSION_SUPPORTED_ENV, "0")
        .env(
            agent_core::session::lifecycle::CLAUDE_BIN_ENV,
            testkit::fake_claude::path(),
        )
        .arg("--config")
        .arg(&config)
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&log).expect("ログを作れること"))
        .spawn()
        .expect("起こせること");

    let started = wait_until(|| {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
            && !agent_core::version::attempt_path(&state_dir).exists()
    });
    let printed = std::fs::read_to_string(&log).unwrap_or_default();
    let _ = child.kill();
    let _ = child.wait();
    assert!(started, "待ち受けまで届きませんでした:\n{printed}");

    // 前提6：起動した実行ファイルが保管庫の版フォルダを指している
    assert!(
        printed.contains(&target.display().to_string()),
        "乗り換えた先の実行ファイルを名乗っていません:\n{printed}"
    );
    // 印は結末へ変わる。**失敗の記録が残り続けない**
    let outcome = agent_core::version::read_outcome(&state_dir).expect("結末が残っていること");
    assert_eq!(outcome.failed_reason, None, "成功として残ること");
    assert_eq!(outcome.attempted_path, target.display().to_string());
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
    listener.local_addr().expect("番号を読めること").port()
}

fn wait_until(mut check: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + TIMEOUT;
    while std::time::Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

// ---------------------------------------------------------------------------
// 行き先に聞く門（設計§9）

/// 3つの問いに答えるだけの偽の行き先を置く。`args` を記録するので、何を渡したかも見られる。
fn write_gate_target(dir: &Path, name: &str, script: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, script).unwrap();
    make_executable(&path);
    path
}

#[test]
fn 門は行き先の三つの問いに答えを得る() {
    // 本物の実行ファイルは3つとも答えられる。**サブコマンドなので乗り換えない**
    let target = testkit::binary_path("agentdashboard");
    let answers = agentdashboard_core::gate::ask(&target, None).expect("聞けること");
    let names = answers.schema_names.expect("形の一覧が読めること");
    assert!(!names.is_empty(), "1つも並んでいない");
}

#[test]
fn 形を答えられない行き先は断らずに通す() {
    // この機能より前の版は `migrations` を知らない。断ると、いちばん戻りたい先へ
    // 永久に戻れなくなる
    let fixture = Fixture::new("gate-old");
    let old = write_gate_target(
        &fixture.dir,
        "agentdashboard",
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'agentdashboard 0.1.0' ;;\n  config) echo 'port = 8787' ;;\n  *) echo 'error: unrecognized subcommand' >&2; exit 2 ;;\nesac\n",
    );

    let answers = agentdashboard_core::gate::ask(&old, None).expect("起動と設定には答えられる");
    assert_eq!(answers.schema_names, None, "目印が無いので読めない");
    assert!(
        matches!(
            agentdashboard_core::gate::judge(&answers, &["m1_init".to_string()]),
            agentdashboard_core::gate::Verdict::Unverified { .. }
        ),
        "断ってしまっている"
    );
}

#[test]
fn 起動できない行き先は断る() {
    let fixture = Fixture::new("gate-dead");
    let dead = write_gate_target(
        &fixture.dir,
        "agentdashboard",
        "#!/bin/sh\necho 'そんなライブラリはありません' >&2\nexit 127\n",
    );

    let refused = agentdashboard_core::gate::ask(&dead, None).expect_err("通してしまった");
    assert!(refused.contains("起動できません"), "理由: {refused}");
    assert!(refused.contains("ライブラリ"), "行き先の言い分を混ぜる: {refused}");
}

#[test]
fn 設定を読めない行き先は断る() {
    // 新しい版が増やしたキーが書かれていると、古い版は知らないキーで起動を拒む
    let fixture = Fixture::new("gate-config");
    let picky = write_gate_target(
        &fixture.dir,
        "agentdashboard",
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'agentdashboard 0.1.0' ;;\n  *) echo '設定ファイルの書式が不正です' >&2; exit 1 ;;\nesac\n",
    );

    let refused = agentdashboard_core::gate::ask(&picky, None).expect_err("通してしまった");
    assert!(refused.contains("設定を読めません"), "理由: {refused}");
}

#[test]
fn 親が設定を受け取っていなければ行き先にも渡さない() {
    // 常に渡すと、設定ファイルを置いていない利用者を「設定が壊れている」と誤判定する
    // （`--config` 無しの起動は、カレントに設定が無くても空の設定として成功する）
    let fixture = Fixture::new("gate-args");
    let recorded = fixture.dir.join("見た引数");
    let target = write_gate_target(
        &fixture.dir,
        "agentdashboard",
        &format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\ncase \"$1\" in\n  --version) echo 'agentdashboard 0.1.0' ;;\n  *) echo 'ok' ;;\nesac\n",
            recorded.display()
        ),
    );

    agentdashboard_core::gate::ask(&target, None).expect("聞けること");
    let seen = std::fs::read_to_string(&recorded).unwrap();
    assert!(
        !seen.contains("--config"),
        "渡していないのに渡している:\n{seen}"
    );

    std::fs::remove_file(&recorded).unwrap();
    let config = fixture.dir.join("config.toml");
    agentdashboard_core::gate::ask(&target, Some(&config)).expect("聞けること");
    let seen = std::fs::read_to_string(&recorded).unwrap();
    assert!(
        seen.contains("--config"),
        "受け取ったのに渡していない:\n{seen}"
    );
}
