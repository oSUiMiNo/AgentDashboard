//! 未解明2事象が**ログだけで辿れる**ことの確認（ログ設計§16-2・テスト計画フェーズ6）。
//!
//! # 「直る」ではなく「辿れる」
//!
//! 2件とも状態依存で、起こし直すと再現しない。「再現する自動テストがあること」を
//! 完了条件にすると**このイシューが原理的に終われない**ので、解明そのものは元のイシュー
//! （`履歴が届かない件の追跡`）へ返してある。ここで確かめるのは、**次に踏んだ人が
//! ログだけで切り分けられるか**である。
//!
//! # 事象1 の3択と、決め手になる行
//!
//! 元イシューは分かっていないことを「**watch の要求が出ていたのか、出ていたが
//! 届かなかったのか、届いたが読まれなかったのか**」と書いている。逐語で対応させる。
//!
//! | 3択 | 決め手 |
//! |---|---|
//! | 出ていたのか | 「パーサへ履歴の監視を頼みました」が在るか、「パーサが繋がっていないため…」が在るか |
//! | 届かなかったのか | 「パーサへ監視の指示を渡せません」が続くか |
//! | 読まれなかったのか | 上2つの後、「パーサから最初の報告が届きました」が**来ない**か |
//!
//! **3番目だけは「行が無いこと」で言う。** 無いことは、出るはずのものが出る土台で
//! 確かめないと意味がないので、同じ形の正常系を隣に置いてある。
//!
//! # なぜ擬似パーサを使うのか
//!
//! 本物は指示を読めば必ず報告を返すし、親を失えば自分で畳む（対症として入れた見張り）。
//! **壊れ方そのものは本物では作れない**ので、`testkit` の `fake-parser` を差し込む。

// テスト名は日本語で書いている。英大文字が混ざると snake_case 判定に引っかかるだけで
// 実害はないため、このファイルに限って許可する。
#![allow(non_snake_case)]

mod common;

use agentdashboard_core::config::Config;
use common::TestServer;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 擬似パーサの型を選ぶ環境変数（`testkit/src/bin/fake-parser.rs` と同じ綴り）。
const FAKE_PARSER_MODE: &str = "AGENTDASHBOARD_FAKE_PARSER";

/// 行が出ないことを言う前に待つ時間。
///
/// **短すぎると「まだ来ていない」を「来ない」と読み違える。** 擬似 claude の起動と
/// フックの1往復より十分に長く採る。
const QUIET: Duration = Duration::from_millis(1500);

fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-traceable-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn config_for(dir: &Path) -> Config {
    Config {
        state_dir: Some(dir.join("state")),
        ..Config::default()
    }
}

fn fake_parser() -> PathBuf {
    testkit::binary_path("fake-parser")
}

fn sink() -> &'static session_host_core::logging::capture::Sink {
    session_host_core::logging::capture::sink()
}

/// `mark` から後の、そのカードの行の本文だけを並べる。
fn messages(mark: usize, card_id: protocol::CardId) -> Vec<String> {
    sink()
        .matching(mark, "card_id", &card_id.to_string())
        .into_iter()
        .filter_map(|line| line["msg"].as_str().map(str::to_string))
        .collect()
}

fn contains(lines: &[String], needle: &str) -> bool {
    lines.iter().any(|line| line.contains(needle))
}

/// その本文の行が出るまで待つ（カードで絞らない口）。
///
/// パーサの起動そのものはカードに紐づかないので、相関キーで絞れない。
async fn wait_for_any(mark: usize, needle: &str) {
    for _ in 0..200 {
        let found = sink()
            .since(mark)
            .into_iter()
            .any(|line| line["msg"].as_str().is_some_and(|msg| msg.contains(needle)));
        if found {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("「{needle}」の行が出ませんでした");
}

/// セッションを起こし、フックで JSONL の場所を知らせる（＝監視を頼ませる）。
///
/// 本番と同じ経路を通す。`ParserHandle::watch` を直に叩くと、「頼みました」の行を出す
/// `handle_hook` を素通りしてしまい、**3択の1番目を確かめられない**。
async fn 監視を頼ませる(
    server: &TestServer,
    dir: &Path,
) -> (std::sync::Arc<session_host_core::session::Session>, PathBuf) {
    let session = server
        .manager
        .spawn(&dir.to_string_lossy())
        .expect("セッションを起動できること");
    let transcript = dir.join("session.jsonl");
    let payload = serde_json::json!({
        "session_id": "11111111-2222-3333-4444-555555555555",
        "transcript_path": transcript.to_string_lossy(),
        "hook_event_name": "SessionStart",
    });
    let status = server
        .post_hook(session.token(), "SessionStart", &payload.to_string())
        .await;
    assert_eq!(status, 204, "フックが受理されること");
    (session, transcript)
}

/// 会話1往復ぶんの最小トランスクリプト（`transcript.rs` と同じ材料）。
fn sample_lines() -> Vec<String> {
    vec![
        r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"2.1.220","message":{"role":"user","content":"テストを流して"}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"2026-07-29T00:00:01.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"流します"}]}}"#.to_string(),
    ]
}

fn append(path: &Path, lines: &[String]) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("トランスクリプトへ書けること");
    for line in lines {
        writeln!(file, "{line}").expect("行を書けること");
    }
}

// --- 事象1：構造化ビューが永久に空のままになる ---------------------------------

#[tokio::test]
async fn 事象1_要求が出ていない場合はそう読める() {
    // パーサを立てない構成。フックは届くが、頼む相手が居ない
    let dir = work_dir("no-parser");
    let server = TestServer::start_with(config_for(&dir)).await;
    let mark = sink().mark();

    let (session, _transcript) = 監視を頼ませる(&server, &dir).await;
    tokio::time::sleep(QUIET).await;

    let lines = messages(mark, session.card_id);
    assert!(
        contains(&lines, "パーサが繋がっていないため履歴の監視を頼めません"),
        "頼めなかったことが出ること: {lines:#?}"
    );
    // **他の2択の顔をしていないこと。** 3つが同じ見え方をするなら、行が在っても選べない
    assert!(
        !contains(&lines, "パーサへ履歴の監視を頼みました"),
        "頼んでいないのに頼んだ顔をしている: {lines:#?}"
    );
    assert!(
        !contains(&lines, "パーサから最初の報告が届きました"),
        "報告が来るはずがない: {lines:#?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn 事象1_出したが届かなかった場合はそう読める() {
    // 標準入力を閉じた擬似パーサ。**生きているのに受け取れない**という、本物では
    // 作れない状態。親の書き込みは必ず失敗する
    unsafe { std::env::set_var(FAKE_PARSER_MODE, "deaf") };
    let dir = work_dir("deaf");
    let mark = sink().mark();
    let server = TestServer::start_with_parser_binary(config_for(&dir), &fake_parser()).await;
    // Hello は**閉じた後に**出るので、これを見た時点で次の書き込みは必ず失敗する
    wait_for_any(mark, "と接続しました").await;

    let (session, _transcript) = 監視を頼ませる(&server, &dir).await;
    tokio::time::sleep(QUIET).await;

    let lines = messages(mark, session.card_id);
    assert!(
        contains(&lines, "パーサへ履歴の監視を頼みました"),
        "要求は出ていること: {lines:#?}"
    );
    assert!(
        contains(&lines, "を渡せません。この指示は届いていません"),
        "届かなかったことが出ること: {lines:#?}"
    );
    assert!(
        !contains(&lines, "パーサから最初の報告が届きました"),
        "届いていないのに読まれるはずがない: {lines:#?}"
    );
}

#[tokio::test]
async fn 事象1_届いたが読まれなかった場合はそう読める() {
    // 指示は読むが何も返さない擬似パーサ。**繋がっているのに何も起きない**
    unsafe { std::env::set_var(FAKE_PARSER_MODE, "silent") };
    let dir = work_dir("silent");
    let mark = sink().mark();
    let server = TestServer::start_with_parser_binary(config_for(&dir), &fake_parser()).await;
    wait_for_any(mark, "と接続しました").await;

    let (session, transcript) = 監視を頼ませる(&server, &dir).await;
    // **読む材料は在る。** 無いせいで報告が来ないのと区別するために置く
    append(&transcript, &sample_lines());
    tokio::time::sleep(QUIET).await;

    let lines = messages(mark, session.card_id);
    assert!(
        contains(&lines, "パーサへ履歴の監視を頼みました"),
        "要求は出ていること: {lines:#?}"
    );
    assert!(
        !contains(&lines, "を渡せません。この指示は届いていません"),
        "届いてはいること: {lines:#?}"
    );
    assert!(
        !contains(&lines, "パーサから最初の報告が届きました"),
        "読まれていないこと: {lines:#?}"
    );
}

#[tokio::test]
async fn 事象1_正常なら読まれたことが出る() {
    // **「行が無い」で言う検査には、出る土台を隣に置く。** 出ない実装でも通って
    // しまう検査は、通っても何も言えない
    let dir = work_dir("healthy");
    let mark = sink().mark();
    let server = TestServer::start_with_parser(config_for(&dir)).await;

    let (session, transcript) = 監視を頼ませる(&server, &dir).await;
    append(&transcript, &sample_lines());

    for _ in 0..200 {
        if contains(
            &messages(mark, session.card_id),
            "パーサから最初の報告が届きました",
        ) {
            let lines = messages(mark, session.card_id);
            assert!(
                contains(&lines, "パーサへ履歴の監視を頼みました"),
                "要求も出ていること: {lines:#?}"
            );
            assert!(
                !contains(&lines, "を渡せません。この指示は届いていません"),
                "届かなかった顔をしていないこと: {lines:#?}"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "最初の報告の行が出ませんでした: {:#?}",
        messages(mark, session.card_id)
    );
}

// --- 事象2：親を失ったパーサが生き残る -----------------------------------------

/// 起こしたダッシュボードの後始末。**必ず畳む。**
///
/// 孤児は誰も畳んでくれない（親を殺して作るので `kill_on_drop` も効かない）ので、
/// 検査が途中で落ちても片付くよう Drop に置く。
struct 起こした一式 {
    dir: PathBuf,
    dashboards: Vec<std::process::Child>,
    orphans: Vec<u32>,
}

impl Drop for 起こした一式 {
    fn drop(&mut self) {
        for child in &mut self.dashboards {
            let _ = child.kill();
            let _ = child.wait();
        }
        for pid in &self.orphans {
            // **名指しで殺す。** `pkill -f` のような当て方は自分にも当たる。
            // `kill` の実行ファイルはこのイメージに無いので、シェルの組み込みを使う
            let _ = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("kill -9 {pid}"))
                .status();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// ログのファイル1枚を JSON の行として読む。
fn 行を読む(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// `<state_dir>/logs/` にある `dashboard-*` を新しい順に並べる。
fn ダッシュボードのログ(state_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(state_dir.join("logs"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("dashboard-"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// ファイル名から親の pid を取る（`dashboard-<pid>.<日付>.jsonl`）。
///
/// **ここが読めることが検査の一部である。** 行の中身だけでなく、ファイルの名前も
/// 手がかりとして数えている（設計§3-2）。
fn ファイル名の親pid(path: &Path) -> u32 {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("ファイル名を読めること");
    name.trim_start_matches("dashboard-")
        .split('.')
        .next()
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("ファイル名から親の pid を読めません: {name}"))
}

fn 起きているか(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// ダッシュボードを1本起こし、パーサを起こした行が出るまで待つ。
fn ダッシュボードを起こす(
    dir: &Path,
    state_dir: &Path,
) -> (std::process::Child, PathBuf) {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
        listener.local_addr().expect("番号を読めること").port()
    };
    let config = dir.join(format!("config-{port}.toml"));
    std::fs::write(
        &config,
        format!(
            "port = {port}\nstate_dir = \"{state}\"\ndatabase_url = \"sqlite://{db}\"\n\
             selfheal_enabled = false\n",
            state = state_dir.display(),
            db = dir.join(format!("dashboard-{port}.db")).display(),
        ),
    )
    .expect("設定を書けること");

    let 前 = ダッシュボードのログ(state_dir);
    let child = testkit::binary_command("agentdashboard")
        .arg("--config")
        .arg(&config)
        .env(
            session_host_core::parser::PARSER_BIN_ENV,
            testkit::binary_path("fake-parser"),
        )
        .env(FAKE_PARSER_MODE, "silent")
        .env(
            session_host_core::session::lifecycle::CLAUDE_BIN_ENV,
            common::fake_claude(),
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("ダッシュボードを起こせること");

    let mut child = child;
    for _ in 0..200 {
        // **前に無かったファイル**を探す。同じ置き場所を使い回すので、
        // 前の起動のぶんを掴むと自分の子の pid を読み違える
        if let Some(path) = ダッシュボードのログ(state_dir)
            .into_iter()
            .find(|path| !前.contains(path))
        {
            if 起こした行(&path).is_some() {
                return (child, path);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // **諦める前に畳む。** ここで投げ出すと、待ち受けたままのダッシュボードが
    // ポートを掴んだまま残る（後続のテストが同じ形で落ちる）
    let _ = child.kill();
    let _ = child.wait();
    panic!("パーサを起こした行が出ませんでした");
}

/// そのログから「transcript-parser を起こしました」の行を1つ取る。
fn 起こした行(path: &Path) -> Option<serde_json::Value> {
    行を読む(path).into_iter().find(|line| {
        line["msg"]
            .as_str()
            .is_some_and(|msg| msg.contains("transcript-parser を起こしました"))
    })
}

/// 親を失ったパーサを人工的に作り、**ログだけで**どの起動の子かといつからかを言う。
///
/// # ログだけで言えること・言えないこと
///
/// 親を `SIGKILL` で殺すので、**親は自分の最期を書けない**。だから「何時何分に
/// 親を失った」は書かれておらず、言えるのは**区間**である。
///
/// - 上限：置き去りにした側のログの**最後の行**の時刻
/// - 下限：次の起動のログの**最初の行**の時刻
///
/// これは設計§8-3 が受け入れた形そのもの（「孤児になった間の行き先はゼロのままだが、
/// 孤児が居たこと自体は新しい親のログと pid で読める」）。**書けない側を書けるかのように
/// 検査しない。**
#[cfg(unix)]
#[test]
fn 事象2_孤児になったパーサがログだけで辿れる() {
    let dir = work_dir("orphan");
    let state_dir = dir.join("state");
    std::fs::create_dir_all(&state_dir).expect("置き場所を作れること");
    let mut 一式 = 起こした一式 {
        dir: dir.clone(),
        dashboards: Vec::new(),
        orphans: Vec::new(),
    };

    // 1本目を起こす
    let (mut 一本目, ログ1) = ダッシュボードを起こす(&dir, &state_dir);
    let 行1 = 起こした行(&ログ1).expect("起こした行が在ること");
    let 子1 = 行1["parser_pid"].as_u64().expect("pid が数として載ること") as u32;
    let run1 = 行1["run_id"]
        .as_str()
        .expect("run_id が載ること")
        .to_string();
    一式.orphans.push(子1);

    // **親だけを殺す。** `Child::kill` は `SIGKILL` なのでデストラクタ（`kill_on_drop`）は
    // 走らず、子は畳まれない。これが実機で観測された姿（36分生き残った個体）。
    // **孫は道連れにならない**——殺したのは親1本だけである
    let 親1 = 一本目.id();
    一本目.kill().expect("親を殺せること");
    let _ = 一本目.wait();

    // 擬似パーサには孤児の見張りが無いので、置き去りのまま生き続ける
    std::thread::sleep(Duration::from_millis(300));
    assert!(起きているか(子1), "孤児が生き残っていること（pid={子1}）");

    // 2本目を起こす。**同じ置き場所**を使う
    let (二本目, ログ2) = ダッシュボードを起こす(&dir, &state_dir);
    let 行2 = 起こした行(&ログ2).expect("起こした行が在ること");
    let 子2 = 行2["parser_pid"].as_u64().expect("pid が数として載ること") as u32;
    let run2 = 行2["run_id"]
        .as_str()
        .expect("run_id が載ること")
        .to_string();
    一式.orphans.push(子2);
    一式.dashboards.push(二本目);

    // **孤児と新しい子が同時に生きている。** ここが読めることが事象2 の要点
    assert!(起きているか(子1), "孤児がまだ生きていること");
    assert!(起きているか(子2), "新しい子も生きていること");
    assert_ne!(子1, 子2, "別の個体であること");

    // --- ここから先は、ログ（とファイル名）だけを材料にする ---

    // 1. どの起動の子か。**ファイル名の pid（親）と行の run_id で対応が付く**
    assert_ne!(run1, run2, "起動ごとに run_id が変わること");
    assert_eq!(
        ファイル名の親pid(&ログ1),
        親1,
        "1本目のファイルが親を名指すこと"
    );
    assert_ne!(
        ファイル名の親pid(&ログ2),
        親1,
        "2本目は別の親のファイルであること"
    );

    // 2. 置き去りにした側は、子を畳んだとは言っていない
    let 行たち1 = 行を読む(&ログ1);
    assert!(
        !行たち1.iter().any(|line| line["msg"]
            .as_str()
            .is_some_and(|msg| msg.contains("停止を指示"))),
        "畳んだ形跡が無いこと（あるなら孤児にならない）"
    );

    // 3. 親を失った区間が読める。上限＝1本目の最後の行、下限＝2本目の最初の行
    let 上限 = 行たち1
        .last()
        .and_then(|line| line["ts"].as_str())
        .expect("1本目に行が在ること")
        .to_string();
    let 下限 = 行を読む(&ログ2)
        .first()
        .and_then(|line| line["ts"].as_str())
        .expect("2本目に行が在ること")
        .to_string();
    // `ts` は RFC3339・UTC・ミリ秒までなので、**文字列のまま並べて時刻順になる**（設計§2-1）
    assert!(
        上限 <= 下限,
        "区間が読めること（上限 {上限} / 下限 {下限}）"
    );

    // 4. 孤児の側は、その区間に1行も書けていない（§8-3 が受け入れた制約）。
    //    **書けていないことを検査に書いておく**——次に読む人が「行が無い＝異常」と
    //    読み違えないように
    assert!(
        !行たち1
            .iter()
            .any(|line| line["ts"].as_str() > Some(上限.as_str())),
        "置き去りにした側のログは、親の死とともに止まっていること"
    );
}

#[tokio::test]
async fn 最初の報告の行はカード1枚につき1回だけ出る() {
    // ノード単位で回る場所に行を置かない（設計§9-2）。追記のたびに出ると、
    // いちばん読みたい行がいちばん埋もれる
    let dir = work_dir("once");
    let mark = sink().mark();
    let server = TestServer::start_with_parser(config_for(&dir)).await;

    let (session, transcript) = 監視を頼ませる(&server, &dir).await;
    append(&transcript, &sample_lines());
    tokio::time::sleep(QUIET).await;
    append(&transcript, &sample_lines());
    tokio::time::sleep(QUIET).await;

    let found = messages(mark, session.card_id)
        .into_iter()
        .filter(|line| line.contains("パーサから最初の報告が届きました"))
        .count();
    assert_eq!(found, 1, "1回だけ出ること");
}
