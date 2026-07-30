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
    /// 合否をサンプルの有無で決める（実物のゲートと同じ振る舞い）。
    ///
    /// 本物のゲートは「そのサンプルが読めるか」を見るので、サンプルを消せば通る。
    /// 消して通す抜け道を確かめるテストでは、そこを模していないと意味がない
    gate_follows_sample: Mutex<bool>,
    /// 画面側のゲート（別名表の見直しで使う）の合否
    web_gate_passes: Mutex<bool>,
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
            gate_follows_sample: Mutex::new(false),
            web_gate_passes: Mutex::new(true),
        })
    }

    /// 別名表の見直しの筋書きを整える。
    ///
    /// 表そのものは worktree の実ファイルを読むので、**中身も置く**。
    /// `changed` は「エージェントが何を触ったか」の代わり。
    fn stage_review(&self, table: &str, changed: &[&str]) {
        let path = self.worktree.join("web/src/lib/models.ts");
        std::fs::create_dir_all(path.parent().expect("親がある")).expect("置き場所を作れること");
        std::fs::write(&path, table).expect("表を書けること");
        *self.changed.lock().expect("ロックが壊れていない") =
            changed.iter().map(|path| path.to_string()).collect();
    }

    /// カナリアが置くサンプルの場所。
    fn sample_path(&self) -> PathBuf {
        self.worktree
            .join("fixtures")
            .join("v9.9.9")
            .join("canary")
            .join("session.jsonl")
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
        if *self
            .gate_follows_sample
            .lock()
            .expect("ロックが壊れていない")
        {
            // 実物と同じ：そのサンプルが読めなければ落ちる＝消せば通る
            let present = self.sample_path().is_file();
            return GateOutcome {
                passed: !present,
                output: "test すべてのフィクスチャ ... FAILED".to_string(),
            };
        }
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

    fn run_web_gate(&self, _worktree: &Path) -> GateOutcome {
        self.record("web-gate");
        let passed = *self.web_gate_passes.lock().expect("ロックが壊れていない");
        GateOutcome {
            passed,
            output: if passed {
                "12 tests passed".to_string()
            } else {
                "src/lib/models.ts(9,5): error TS2322".to_string()
            },
        }
    }

    fn commit(&self, _worktree: &Path, _message: &str) -> anyhow::Result<()> {
        self.record("commit");
        Ok(())
    }

    fn discard_changes(&self, _worktree: &Path) -> anyhow::Result<()> {
        self.record("discard");
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

/// 別名表の見直しセッションを演じる。指示を受け取り、1ターンで終える。
///
/// [`play_repair_agent`] と同じ作法。**実際に何を変えたかは演じない** ——
/// 触った範囲は `FakeOps::changed`、表の中身は worktree の実ファイルが持つ。
/// エージェントの言葉ではなく機械で見る、という設計をテスト側でもなぞっている。
async fn play_review_agent(server: &TestServer) {
    let card = wait_for_repair_card(server).await;
    let session = server.manager.get(card).expect("見直しセッションが居る");
    let mut watcher = common::Watcher::attach(&session);

    fire(server, &session, "SessionStart").await;
    // 見直しの指示が届いたことを確かめてから答える（修復の指示と取り違えない）
    watcher.wait_for("モデル別名表").await;
    fire(server, &session, "PreToolUse").await;
    fire(server, &session, "Stop").await;
}

/// 形の整った別名表。見直しの検査を通る最小の中身。
const SOUND_TABLE: &str = r#"
export const MODELS: ModelInfo[] = [
  { value: 'default', label: '既定', description: '指定を消す', fixed: false },
  { value: 'opus', label: 'Opus', description: '複雑な推論', fixed: true, family: 'opus' },
]
"#;

/// 別名表の見直しを1回走らせ、終わるまで待つ。
async fn run_review(server: &TestServer) {
    let selfheal = Arc::clone(server.selfheal.as_ref().expect("自己修復が居る"));
    let review = tokio::spawn(agentdashboard_core::selfheal::review_model_table(
        selfheal,
        "9.9.9".to_string(),
    ));
    play_review_agent(server).await;
    review.await.expect("見直しが終わること");
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
    // 実物と同じく「そのサンプルが読めるか」で合否が決まるようにする
    *ops.gate_follows_sample.lock().unwrap() = true;
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;
    let (_session, transcript) = start_watched(&server, &dir).await;

    append_records(&transcript, 3, "9.9.9", 0);

    // 修復役がサンプルを消してからターンを終える
    let sample = ops.sample_path();
    let card = wait_for_repair_card(&server).await;
    let session = server.manager.get(card).expect("修復セッションが居る");
    let mut watcher = common::Watcher::attach(&session);
    fire(&server, &session, "SessionStart").await;
    watcher.wait_for("挑戦 1/").await;
    std::fs::remove_file(&sample).expect("サンプルを消せること");
    fire(&server, &session, "PreToolUse").await;
    fire(&server, &session, "Stop").await;

    // 消したことに気づいて突き返す。**消した本人には戻せない**ので、こちらで戻す
    watcher.wait_for("こちらで元の内容に戻しました").await;
    assert!(sample.is_file(), "戻したと言いながら戻っていない");

    // 2回目は何もしないので、ゲートは回るが直っていない
    fire(&server, &session, "PreToolUse").await;
    fire(&server, &session, "Stop").await;
    wait_for_call(&ops, "changed", 2).await;

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

// ---- 別名表の見直し（設計§14）------------------------------------------------------
//
// この流れは**出荷まで一度も通していなかった**。画面側のゲートが worktree に無い
// node_modules を当てにしていて必ず落ちる、という不具合（コードレビュー B-1）に
// 気づけなかったのはそのため。棄却と採用の分岐をここで固定する。
//
// 起動時の契機（CLI の版が上がったとき）は擬似 claude では踏めない——`--version` を
// 答えないので版が空になり、`needs_review` が常に false になる。だから
// `review_model_table` を直接呼ぶ。

#[tokio::test]
async fn 別名表の見直しが通れば変更が採用される() {
    let dir = work_dir("review-adopt");
    let ops = FakeOps::new(&dir);
    ops.stage_review(SOUND_TABLE, &["web/src/lib/models.ts"]);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;

    run_review(&server).await;

    assert_eq!(ops.count("web-gate"), 1, "画面側のゲートを通ること");
    assert_eq!(ops.count("commit"), 1, "採用したらコミットすること");
    assert_eq!(ops.count("discard"), 0, "採用したのに戻してはいけない");
}

#[tokio::test]
async fn 範囲外を触っていたら戻して採用しない() {
    // 触ってよいのは表の1ファイルだけ（設計§14）。守られなかったら worktree ごと戻す
    let dir = work_dir("review-scope");
    let ops = FakeOps::new(&dir);
    ops.stage_review(
        SOUND_TABLE,
        &["web/src/lib/models.ts", "server/crates/protocol/src/lib.rs"],
    );
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;

    run_review(&server).await;

    assert_eq!(ops.count("discard"), 1, "範囲外を触ったら戻すこと");
    assert_eq!(ops.count("commit"), 0, "採用してはいけない");
    assert_eq!(
        ops.count("web-gate"),
        0,
        "範囲の検査で落ちたならゲートまで進まない"
    );
}

#[tokio::test]
async fn 表の形が壊れていたら戻して採用しない() {
    let dir = work_dir("review-shape");
    let ops = FakeOps::new(&dir);
    // 表ごと別物にされた状態
    ops.stage_review("export const OTHER = []\n", &["web/src/lib/models.ts"]);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;

    run_review(&server).await;

    assert_eq!(ops.count("discard"), 1, "形が壊れていたら戻すこと");
    assert_eq!(ops.count("commit"), 0, "採用してはいけない");
}

#[tokio::test]
async fn 画面側のゲートが落ちたら戻して採用しない() {
    // **B-1 が化けていた場所。** ここを通らないまま採用してしまうと、
    // 型が合わない表がそのまま入る
    let dir = work_dir("review-gate");
    let ops = FakeOps::new(&dir);
    ops.stage_review(SOUND_TABLE, &["web/src/lib/models.ts"]);
    *ops.web_gate_passes.lock().unwrap() = false;
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;

    run_review(&server).await;

    assert_eq!(ops.count("web-gate"), 1, "ゲートは走ること");
    assert_eq!(ops.count("discard"), 1, "落ちたら戻すこと");
    assert_eq!(ops.count("commit"), 0, "採用してはいけない");
}

#[tokio::test]
async fn 変えるものが無ければゲートもコミットも走らない() {
    // 「変更不要」は失敗ではない。無理に何かさせないのが設計の意図
    let dir = work_dir("review-nochange");
    let ops = FakeOps::new(&dir);
    ops.stage_review(SOUND_TABLE, &[]);
    let server = TestServer::start_with_selfheal(config_for(&dir), ops.clone()).await;

    run_review(&server).await;

    assert_eq!(ops.count("web-gate"), 0);
    assert_eq!(ops.count("commit"), 0);
    assert_eq!(ops.count("discard"), 0, "触っていないものを戻す必要はない");
}
