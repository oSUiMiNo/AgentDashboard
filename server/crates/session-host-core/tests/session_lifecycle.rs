//! PTY ライフサイクルの検証（テスト計画フェーズ2「PTYライフサイクル」）。
//!
//! 起動 → 出力の読み取り → 入力の書き込み → リサイズ → 終了（正常/異常）→ EOF までを、
//! 擬似 claude を相手に通しで確かめる。設計§6/§14 の portable-pty 実装規約が実際に
//! 成立していること（特に slave 先行ドロップで読み取りスレッドが確実に終わること）も
//! ここで担保する。

mod common;

use portable_pty::{CommandBuilder, PtySize};
use protocol::SessionStatus;
use session_host_core::session::pty::PtyProcess;
use testkit::fake_claude;
use tokio::{sync::mpsc, time::timeout};

fn test_size() -> PtySize {
    PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tokio::test]
async fn 起動して入出力とリサイズができ正常終了で_ended_になる() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    // 起動直後はフックがまだ無いので、設計§5 の定義どおり Starting のまま
    assert_eq!(session.status(), SessionStatus::Starting);
    assert!(watcher.contains(fake_claude::READY_MARKER));

    common::send_line(&session, "こんにちは");
    watcher
        .wait_for(&format!("{}こんにちは", fake_claude::RECEIVED_PREFIX))
        .await;

    session.resize(120, 40).expect("リサイズできること");

    common::send_line(&session, "exit");
    watcher.wait_for(fake_claude::BYE_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    // 一覧に載る情報も終了を反映していること
    let meta = session.meta();
    assert_eq!(meta.status, SessionStatus::Ended { ok: true });
    assert!(meta.claude_session_id.is_some());
}

#[tokio::test]
async fn ダッシュボードから終了させた場合は正常終了として扱われる() {
    // 強制終了なので終了コードは非ゼロになるが、利用者が自分で終わらせたものを
    // 「異常終了」と表示すると落ちたように見えてしまう（フェーズ1からの引き継ぎ事項）
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

#[tokio::test]
async fn 誰も指示していない異常終了は異常終了のまま出る() {
    // 「利用者が終わらせた」と「落ちた」を取り違えないことの確認。
    // kill を経由せず、子プロセス自身が非ゼロで終わる経路をたどらせる
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, "crash 9");
    watcher.wait_for(fake_claude::CRASH_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
}

#[tokio::test]
async fn 停止中のセッションをkillしても終了を検知できる() {
    // 読み取りを止めたまま kill すると、読み取りスレッドが待ったまま残りうる。
    // 起こしてから殺す順序になっているかの確認
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.set_client_pause(1, true);
    assert!(session.is_paused());

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

#[tokio::test]
async fn 異常終了の終了コードを取得できる() {
    let (chunks_tx, _chunks_rx) = mpsc::channel(8);

    let mut command = CommandBuilder::new(common::fake_claude());
    command.arg("--exit-code");
    command.arg("42");

    let (process, exit_rx) =
        PtyProcess::spawn(command, test_size(), chunks_tx).expect("PTY を開けること");

    let exit = timeout(common::TIMEOUT, exit_rx)
        .await
        .expect("時間内に終了すること")
        .expect("終了状態が届くこと");

    assert!(!exit.ok, "異常終了として扱われること");
    assert_eq!(exit.code, 42, "終了コードが伝わること");
    drop(process);
}

/// 終わった子が、終了状態を引き取られずに残らない（ゾンビ設計§6-2）。
///
/// **`exit_rx` が返るだけでは足りない。** あれは待ちスレッドが `wait()` を終えた合図だが、
/// 「OS のプロセス表から消えたか」までは言っていない。**実機で78体溜まったときも、
/// カードは正しく `Ended` になっていた**——画面の勘定と OS の勘定は別々に動く。
#[tokio::test]
async fn 終わった子はプロセス表に残らない() {
    let Some(root) = std::fs::read_dir("/proc").ok() else {
        // Linux 以外。**読めないことは異常ではない**
        return;
    };
    drop(root);

    let (chunks_tx, _chunks_rx) = mpsc::channel(8);
    let mut command = CommandBuilder::new(common::fake_claude());
    command.arg("--exit-code");
    command.arg("0");

    let (process, exit_rx) =
        PtyProcess::spawn(command, test_size(), chunks_tx).expect("PTY を開けること");
    let child = 自分の子(std::process::id());
    assert_eq!(child.len(), 1, "起こした子が1本だけ見えること: {child:?}");
    let pid = child[0];

    timeout(common::TIMEOUT, exit_rx)
        .await
        .expect("時間内に終了すること")
        .expect("終了状態が届くこと");
    drop(process);

    // 待ちスレッドが引き取り終えるまでの間、プロセス表にはまだ見えうる
    let 期限 = std::time::Instant::now() + common::TIMEOUT;
    while std::path::Path::new(&format!("/proc/{pid}")).exists() {
        assert!(
            std::time::Instant::now() < 期限,
            "終わった子が引き取られないまま残っている: {pid}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// `/proc` を読んで、親が `parent` の子の PID を並べる。
///
/// **`comm` は括弧で囲まれていて空白も括弧も含みうる**ので、最後の `)` で切ってから割る。
fn 自分の子(parent: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(line) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(close) = line.rfind(')') else {
            continue;
        };
        let mut rest = line[close + 1..].split_whitespace();
        let (Some(_state), Some(ppid)) = (rest.next(), rest.next()) else {
            continue;
        };
        if ppid.parse::<u32>() == Ok(parent) {
            found.push(name);
        }
    }
    found
}

#[tokio::test]
async fn 子プロセスが終わると読み取りスレッドが畳まれて待ち行列が閉じる() {
    // slave を先に落としているおかげで、子が終われば master 側の読み取りも必ず終わる。
    // 送信側（＝読み取りスレッド）が消えると待ち行列が閉じるので、それを終了の証拠にする
    let (chunks_tx, mut chunks_rx) = mpsc::channel(8);

    let (process, exit_rx) = PtyProcess::spawn(
        CommandBuilder::new(common::fake_claude()),
        test_size(),
        chunks_tx,
    )
    .expect("PTY を開けること");

    process
        .write_input(b"exit\r")
        .expect("端末へ書き込めること");

    let exit = timeout(common::TIMEOUT, exit_rx)
        .await
        .expect("時間内に終了すること")
        .expect("終了状態が届くこと");
    assert!(exit.ok);

    while timeout(common::TIMEOUT, chunks_rx.recv())
        .await
        .expect("待ち行列が時間内に閉じること")
        .is_some()
    {
        // 残っている出力を読み切る。送信側が畳まれれば None が返って抜ける
    }
}

#[tokio::test]
async fn 存在しない作業ディレクトリでは起動せずエラーを返す() {
    let manager = common::manager();
    let err = manager
        .spawn("/存在しないはずのディレクトリ/agentdashboard")
        .expect_err("エラーになること");
    assert!(
        err.to_string().contains("作業ディレクトリが存在しません"),
        "実際: {err}"
    );
    assert!(manager.list().is_empty(), "カードは作られないこと");
}

// 以下4件は、利用者が実際に打つ・貼る形をそのまま受け取れることの担保。
// 本アプリは WSL の上で動き、パスは Windows 側のエクスプローラから来ることがある。

#[tokio::test]
async fn バックスラッシュ区切りの作業ディレクトリでも起動できる() {
    let manager = common::manager();
    let typed = common::work_dir().replace('/', "\\");

    let session = manager.spawn(&typed).expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    watcher.wait_for(fake_claude::READY_MARKER).await;

    // 一覧のグループ化キーは、入力した形ではなく解決後の絶対パスになること。
    // ここが入力のままだと、同じフォルダなのに打ち方の違いで別グループに割れる
    let expected = std::path::Path::new(&common::work_dir())
        .canonicalize()
        .expect("一時ディレクトリを解決できること");
    assert_eq!(session.meta().project.0, expected.to_string_lossy());

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

#[tokio::test]
async fn 先頭の区切りが抜けていても起動できる() {
    let manager = common::manager();
    let typed = common::work_dir().trim_start_matches('/').to_string();

    let session = manager.spawn(&typed).expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    watcher.wait_for(fake_claude::READY_MARKER).await;

    let expected = std::path::Path::new(&common::work_dir())
        .canonicalize()
        .expect("一時ディレクトリを解決できること");
    assert_eq!(session.meta().project.0, expected.to_string_lossy());

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

#[tokio::test]
async fn フォルダではないものを指したときは存在しない場合と理由が分かれる() {
    // 読み替えは効くが存在の判定は緩めていない、ということの確認でもある。
    // 読み替えが効いていなければ「存在しません」になってしまう
    let path = std::env::temp_dir().join(format!(
        "agentdashboard-cwd-{}-{}.txt",
        std::process::id(),
        line!()
    ));
    std::fs::write(&path, b"").expect("一時ファイルを作れること");
    let typed = path.to_string_lossy().replace('/', "\\");

    let manager = common::manager();
    let err = manager.spawn(&typed).expect_err("エラーになること");
    assert!(
        err.to_string().contains("フォルダではありません"),
        "実際: {err}"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn 見つからないときは何として解釈したかを添える() {
    // 読み替えが効いていないのか、読み替えた先が無いのかを画面のエラーだけで見分けられること
    let manager = common::manager();
    let err = manager
        .spawn(r"\存在しないはずの\ディレクトリ")
        .expect_err("エラーになること");
    assert!(
        err.to_string()
            .contains("/存在しないはずの/ディレクトリ として解釈しました"),
        "実際: {err}"
    );
}

#[tokio::test]
async fn archiveでカードが一覧から消える() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    assert_eq!(manager.list().len(), 1);

    manager.archive(session.card_id).expect("消せること");
    assert!(manager.list().is_empty());
    assert!(manager.get(session.card_id).is_none());
}

#[tokio::test]
async fn 起こしたセッションは_toml_が名乗る名前を申告する() {
    // 正当系（テスト計画フェーズ5）。**申告するだけ**で、帰属を決めるのはサーバ側
    // （設計§8-5）。ここで見るのは「線に載る」ところまで
    let root = std::env::temp_dir().join(format!(
        "agentdashboard-toml-account-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let deep = root.join("app");
    std::fs::create_dir_all(&deep).expect("作業ディレクトリを作れること");
    std::fs::write(
        root.join(session_host_core::session::account_toml::FILE_NAME),
        "account = \"わたし\"\n",
    )
    .expect("書けること");

    let manager = common::manager();
    let session = manager
        .spawn(&deep.to_string_lossy())
        .expect("セッションを起動できること");

    // 上へ辿って根の1枚が効くこと（cwd 直下に置かなくてよい）
    assert_eq!(
        session.meta().toml_account.as_deref(),
        Some("わたし"),
        "申告が線に載っていない"
    );
    // 申告と帰属は別。セッションホスト側は自分の帰属を知らない（設計§5-1 の手順4）
    assert_eq!(session.meta().account, None);

    session.kill();
    let _ = std::fs::remove_dir_all(root);
}

/// 子が居なくなっても端末への書き込みは失敗しない（実測）。
///
/// **この事実が、送出失敗（設計§10-3 の `send_key`）の回帰テストを置けない理由である。**
/// master への書き込みは相手が居なくても通るので、warn を通す注入がこの経路には無い。
///
/// 声を持たない口から書けないことは、`session/mod.rs` の
/// `端末への書き込みは声を持つ口だけを通る` が綴りで固定している。
#[tokio::test]
async fn 子が居なくなっても端末への書き込みは失敗しない() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    assert!(
        session.write_input(b"x").is_ok(),
        "ここが Err になったなら、送出失敗の回帰テストが書けるようになったということ。\
         そのときは send_key の warn を実測で押さえること"
    );
}
