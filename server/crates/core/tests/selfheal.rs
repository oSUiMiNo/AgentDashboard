//! 自己修復の通し訓練（設計§9／テスト計画フェーズ7）。
//!
//! # 何を本物で通し、何を差し替えるか
//!
//! 差し替えるのは**外の世界に出る操作だけ**（cargo・git・本物の claude）。理由は2つ。
//!
//! - Rust のテストは `scripts/cargo`（＝ `docker run`）の中で走るので、その中から
//!   もう一度 docker を呼ぶことはできない
//! - 本物の claude は毎回クォータを消費する（実物を相手にする訓練は `make test-cli`）
//!
//! それ以外——検知・順序・修復セッションの起動と待ち合わせ・変更範囲の検査・
//! **パーサの差し替えと無欠落再開**——はすべて実物を通す。差し替えの周りが一番
//! 壊れやすいので、そこを偽物にしたら訓練の意味が無い。

// テスト名は日本語で書いている。英大文字が混ざると snake_case 判定に引っかかるだけで
// 実害はないため、このファイルに限って許可する。
#![allow(non_snake_case)]

mod common;

use agentdashboard_core::config::Config;
use agentdashboard_core::selfheal::ops::{CanarySample, GateOutcome, SelfhealOps};
use common::TestServer;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// テストごとに独立した作業場所。状態ファイルを共有すると、対応表や
/// クールダウンが前のテストから漏れて結果が変わる。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-selfheal-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn config_for(dir: &Path) -> Config {
    Config {
        state_dir: Some(dir.join("state")),
        // 訓練を短く回す。回数の意味は本番と同じ
        selfheal_retry: 2,
        ..Config::default()
    }
}

/// 外の世界の代わり。何が起きたかを記録し、ゲートの合否を筋書きどおりに返す。
struct FakeOps {
    worktree: PathBuf,
    /// 本物の transcript-parser（ビルド済み）。`build_parser` はこれを返す
    parser_binary: PathBuf,
    /// ゲートが落ちる残り回数
    gate_failures: Mutex<u32>,
    /// `changed_files` が返すもの（変更範囲の検査を試すために差し替える）
    changed: Mutex<Vec<String>>,
    /// 呼ばれた順の記録
    calls: Mutex<Vec<String>>,
    /// カナリアが薄いサンプルを返す回数（採り直しの検証用）
    thin_canaries: Mutex<u32>,
}

impl FakeOps {
    fn new(dir: &Path) -> Arc<Self> {
        let worktree = dir.join("worktree");
        std::fs::create_dir_all(worktree.join("fixtures")).expect("worktree を作れること");
        Arc::new(Self {
            worktree,
            parser_binary: testkit::binary_path("transcript-parser"),
            gate_failures: Mutex::new(0),
            changed: Mutex::new(vec![
                "server/crates/transcript-parser/src/thread.rs".to_string(),
            ]),
            calls: Mutex::new(Vec::new()),
            thin_canaries: Mutex::new(0),
        })
    }

    fn record(&self, what: &str) {
        self.calls
            .lock()
            .expect("ロックが壊れていない")
            .push(what.to_string());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("ロックが壊れていない").clone()
    }

    fn count(&self, what: &str) -> usize {
        self.calls().iter().filter(|call| *call == what).count()
    }

    fn fail_gate(&self, times: u32) {
        *self.gate_failures.lock().expect("ロックが壊れていない") = times;
    }
}

impl SelfhealOps for FakeOps {
    fn prepare_worktree(&self, _branch: &str) -> anyhow::Result<PathBuf> {
        self.record("worktree");
        Ok(self.worktree.clone())
    }

    fn run_canary(&self, model: &str, worktree: &Path) -> anyhow::Result<CanarySample> {
        self.record(&format!("canary:{model}"));
        let dir = worktree.join("fixtures").join("v9.9.9").join("canary");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("session.jsonl"), b"{}\n")?;

        let mut thin = self.thin_canaries.lock().expect("ロックが壊れていない");
        let is_thin = *thin > 0;
        if is_thin {
            *thin -= 1;
        }
        Ok(CanarySample {
            version: "9.9.9".to_string(),
            dir,
            has_tool_use: !is_thin,
            has_subagent: !is_thin,
        })
    }

    fn run_gate(&self, _worktree: &Path) -> GateOutcome {
        self.record("gate");
        let mut remaining = self.gate_failures.lock().expect("ロックが壊れていない");
        if *remaining > 0 {
            *remaining -= 1;
            return GateOutcome {
                passed: false,
                output: "test 表示対象外のレコード ... FAILED".to_string(),
            };
        }
        GateOutcome {
            passed: true,
            output: "12 tests run: 12 passed".to_string(),
        }
    }

    fn build_parser(&self, _worktree: &Path) -> anyhow::Result<PathBuf> {
        self.record("build");
        // 本物のパーサを返す。差し替えたあとも履歴が届くことを確かめたいので、
        // ここだけは動く実行ファイルでなければ意味がない
        Ok(self.parser_binary.clone())
    }

    fn changed_files(&self, _worktree: &Path) -> anyhow::Result<Vec<String>> {
        self.record("changed");
        Ok(self.changed.lock().expect("ロックが壊れていない").clone())
    }

    fn commit(&self, _worktree: &Path, _message: &str) -> anyhow::Result<()> {
        self.record("commit");
        Ok(())
    }
}

/// 監視対象のセッションを1つ立て、トランスクリプトの場所をフックで知らせる。
async fn start_watched(
    server: &TestServer,
    dir: &Path,
) -> (Arc<agentdashboard_core::session::Session>, PathBuf) {
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
    assert_eq!(status, 204);
    (session, transcript)
}

/// 正常に読めるレコードを書く。`version` を変えると未知バージョンの検知を起こせる。
fn append_records(path: &Path, count: usize, version: &str, start: usize) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("トランスクリプトへ書けること");
    for index in start..start + count {
        writeln!(
            file,
            r#"{{"type":"user","uuid":"u{index}","timestamp":"2026-07-29T00:00:00.000Z","version":"{version}","message":{{"role":"user","content":"{index}"}}}}"#
        )
        .expect("行を書けること");
    }
}

/// パースできない行を書く（実行時の検知を起こす）。
fn append_broken(path: &Path, count: usize) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("トランスクリプトへ書けること");
    for index in 0..count {
        writeln!(file, "壊れている行 {index}").expect("行を書けること");
    }
}

/// 期待する呼び出しが記録されるまで待つ。
async fn wait_for_call(ops: &Arc<FakeOps>, what: &str, at_least: usize) {
    for _ in 0..300 {
        if ops.count(what) >= at_least {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "{what} が {at_least} 回に届きませんでした。実際: {:?}",
        ops.calls()
    );
}

/// 修復役を演じる。
///
/// 擬似 claude は自分でフックを焚かないので、テストが「起動した → 作業した →
/// ターンを終えた」を代わりに再現する。**プロンプトが実際に届いたことを見てから**
/// 返すので、順序を取り違えたまま通ってしまうことはない。
async fn play_repair_agent(server: &TestServer, attempts: u32) {
    let card = wait_for_repair_card(server).await;
    let session = server.manager.get(card).expect("修復セッションが居る");
    let mut watcher = common::Watcher::attach(&session);

    // 起動が済んだことにする（本物では SessionStart フックがここに相当する）
    fire(server, &session, "SessionStart").await;

    for attempt in 1..=attempts {
        // 送られてきた指示に「何回目か」が入っている。これを待てば取り違えない
        watcher.wait_for(&format!("挑戦 {attempt}/")).await;
        // 作業した（PreToolUse で作業中になる）
        fire(server, &session, "PreToolUse").await;
        // ターンを終えた
        fire(server, &session, "Stop").await;
    }
}

async fn fire(
    server: &TestServer,
    session: &Arc<agentdashboard_core::session::Session>,
    event: &str,
) {
    let payload = serde_json::json!({
        "session_id": "22222222-3333-4444-5555-666666666666",
        "hook_event_name": event,
        "tool_name": "Edit",
    });
    let status = server
        .post_hook(session.token(), event, &payload.to_string())
        .await;
    assert_eq!(status, 204, "{event} が受理されること");
}

/// 修復セッションのカードが現れるまで待つ。
async fn wait_for_repair_card(server: &TestServer) -> protocol::CardId {
    for _ in 0..600 {
        let maintenance = server
            .manager
            .list()
            .into_iter()
            .find(|meta| meta.project.0.contains("worktree"));
        if let Some(meta) = maintenance {
            return meta.card_id;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("修復セッションが起動しませんでした");
}

fn pointer_path(dir: &Path) -> PathBuf {
    dir.join("state")
        .join(agentdashboard_core::parser::PARSER_POINTER)
}

#[tokio::test]
async fn 対応できる新しい版ではカナリアだけで終わる() {
    // 起動頻度を下げることが安定運用の鍵（要件）。読めるなら修復セッションは起こさない
    let dir = work_dir("early-exit");
    let ops = FakeOps::new(&dir);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);

    wait_for_call(&ops, "gate", 1).await;
    // 対応表へ載って終わり
    for _ in 0..40 {
        if ops.count("commit") >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(ops.count("canary:haiku"), 1, "カナリアは1回");
    assert_eq!(ops.count("gate"), 1, "ゲートは1回だけ");
    assert!(
        server
            .manager
            .list()
            .iter()
            .all(|meta| !meta.project.0.contains("worktree")),
        "修復セッションが起動してしまっている: {:?}",
        ops.calls()
    );
}

#[tokio::test]
async fn 薄いサンプルは別のモデルで採り直す() {
    // ツールコールもサブエージェントも無いサンプルで「対応済み」と記録すると、
    // 一番壊れやすい部分を確かめないまま先へ進むことになる
    let dir = work_dir("thin-canary");
    let ops = FakeOps::new(&dir);
    *ops.thin_canaries.lock().unwrap() = 1;
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);

    wait_for_call(&ops, "canary:sonnet", 1).await;
    assert_eq!(ops.count("canary:haiku"), 1, "まず既定のモデルで採る");
}

#[tokio::test]
async fn 未知の版を見つけたら修復セッションを起こして差し替えるまで通る() {
    // テスト計画フェーズ7「修復フロー」。検知 → カナリア → ゲート不合格 →
    // 修復セッション → 再ゲート合格 → 差し替え → 無欠落再開 までを1本で通す
    let dir = work_dir("full-cycle");
    let ops = FakeOps::new(&dir);
    ops.fail_gate(1); // カナリア直後のゲートだけ落ちる
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);
    play_repair_agent(&server, 1).await;

    wait_for_call(&ops, "build", 1).await;
    wait_for_call(&ops, "commit", 1).await;

    // 順序が設計どおりであること（自己申告ではなく、こちらで確かめてから差し替える）
    let calls = ops.calls();
    let order: Vec<&str> = calls.iter().map(String::as_str).collect();
    assert_eq!(
        order,
        vec![
            "worktree",
            "canary:haiku",
            "gate",
            "changed",
            "gate",
            "build",
            "commit"
        ],
        "実際の順序: {order:?}"
    );

    // ポインタが新しいパーサを指している
    let pointer = std::fs::read_to_string(pointer_path(&dir)).expect("ポインタが書かれている");
    assert!(
        pointer.contains("transcript-parser"),
        "差し替え先が書かれていない: {pointer}"
    );

    // 差し替えたあとも履歴が続きから届く（再開位置は core が持っているので無欠落）
    let before = session.transcript_snapshot().len();
    append_records(&transcript, 2, "9.9.9", 100);
    for _ in 0..200 {
        if session.transcript_snapshot().len() >= before + 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let nodes = session.transcript_snapshot();
    assert_eq!(
        nodes.len(),
        5,
        "差し替え後に欠落か重複が起きている: {:?}",
        nodes
            .iter()
            .map(|node| node.id.0.clone())
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn 範囲外を触ったらテストの結果によらず不合格にする() {
    // 権限確認を出さない設定で無人実行するので、ここは言葉ではなく機械で見る
    let dir = work_dir("scope");
    let ops = FakeOps::new(&dir);
    ops.fail_gate(1);
    *ops.changed.lock().unwrap() = vec![
        "server/crates/transcript-parser/src/thread.rs".to_string(),
        "server/crates/protocol/src/ipc.rs".to_string(),
    ];
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);
    play_repair_agent(&server, 2).await;

    // 1回目は範囲外なのでゲートを回さずに突き返す
    wait_for_call(&ops, "changed", 2).await;
    let calls = ops.calls();
    let first_changed = calls.iter().position(|call| call == "changed").unwrap();
    assert_eq!(
        calls.get(first_changed + 1).map(String::as_str),
        Some("changed"),
        "範囲外なのにゲートを回している: {calls:?}"
    );
}

#[tokio::test]
async fn 落ちているサンプルを消して通そうとしても採用しない() {
    // 実際の訓練で本物のエージェントがこれをやった。落ちているフィクスチャを消せば
    // ゲートは通るが、新しい形式に対応したことにはならない。採りたてのファイルは
    // 追跡対象外なので、消しても git status には出ない（＝範囲の検査では捕まらない）
    let dir = work_dir("sample-deleted");
    let ops = FakeOps::new(&dir);
    ops.fail_gate(1);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);

    // 修復役がサンプルを消してからターンを終える
    let sample = ops
        .worktree
        .join("fixtures")
        .join("v9.9.9")
        .join("canary")
        .join("session.jsonl");
    let card = wait_for_repair_card(&server).await;
    let session = server.manager.get(card).expect("修復セッションが居る");
    let mut watcher = common::Watcher::attach(&session);
    fire(&server, &session, "SessionStart").await;
    watcher.wait_for("挑戦 1/").await;
    std::fs::remove_file(&sample).expect("サンプルを消せること");
    fire(&server, &session, "PreToolUse").await;
    fire(&server, &session, "Stop").await;

    // 消したことに気づいて突き返す。2回目も消えたままなので、そのまま諦める
    watcher.wait_for("消えているか書き換えられています").await;
    fire(&server, &session, "PreToolUse").await;
    fire(&server, &session, "Stop").await;
    wait_for_call(&ops, "changed", 2).await;

    assert_eq!(
        ops.count("gate"),
        1,
        "サンプルが消えているのにゲートを回している: {:?}",
        ops.calls()
    );
    assert_eq!(ops.count("build"), 0, "対応していないのに差し替えている");
}

#[tokio::test]
async fn 直せなければ縮退したままクールダウンに入る() {
    let dir = work_dir("give-up");
    let ops = FakeOps::new(&dir);
    ops.fail_gate(99); // 何度やっても通らない
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);
    play_repair_agent(&server, 2).await; // selfheal_retry = 2

    // 上限まで試して諦める
    wait_for_call(&ops, "gate", 3).await; // カナリア直後 + 2回
    assert_eq!(ops.count("build"), 0, "通っていないのにビルドしている");

    // 縮退モードの宣言（設計§9-6）。プロセスは動いていても中身を読めていないので、
    // 履歴の表示を信じてよいかどうかを伝える必要がある
    let parser = server.parser.as_ref().expect("パーサが居る");
    for _ in 0..100 {
        if parser.state() == protocol::ws::ParserState::Degraded {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        parser.state(),
        protocol::ws::ParserState::Degraded,
        "直せなかったのに構造化ビューを健全なままにしている"
    );

    // クールダウンが記録される
    for _ in 0..60 {
        let state = agentdashboard_core::selfheal::state::SelfhealState::load(&dir.join("state"));
        if state.failures.contains_key("9.9.9") {
            assert!(
                state.in_cooldown("9.9.9", agentdashboard_core::session::now_ms()),
                "失敗を記録したのに再挑戦を控えていない"
            );
            assert!(
                !state.known_versions.contains("9.9.9"),
                "直っていないのに対応表へ載せている"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("クールダウンが記録されませんでした: {:?}", ops.calls());
}

#[tokio::test]
async fn 設定で止めていれば検知しても修復に進まない() {
    let dir = work_dir("disabled");
    let ops = FakeOps::new(&dir);
    let server = TestServer::start_with_selfheal(
        Config {
            selfheal_enabled: false,
            ..config_for(&dir)
        },
        ops.clone(),
    )
    .await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);

    // 検知はするが、外の世界へは一切出ない
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(ops.calls(), Vec::<String>::new(), "止めているのに動いた");
}

#[tokio::test]
async fn 差し替えたパーサが悪ければ自動で戻す() {
    // テスト計画フェーズ7「ロールバック」。直したつもりが悪化していた場合、
    // 直しに行くのではなく**戻す**。ここで修復へ進むと、悪いパーサを載せたまま
    // 何度も直そうとしてしまう
    let dir = work_dir("rollback");
    let ops = FakeOps::new(&dir);
    ops.fail_gate(1);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);
    play_repair_agent(&server, 1).await;
    // 差し替えが**終わってから**壊す。修復中の発報は捨てる決まりなので、
    // 途中で壊すと「悪化に気づかない」のではなく「まだ観察を始めていない」になる
    wait_for_call(&ops, "commit", 1).await;
    let swapped = std::fs::read_to_string(pointer_path(&dir)).expect("差し替えが起きている");
    let original = testkit::binary_path("transcript-parser")
        .to_string_lossy()
        .into_owned();
    assert_ne!(swapped, original, "差し替え先が元のままになっている");

    // 差し替えたあとに読めない行が増える＝新しいパーサのほうが悪い
    append_broken(&transcript, 300);

    for _ in 0..300 {
        let now = std::fs::read_to_string(pointer_path(&dir)).unwrap_or_default();
        if now == original {
            // 戻すべきところで「もう一度直す」に進むと、悪いパーサを載せたまま
            // 何度も修復セッションを起こすことになる
            assert_eq!(
                ops.count("worktree"),
                1,
                "戻すべきところで修復をやり直している: {:?}",
                ops.calls()
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("悪化したのに戻していません: {:?}", ops.calls());
}

#[tokio::test]
async fn パーサが居なくなってもターミナルと状態表示は無傷() {
    // テスト計画フェーズ7「縮退の無傷性」。構造化ビューだけが壊れている状態でも、
    // ターミナルとして使えることが二層構成の狙い（設計§11）
    let dir = work_dir("degraded");
    let ops = FakeOps::new(&dir);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "2.1.220", 0);
    for _ in 0..100 {
        if !session.transcript_snapshot().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!session.transcript_snapshot().is_empty(), "まず履歴が届く");

    // パーサを「起動した瞬間に落ちるもの」へ差し替えて立て直す（＝居なくなった状態）
    std::fs::write(pointer_path(&dir), b"/bin/false").expect("ポインタを書けること");
    let parser = server.parser.as_ref().expect("パーサが居る");
    parser.restart();

    for _ in 0..200 {
        if parser.state() == protocol::ws::ParserState::Degraded {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        parser.state(),
        protocol::ws::ParserState::Degraded,
        "パーサが落ちたのに縮退を知らせていない"
    );

    // ここからが本題：縮退していてもターミナルと状態表示は動く
    let mut watcher = common::Watcher::attach(&session);
    session
        .write_input("こんにちは\r".as_bytes())
        .expect("指示を送れること");
    watcher.wait_for("received: こんにちは").await;

    fire(&server, &session, "PreToolUse").await;
    assert_eq!(
        session.status(),
        protocol::SessionStatus::Working,
        "フック由来の状態表示が止まっている"
    );
}

#[tokio::test]
async fn パースが壊れ始めたら実行時の検知が働く() {
    // テスト計画フェーズ7「検知（実行時）」。版は据え置きのまま中身だけ変わる場合、
    // 率でしか気づけない
    let dir = work_dir("rate");
    let ops = FakeOps::new(&dir);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    // 対応済みの版として登録しておく（版では発報させない）
    let mut state = agentdashboard_core::selfheal::state::SelfhealState::default();
    state.record_success("2.1.220");
    state.save(&dir.join("state"));

    append_records(&transcript, 100, "2.1.220", 0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    append_broken(&transcript, 300);

    wait_for_call(&ops, "worktree", 1).await;
}
