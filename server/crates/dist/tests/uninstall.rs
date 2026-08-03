//! 消す道が壊れていないことの機械検査（設計§27／テスト計画F8）。
//!
//! # なぜここまでやるのか
//!
//! アンインストールは**壊れていても、消そうとした人以外には何も起きない**。
//! 入れる側は使うたびに通るので壊れれば気づくが、こちらは誰も通らないまま腐る。
//! しかも腐り方は「消えない」だけでなく「**消してはいけないものを消す**」もありうる。
//!
//! だから読むだけの検査では足りない。**偽のインストール一式を作って、実際に
//! スクリプトを走らせ、残ったものを数える。**
//!
//! # 置き場所は実装から引く
//!
//! 「入れる側だけ直して消す側が取り残される」が、いちばん起きやすい壊れ方。
//! そこで記録の置き場所は [`agentdashboard_core::Config`] から、入れる場所は
//! `dist-workspace.toml` から取って、スクリプトと突き合わせる。**片方を直したら
//! もう片方が落ちる**形にしてある。

use std::path::PathBuf;
use std::process::Command;

mod common;
use common::{BINARIES, FakeHome, repo_root};

/// 同じ `bin` に居る他人の道具。**巻き添えにしていないこと**を見るために置く。
const OTHER_TOOL: &str = "ripgrep";

/// インストーラが PATH を通すために1行書き足すシェルの設定。
///
/// **顔ぶれは生成されるインストーラから写している。** あちらは `.profile` に加えて
/// 存在する `.bashrc` `.bash_profile` `.bash_login` の**全部**と、`.zshrc` `.zshenv` の
/// 先頭にあるものへ書く。ここが実物より少ないと、**案内に出てこないファイルへ行が残る**
/// ——利用者は案内どおり掃除したのに、シェルを開くたびにエラーが出ることになる。
const RCFILES: &[&str] = &[
    ".profile",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".zshrc",
    ".zshenv",
];

/// fish にだけ**新規に作られる**設定ファイル。
///
/// 他のシェルは既存のファイルへ1行足すだけだが、fish はこのファイルごと作られる。
/// **名前がアプリ名そのもの**なので「他のツールと共有だから触らない」が当てはまらず、
/// 残すと**消えた `env.fish` を読み続けて fish が毎回エラーを出す**。
const FISH_CONF: &str = ".config/fish/conf.d/agentdashboard.env.fish";

#[test]
fn 既定では実行ファイルと控えだけが消える() {
    let home = fake_install("default");

    let out = run(&home, &[]);

    for binary in BINARIES {
        assert!(
            !home.join(".local/bin").join(binary).exists(),
            "{binary} が残っています:\n{out}"
        );
    }
    assert!(
        !home
            .join(".config/agentdashboard/agentdashboard-receipt.json")
            .exists(),
        "控えが残っています:\n{out}"
    );

    // **記録は残す。** 消すと一覧と履歴が戻せないので、明示しない限り触らない
    assert!(
        home.join(".local/state/agentdashboard/dashboard.db")
            .exists(),
        "記録まで消えています（既定では残すこと）:\n{out}"
    );

    // **入れる側が作ったアプリ専用のファイルは、消す側も消す。** 残すと、手順書どおりに
    // `env.fish` を消した fish 利用者は、起動のたびにエラーを見ることになる
    assert!(
        !home.join(FISH_CONF).exists(),
        "fish の設定（アプリ専用）が残っています:\n{out}"
    );
}

#[test]
fn 他人の道具と共有の設定を巻き添えにしない() {
    // `~/.local/bin` は cargo-dist で入れた**全部のツールが同居する場所**。
    // ここを雑に消すと、関係の無い道具が消える
    let home = fake_install("bystander");

    let out = run(&home, &[]);

    assert!(
        home.join(".local/bin").join(OTHER_TOOL).exists(),
        "他人の道具を消しています:\n{out}"
    );
    // `env` と rcfile の1行も共有物。**触らない**と決めてある
    assert!(
        home.join(".local/bin/env").exists(),
        "共有の env を消しています:\n{out}"
    );
    let profile = std::fs::read_to_string(home.join(".profile")).expect("読めること");
    assert!(
        profile.contains(".local/bin/env"),
        "シェルの設定から行を消しています:\n{out}"
    );
}

#[test]
fn インストーラが書く設定ファイルをどれも触らない() {
    // `.profile` だけを見ていると、**他のファイルを消す実装になっても緑のまま**になる。
    // インストーラが書き足す顔ぶれを全部置いて、1つも減っていないことを見る。
    //
    // あわせて、**案内文にその顔ぶれが並んでいる**ことも見る。「等」で濁すと、
    // そこに出ていないファイルを使っている人は掃除しきれない
    let home = fake_install("rcfiles");

    let out = run(&home, &[]);

    for rcfile in RCFILES {
        let text = std::fs::read_to_string(home.join(rcfile))
            .unwrap_or_else(|err| panic!("{rcfile} を読めること: {err}\n{out}"));
        assert!(
            text.contains(".local/bin/env"),
            "{rcfile} から行を消しています:\n{out}"
        );
        assert!(
            out.contains(rcfile),
            "触っていないものの案内に {rcfile} が並んでいません:\n{out}"
        );
    }
}

#[test]
fn 控えが別の場所を指していても既定の場所も掃く() {
    // 控えは**読めるとは限らず、正しいとも限らない**。別の場所へ入れ直したあとに
    // 控えの書き込みが失敗すると、控えは古い場所を指したまま残る。
    //
    // そこで既定の場所を見なくすると、**3本が生き残ったまま「もう消えている」と
    // 表示される**。利用者は消えたと信じて、PATH 上に古いものを残すことになる
    let home = fake_install("both-dirs");

    // 控えを、既定とは別の場所へ向け直す（そちらにも実体を置く）
    let elsewhere = home.join("opt/tools");
    std::fs::create_dir_all(&elsewhere).expect("作れること");
    for binary in BINARIES {
        std::fs::write(elsewhere.join(binary), "x").expect("書けること");
    }
    std::fs::write(
        home.join(".config/agentdashboard/agentdashboard-receipt.json"),
        format!(
            r#"{{"binaries":["agentdashboard"],"install_prefix":"{}","version":"0.1.0"}}"#,
            elsewhere.display()
        ),
    )
    .expect("書けること");

    let out = run(&home, &[]);

    for binary in BINARIES {
        assert!(
            !elsewhere.join(binary).exists(),
            "控えが指す場所の {binary} が残っています:\n{out}"
        );
        assert!(
            !home.join(".local/bin").join(binary).exists(),
            "既定の場所の {binary} が残っています（控えの場所しか見ていない）:\n{out}"
        );
    }
    // 既定の場所にある他人の道具は、もちろん無事
    assert!(
        home.join(".local/bin").join(OTHER_TOOL).exists(),
        "他人の道具を消しています:\n{out}"
    );
}

#[test]
fn purgeを付けると記録も消える() {
    let home = fake_install("purge");

    let out = run(&home, &["--purge"]);

    assert!(
        !home.join(".local/state/agentdashboard").exists(),
        "--purge なのに記録が残っています:\n{out}"
    );
}

#[test]
fn dry_runでは何も消えない() {
    // 消す前に確かめたい人のための道。**ここが嘘をつくと、確かめた意味が無くなる**
    let home = fake_install("dry");

    let out = run(&home, &["--dry-run", "--purge"]);

    for binary in BINARIES {
        assert!(
            home.join(".local/bin").join(binary).exists(),
            "--dry-run なのに {binary} が消えています:\n{out}"
        );
    }
    assert!(
        home.join(".local/state/agentdashboard").exists(),
        "--dry-run なのに記録が消えています:\n{out}"
    );
}

#[test]
fn 控えに書かれた場所から消す() {
    // 既定と違う場所へ入れた人にも効かせる。**控えを無視して既定だけ見ると、
    // その人の実行ファイルは永久に残る**
    let home = fake_install("receipt");
    let elsewhere = home.join("opt/tools");
    std::fs::create_dir_all(&elsewhere).expect("作れること");
    for binary in BINARIES {
        std::fs::write(elsewhere.join(binary), "x").expect("書けること");
    }
    std::fs::write(
        home.join(".config/agentdashboard/agentdashboard-receipt.json"),
        format!(
            r#"{{"binaries":["agentdashboard"],"install_prefix":"{}","version":"0.1.0"}}"#,
            elsewhere.display()
        ),
    )
    .expect("書けること");

    let out = run(&home, &[]);

    for binary in BINARIES {
        assert!(
            !elsewhere.join(binary).exists(),
            "控えの場所の {binary} が残っています:\n{out}"
        );
    }
}

#[test]
fn 記録の置き場所が実装と食い違っていない() {
    // **ここが門。** 実装の既定を変えてこちらを直し忘れると、消したつもりで
    // 記録だけが残る。症状は出ないので、機械で見るしかない
    let home = fake_install("state-agrees");

    // 実装の既定を、この HOME のもとで求める。**写しを作らない**——
    // 「実装がどこを既定にしているか」を確かめるのが検査の中身なので
    let expected = home.resolved_state_dir();

    // 消す対象として名指しされることを、`--dry-run --purge` の出力で見る
    let out = run(&home, &["--dry-run", "--purge"]);
    assert!(
        out.contains(&expected.display().to_string()),
        "スクリプトが実装の既定（{}）を消す対象にしていません:\n{out}",
        expected.display()
    );
}

#[test]
fn 入れる場所の既定が配布設定と食い違っていない() {
    // `dist-workspace.toml` の `install-path` を変えると、入れる場所が変わる。
    // そのときスクリプトの既定が取り残されると、**控えの無い人の実行ファイルが残る**
    let configured = read_install_path();
    let script = script_text("uninstall.sh");
    let expected = configured.replace('~', "${HOME}");
    assert!(
        script.contains(&format!("DEFAULT_INSTALL_DIR=\"{expected}\"")),
        "配布設定の install-path（{configured}）と、消す側の既定が違います"
    );
}

#[test]
fn 配る実行ファイルの顔ぶれが一致している() {
    // 4本目が増えたのに消す側が3本のままだと、1本だけ残る
    let script = script_text("uninstall.sh");
    let line = script
        .lines()
        .find(|line| line.starts_with("BINARIES="))
        .expect("BINARIES の行があること");
    for binary in BINARIES {
        assert!(
            line.contains(binary),
            "消す側に {binary} がありません: {line}"
        );
    }

    let windows = script_text("uninstall.ps1");
    for binary in BINARIES {
        assert!(
            windows.contains(&format!("{binary}.exe")),
            "Windows 版に {binary} がありません"
        );
    }
}

#[test]
fn windows版が同じ場所を名指ししている() {
    // Windows 版は CI で走らせられない。せめて**同じ場所を見ていること**は確かめる
    let windows = script_text("uninstall.ps1");
    // 控えの名前は組み立てて作るので、**両方の断片**が居ることを見る。
    // 完成形だけを探すと、組み立て方を変えただけで落ちる（守りたいのはそこではない）
    for fragment in [
        ".local\\bin",
        "-receipt.json",
        "$AppName = 'agentdashboard'",
    ] {
        assert!(
            windows.contains(fragment),
            "Windows 版が {fragment} を名指ししていません"
        );
    }
    // 既定で記録を消さない約束も、両方で守られていること
    assert!(
        windows.contains("$Purge"),
        "Windows 版に記録を消すための明示の指定がありません"
    );
}

#[test]
fn 控えの組み立て方が実装の部品と食い違っていない() {
    // **ここが Windows 版の門。** 以前は「`.local\state` という字が入っているか」しか
    // 見ておらず、実装と食い違っても緑のまま通った。実際に食い違っていた——
    // **Windows に `HOME` は無い**ので実装は一時領域を使っていたのに、消す側は
    // `$HOME\.local\state` を消しに行っていた（`-Purge` が1バイトも消さない）。
    //
    // いまは実行ファイルへ聞くので、この控えが使われるのは**聞けなかったときだけ**。
    // それでも食い違えば同じことが起きるので、**実装が公開している部品**と突き合わせる。
    // 実装側を直してこちらを直し忘れたら、ここで落ちる。
    use agent_core::config::{
        STATE_DIR_NAME, STATE_HOME_ENV, STATE_HOME_ENV_WINDOWS, STATE_HOME_RELATIVE,
    };

    // **控えを組み立てている場所だけを見る。** ファイル全体を見ると、控え（receipt）の
    // 置き場所で使っている `LOCALAPPDATA` を拾ってしまい、**記録の側から抜けても
    // 緑のまま通る**（実際に、範囲を絞る前はそうなっていた）
    let unix = fallback_block(&script_text("uninstall.sh"), "STATE_DIR_FALLBACK=");
    let windows = fallback_block(&script_text("uninstall.ps1"), "$StateDirFallback =");

    // Unix 側：`XDG_STATE_HOME` を優先し、無ければ `HOME` からの相対
    for part in [STATE_HOME_ENV, STATE_HOME_RELATIVE] {
        assert!(
            unix.contains(part),
            "消す側（sh）の控えが実装の部品 {part} を使っていません:\n{unix}"
        );
    }
    // Windows 側：`HOME` が無いので `LOCALAPPDATA` が要る。**ここが抜けると一時領域と
    // 食い違う**
    for part in [STATE_HOME_ENV, STATE_HOME_ENV_WINDOWS] {
        assert!(
            windows.contains(part),
            "消す側（ps1）の控えが実装の部品 {part} を使っていません:\n{windows}"
        );
    }

    // フォルダの名前は、どちらも変数で持っている。**その変数が実装の名前を指している**
    // ことを見る（控えの中では `${APP_NAME}` としか書かれない）
    assert!(
        script_text("uninstall.sh").contains(&format!("APP_NAME=\"{STATE_DIR_NAME}\"")),
        "消す側（sh）のフォルダ名が実装（{STATE_DIR_NAME}）と違います"
    );
    assert!(
        script_text("uninstall.ps1").contains(&format!("$AppName = '{STATE_DIR_NAME}'")),
        "消す側（ps1）のフォルダ名が実装（{STATE_DIR_NAME}）と違います"
    );
    for (label, block) in [("sh", &unix), ("ps1", &windows)] {
        assert!(
            block.to_lowercase().contains("app_name") || block.contains("AppName"),
            "消す側（{label}）の控えがフォルダ名の変数を使っていません:\n{block}"
        );
    }
}

/// 控えを組み立てている塊だけを切り出す。
///
/// 始まりの行から、**空行が来るまで**。どちらのスクリプトも代入の直後に空行を置く形で
/// 書いてあるので、これで1つの塊になる。
fn fallback_block(script: &str, starts_with: &str) -> String {
    let mut lines = script
        .lines()
        .skip_while(|line| !line.trim_start().starts_with(starts_with))
        .peekable();
    assert!(
        lines.peek().is_some(),
        "控えの組み立て（{starts_with}）が見つかりません"
    );
    lines
        .take_while(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn 置き場所は実行ファイルに聞く() {
    // **設定や環境変数で置き場所を変えた人**は、控えの組み立てでは拾えない。
    // 自分で組み立てていたときは既定しか見ておらず、変えた人の記録は
    // **「完了しました」と言いながら残っていた**。
    //
    // 実行ファイルへ聞く形になっていることを、**答えを差し替えて**確かめる。
    let home = fake_install("asks-binary");
    let answer = home.join("どこか/別の場所");
    std::fs::create_dir_all(&answer).expect("作れること");

    // 本物と同じ場所に、`state-dir` へ決まった答えを返す偽物を置く
    let fake = home.join(".local/bin/agentdashboard");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\n[ \"$1\" = state-dir ] && printf '%s\\n' '{}'\n",
            answer.display()
        ),
    )
    .expect("書けること");
    make_executable(&fake);

    let out = run(&home, &["--dry-run", "--purge"]);

    assert!(
        out.contains(&answer.display().to_string()),
        "実行ファイルに聞いた場所を消す対象にしていません:\n{out}"
    );
    // 聞けたのに既定を消しに行っていないこと。**両方を消すと、聞く意味が無い**
    assert!(
        !out.contains(&home.resolved_state_dir().display().to_string()),
        "実行ファイルに聞けたのに、既定の場所も消そうとしています:\n{out}"
    );
}

#[test]
fn 実行ファイルに聞けないときは既定へ落ちてそう言う() {
    // **黙って既定を消しに行かない。** 設定で置き場所を変えていた人が、
    // 「消えたはず」と思い込まないようにする
    let home = fake_install("falls-back");

    let out = run(&home, &["--dry-run", "--purge"]);

    assert!(
        out.contains(&home.resolved_state_dir().display().to_string()),
        "既定へ落ちていません:\n{out}"
    );
    assert!(
        out.contains("聞けない"),
        "聞けなかったことを言っていません:\n{out}"
    );
}

#[test]
fn state_dirは実装の解決とそのまま一致する() {
    // 聞かれる側の門。**印字が実装とずれたら、消す側は静かに別の場所を消す**
    let home = FakeHome::new("state-dir-cmd");
    // `FakeHome::new` は**場所を決めるだけ**で作らない。作業場所として渡すので、ここで作る
    std::fs::create_dir_all(home.path()).expect("作れること");
    let expected = home.resolved_state_dir();

    let output = Command::new(env!("CARGO_BIN_EXE_agentdashboard"))
        .arg("state-dir")
        .env("HOME", home.path())
        .env_remove("XDG_STATE_HOME")
        // **設定ファイルを拾わせない。** リポジトリで走らせるとカレントの
        // `config.toml` が効いてしまい、見たいもの（既定の解決）がずれる
        .current_dir(home.path())
        .output()
        .expect("state-dir を動かせること");

    assert!(output.status.success(), "state-dir が失敗しました");
    let printed = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        printed.trim(),
        expected.display().to_string(),
        "印字と実装の解決が食い違っています"
    );
    // **1行だけ**。スクリプトは先頭行を値として読む
    assert_eq!(printed.lines().count(), 1, "1行だけを印字していません");
}

/// 偽の実行ファイルへ実行権を付ける。
fn make_executable(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("付けられること");
    }
}

/// 偽のインストール一式を作る。
fn fake_install(label: &str) -> FakeHome {
    let home = FakeHome::new(label);

    let bin = home.join(".local/bin");
    let receipt_dir = home.join(".config/agentdashboard");
    let state = home.join(".local/state/agentdashboard");
    for dir in [&bin, &receipt_dir, &state] {
        std::fs::create_dir_all(dir).expect("作れること");
    }

    for binary in BINARIES {
        std::fs::write(bin.join(binary), "x").expect("書けること");
    }
    // 巻き添えを見るための、関係の無いもの
    std::fs::write(bin.join(OTHER_TOOL), "x").expect("書けること");
    std::fs::write(bin.join("env"), "# 共有").expect("書けること");
    // インストーラが書き足す**全部**を置く。1つだけ置くと、他を消す実装になっても気づけない
    for rcfile in RCFILES {
        std::fs::write(home.join(rcfile), ". \"$HOME/.local/bin/env\"\n").expect("書けること");
    }
    // fish だけは**ファイルごと作られる**（他は既存へ1行足すだけ）
    let fish_conf = home.join(FISH_CONF);
    std::fs::create_dir_all(fish_conf.parent().expect("親があること")).expect("作れること");
    std::fs::write(&fish_conf, ". \"$HOME/.local/bin/env.fish\"\n").expect("書けること");

    std::fs::write(
        receipt_dir.join("agentdashboard-receipt.json"),
        format!(
            r#"{{"binaries":["agentdashboard"],"install_prefix":"{}","version":"0.1.0"}}"#,
            bin.display()
        ),
    )
    .expect("書けること");
    std::fs::write(state.join("dashboard.db"), "db").expect("書けること");

    home
}

/// スクリプトを、その HOME のもとで走らせる。
fn run(home: &FakeHome, args: &[&str]) -> String {
    let output = Command::new("sh")
        .arg(script_path("uninstall.sh"))
        .args(args)
        // **利用者の本物の HOME を絶対に渡さない。** テストが壊れたときに
        // 自分の環境が巻き添えになる経路を、そもそも作らない
        .env("HOME", home.path())
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_STATE_HOME")
        .output()
        .expect("sh を実行できること");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "スクリプトが失敗しました:\n{text}");
    text
}

fn script_path(name: &str) -> PathBuf {
    repo_root().join("scripts").join(name)
}

fn script_text(name: &str) -> String {
    std::fs::read_to_string(script_path(name)).expect("スクリプトを読めること")
}

/// `dist-workspace.toml` の `install-path`。
fn read_install_path() -> String {
    let text = std::fs::read_to_string(repo_root().join("dist-workspace.toml"))
        .expect("配布設定を読めること");
    text.lines()
        .find_map(|line| {
            let rest = line.strip_prefix("install-path")?;
            let value = rest.split('"').nth(1)?;
            Some(value.to_string())
        })
        .expect("install-path があること")
}
