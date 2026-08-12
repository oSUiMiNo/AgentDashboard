//! 本物の TUI の画面を採る（ローカルイシュー「送信以外の操作も Ctrl+Enter になっている」
//! テスト計画フェーズ1）。
//!
//! # 何のために在るか
//!
//! ブラウザの Enter を「改行」と「確定」で振り分けるには、**いま選択ダイアログが出ているか**
//! を画面から見分ける必要がある（同イシュー設計§4）。その目印を推測で決めると、実物に
//! 当たらないか、当たってはいけない画面にまで当たる。だから**実物の画面を1度だけ採って**、
//! それを判定の材料にする。
//!
//! 採るのは5種。前の3つが「選択待ち」、後ろの2つは**当たってはいけない側**の材料である。
//!
//! | ファイル | 何の画面か |
//! |---|---|
//! | `trust.txt` | フォルダ信頼の確認 |
//! | `permission.txt` | 権限確認 |
//! | `rewind.txt` | `/rewind` のメニュー |
//! | `welcome.txt` | 起動直後（**What's new に `trust` の語が出る**ことがある） |
//! | `after-turn.txt` | 普通に会話しているだけの画面 |
//!
//! # 実行方法
//!
//! ```text
//! make capture-screens
//! ```
//!
//! `#[ignore]` を付けてあるうえ、**`make test-cli` の通しには入らない**（あちらは
//! `--test real_cli` で対象を絞っている）。採取は一度きりで足りるので、通しのたびに
//! クォータを使わせない。
//!
//! # 置き場所
//!
//! 既定は**リポジトリの外**（一時ディレクトリ）。`AGENTDASHBOARD_SCREEN_CAPTURE_DIR` で
//! 変えられる。**匿名化と残存検査を通ったものだけを `fixtures/` へ置く**——本リポジトリは
//! 公開で、claude の TUI は起動直後の枠にログイン中のアカウントを出す（PJTガイドライン）。

mod common;

use agentdashboard_core::client;
use agentdashboard_core::config::Config;
use protocol::SessionStatus;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::Instant;

/// 本物の CLI は考える時間があるので長めに待つ。（出所：`tests/real_cli.rs`）
const CLI_TIMEOUT: Duration = Duration::from_secs(180);

/// 画面を採る大きさ。`session screen` の既定と揃える（CLI設計§9-1）。
const COLS: u16 = 120;
const ROWS: u16 = 40;

// ---------------------------------------------------------------------------
// ここから4つは `tests/real_cli.rs` からの写し。
//
// 統合テストのバイナリどうしは import できないので写すしかない。**削らずそのまま写す**
// ——「最小限」へ削ると、削った部分が実は要件だったときに写した先だけが壊れ、原因が元との
// 差分を見るまで分からない（PJTガイドライン）。元が変わったらこちらも直す。
// ---------------------------------------------------------------------------

/// 使い捨ての作業ディレクトリ。テストが終わったら丸ごと消す。（出所：`tests/real_cli.rs`）
struct WorkDir(PathBuf);

impl WorkDir {
    fn new(name: &str) -> Self {
        // **親を差し替えられるようにしてある。** claude はフォルダ単位で信頼を覚えるが
        // （`~/.claude.json` の `hasTrustDialogAccepted`）、`/tmp` 配下では新しい名前でも
        // 信頼の確認が出ないことを実測した。あの画面を採りたいときは、この環境変数で
        // ホーム配下など別の場所を指す。
        let root = std::env::var("AGENTDASHBOARD_SCREEN_CAPTURE_WORKROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("agentdashboard-screen-capture"));
        let path = root.join(format!("{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path).expect("作業ディレクトリを作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn as_str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        // 落ちたときは消さない。中身を読みに行くため（出所：`tests/real_cli.rs`）
        if std::thread::panicking() {
            eprintln!(
                "落ちたので作業ディレクトリを残します（調べるならここ）: {}",
                self.0.display()
            );
            return;
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 権限確認が必ず出るようにした claude を起動するラッパー。（出所：`tests/real_cli.rs`）
fn claude_wrapper(dir: &WorkDir, extra: &[&str]) -> PathBuf {
    let path = dir.path().join("claude-wrapper.sh");
    let args = extra.join(" ");
    std::fs::write(&path, format!("#!/bin/sh\nexec claude {args} \"$@\"\n"))
        .expect("ラッパーを書き出せること");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("実行権限を付けられること");
    }
    path
}

/// `session screen` 相当でいまの画面をテキストにする。（出所：`tests/real_cli.rs`）
///
/// **ここが要点**：`render_screen` は vt100 を通すので、返るのは**レンダリング済みの画面**
/// ——ブラウザの xterm がバッファに持っているものと同じ性質のテキストになる（設計§2）。
/// だから採ったものがそのまま web 側の判定の材料になる。
async fn cli_screen_text(target: &client::Target, prefix: &str) -> String {
    let shot = client::screen(target, prefix, COLS, ROWS)
        .await
        .expect("画面を受け取れること");
    client::render::render_screen(&shot.payload, shot.rows, shot.cols)
}

/// CLI の一覧でカードが目的の形になるまで待つ。（出所：`tests/real_cli.rs`）
async fn wait_via_cli(
    target: &client::Target,
    card: &str,
    what: &str,
    matches: impl Fn(&protocol::SessionMeta) -> bool,
) -> protocol::SessionMeta {
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let (list, _) = client::sessions(target).await.expect("一覧を引けること");
        if let Some(meta) = list
            .iter()
            .find(|meta| meta.card_id.to_string() == card)
            .filter(|meta| matches(meta))
        {
            return meta.clone();
        }
        if Instant::now() >= deadline {
            let screen = cli_screen_text(target, &card[..8]).await;
            panic!("{CLI_TIMEOUT:?} 以内に {what} になりませんでした。実際の画面:\n{screen}");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// 指示を送る前に、画面が落ち着くまで待つ。（出所：`tests/real_cli.rs`）
async fn wait_screen_settled(target: &client::Target, prefix: &str) -> String {
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut previous = String::new();
    loop {
        let text = cli_screen_text(target, prefix).await;
        if !previous.is_empty() && text == previous && text.contains("❯") {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に画面が落ち着きませんでした: {text}"
        );
        previous = text;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

// ---------------------------------------------------------------------------
// ここからが採取そのもの
// ---------------------------------------------------------------------------

/// フォルダ信頼の確認を見分ける目印。
///
/// **`do you trust` では当たらない。** 実物の文言は
/// `Quick safety check: Is this a project you created or one you trust?` で、
/// `do you trust` という並びはどこにも無い（v2.1.228 で実測）。`real_cli.rs` はその綴りで
/// 照合しているので、**信頼済みのフォルダで走る限り素通りしていた**。
///
/// ここでは `session/selfheal` が実績を持っている綴り（`trust this folder`）を採り、
/// 問いかけの側（`one you trust`）も併せ持つ。**複数持ち、どれか1つでも当たれば**という
/// 作法（設計§4）は、この族の照合そのものに要る。
const TRUST_MARKERS: [&str; 2] = ["trust this folder", "one you trust"];

/// 採った画面の置き場所。**既定はリポジトリの外**（PJTガイドライン）。
fn capture_dir() -> PathBuf {
    let dir = std::env::var("AGENTDASHBOARD_SCREEN_CAPTURE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("agentdashboard-screens"));
    std::fs::create_dir_all(&dir).expect("置き場所を作れること");
    dir
}

/// 1枚を書き出す。**空の画面は採れたことにしない**——採取の失敗を「採れた」と記録すると、
/// あとで目印を数えるときに「その画面には目印が無い」という誤った結論になる。
fn save(dir: &Path, name: &str, text: &str) {
    assert!(
        text.trim().len() > 32,
        "{name} の画面が空に近いので採取できていません（{} 文字）",
        text.trim().len()
    );
    let path = dir.join(format!("{name}.txt"));
    std::fs::write(&path, text).expect("画面を書き出せること");
    println!("採取: {} （{} 文字）", path.display(), text.chars().count());
}

/// 選択ダイアログが出ている画面を、当たってはいけない側の画面と合わせて実物から採る。
///
/// **1セッションで5枚を採る。** 起こす回数を増やすとそのぶんクォータを使うので、
/// 1本の流れの中で採れるものは全部そこで採る。
#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make capture-screens）"]
async fn 選択待ちの画面と_そうでない画面を実物から採る() {
    let out = capture_dir();
    let dir = WorkDir::new("markers");
    // モデルは haiku 固定でクォータを抑える。利用者のグローバル設定は外す——フックや
    // スキルが割り込むと画面の判定が狂う（PJTガイドライン）
    let program = claude_wrapper(
        &dir,
        &["--model", "haiku", "--setting-sources", "project,local"],
    );
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;
    let target =
        client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること");

    let spawned = client::spawn(&target, &dir.as_str(), None, None)
        .await
        .expect("CLI から起こせること");
    let card = spawned.human.clone();
    let prefix = &card[..8];

    // --- 1枚目：フォルダ信頼の確認 -------------------------------------------
    // 使い捨てのフォルダなので出るはず。**照合はダイアログの文言で行う**——裸の `trust`
    // では welcome の What's new にも当たる（実CLI で実測済み）
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut trust_seen = false;
    loop {
        let text = cli_screen_text(&target, prefix).await;
        let lower = text.to_lowercase();
        // **信頼確認の判定を先に置く。** あの画面も `❯ 1. Yes, I trust this folder` を
        // 持つので、下の「入力欄が出た」の分岐が先だと必ずそちらへ落ちる
        if TRUST_MARKERS.iter().any(|marker| lower.contains(marker)) {
            save(&out, "trust", &text);
            trust_seen = true;
            break;
        }
        if lower.contains("welcome back") || text.contains("❯") {
            eprintln!("警告: 信頼確認が出ませんでした（既に信頼済みのフォルダ？）");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に信頼確認も起動後の画面も読めませんでした: {text}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if trust_seen {
        // 矢印を往復して既定へ戻してから確定する。**素直な down→enter は `No, exit` を
        // 選んで claude ごと終わる**（実CLI で実測済み）
        client::send_keys(
            &target,
            prefix,
            &["down".to_string(), "up".to_string(), "enter".to_string()],
        )
        .await
        .expect("キーを送れること");
    }

    wait_via_cli(&target, &card, "入力待ち", |meta| {
        meta.status == SessionStatus::WaitingInput
    })
    .await;

    // --- 2枚目：起動直後（当たってはいけない側）-------------------------------
    let welcome = wait_screen_settled(&target, prefix).await;
    save(&out, "welcome", &welcome);

    // --- 3枚目：権限確認 -----------------------------------------------------
    // **副作用のある操作を頼む**——`echo` のような読み取り専用に見えるものは版によっては
    // 確認なしで通り、確かめたい画面が1度も出ない（実CLI で実測済み）
    client::send_input(
        &target,
        prefix,
        "report.txt というファイルを作って、中身は ok の1行にして。",
        false,
        5,
    )
    .await
    .expect("指示を送れること");
    wait_via_cli(&target, &card, "権限確認待ち", |meta| {
        meta.status == SessionStatus::WaitingPermission
    })
    .await;
    let permission = cli_screen_text(&target, prefix).await;
    save(&out, "permission", &permission);

    client::send_keys(&target, prefix, &["enter".to_string()])
        .await
        .expect("許可を送れること");
    wait_via_cli(&target, &card, "入力待ちへ戻る", |meta| {
        meta.status == SessionStatus::WaitingInput
    })
    .await;

    // --- 4枚目：普通に会話しているだけの画面（当たってはいけない側）------------
    let after_turn = wait_screen_settled(&target, prefix).await;
    save(&out, "after-turn", &after_turn);

    // --- 5枚目：`/rewind` のメニュー -----------------------------------------
    client::send_input(&target, prefix, "/rewind", false, 5)
        .await
        .expect("メニューを開けること");
    // メニューは状態を変えないので、**画面が変わったこと**で待つ
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut rewind = String::new();
    loop {
        let text = cli_screen_text(&target, prefix).await;
        if text != after_turn && text.trim().len() > 32 {
            rewind = text;
            break;
        }
        if Instant::now() >= deadline {
            eprintln!("警告: /rewind のメニューが出ませんでした。この1枚は採れていません");
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if !rewind.is_empty() {
        save(&out, "rewind", &rewind);
        // 閉じる（確定させない——巻き戻すとこのセッションの状態が変わる）
        client::send_keys(&target, prefix, &["esc".to_string()])
            .await
            .expect("メニューを閉じられること");
    }

    client::kill(&target, prefix).await.expect("終了できること");
    client::archive(&target, prefix).await.expect("外せること");

    println!("\n採取先: {}", out.display());
    println!("**匿名化と残存検査を通してから fixtures へ置くこと**");
}
