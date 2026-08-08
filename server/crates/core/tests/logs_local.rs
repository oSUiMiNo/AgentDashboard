//! ローカルモードでログが引けること（ログ設計§13-1、テスト計画 フェーズ3「別 PC のログを引く」）。
//!
//! # なぜ `session-host-core` の単体テストだけでは足りないのか
//!
//! あちらが確かめているのは**切り出し方の決まり**（上限・伏せる・grep の当て先）で、
//! ここが確かめるのは**境界を通ること**である。`SessionHost::read_log` は
//! 「サーバ側から見た PC 側」の口で、ローカルモードではその実装が同じプロセスの中を向く。
//!
//! ここが通らないと、サーバ側で「ローカルなら自分で読む」という近道を書きたくなる——
//! それをやると「ローカルでは動くのにセルフホストで欠ける」という、経路の違いが原因で
//! テストを増やしても見つからない壊れ方が残る（`hostfs.rs` の冒頭と同じ理由）。

#![allow(non_snake_case)]

use agentdashboard_core::local::LocalSessionHost;
use server_core::session_host::{HostAskError, HostAskRequest, SessionHost};
use session_host_core::{config::SessionHostConfig, session::SessionManager};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 使い捨ての状態の置き場所。**実運用の場所を触らない。**
struct Sandbox(PathBuf);

impl Sandbox {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "agentdashboard-local-logs-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("作業場所を作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// `<state_dir>/logs/` へ1本置く。
    fn place(&self, name: &str, body: &str) {
        let dir = self.0.join("logs");
        std::fs::create_dir_all(&dir).expect("作れること");
        std::fs::write(dir.join(name), body).expect("書けること");
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// PTY を1つも起こさずに口だけ作る。**このテストはセッションを必要としない。**
fn host(sandbox: &Sandbox) -> LocalSessionHost {
    let config = SessionHostConfig {
        state_dir: Some(sandbox.path().to_path_buf()),
        ..Default::default()
    };
    LocalSessionHost::new(SessionManager::new(Arc::new(config)))
}

fn ask() -> HostAskRequest {
    HostAskRequest {
        account_id: uuid::Uuid::new_v4(),
        // ローカルモードには PC という単位が無い（設計§19）
        target: None,
    }
}

fn query() -> protocol::logs::LogQuery {
    protocol::logs::LogQuery {
        since: "2026-01-01T00:00:00.000Z".to_string(),
        level: "TRACE".to_string(),
        card: None,
        proc: None,
        grep: None,
        grep_on_raw: false,
        sanitize: false,
    }
}

fn record(ts: &str, msg: &str) -> String {
    format!(
        r#"{{"ts":"{ts}","level":"INFO","target":"t","proc":"dashboard","pid":1,"run_id":"r","msg":"{msg}"}}"#
    )
}

#[tokio::test]
async fn ローカルモードでも境界を通ってログが引ける() {
    let sandbox = Sandbox::new("ok");
    let one = record("2026-08-08T00:00:00.000Z", "ひとつめ");
    sandbox.place("dashboard-1.2026-08-08.jsonl", &format!("{one}\n"));

    let chunk = host(&sandbox)
        .read_log(ask(), &query())
        .await
        .expect("引けること");
    assert_eq!(chunk.lines, vec![one]);
    // **埋めるのは REST の口。** 境界の向こうは自分がどう呼ばれたかを知らない
    assert_eq!(chunk.host, "");
    assert!(!chunk.host_now.is_empty());
}

#[tokio::test]
async fn 置き場所が無いときは理由が説明として返る() {
    // ローカルが作るのは `Failed` だけ（線を跨がないので、届かなかったことを表す
    // 残りの理由は起こりえない）。**空の答えにしない**
    let sandbox = Sandbox::new("missing");
    let err = host(&sandbox)
        .read_log(ask(), &query())
        .await
        .expect_err("断ること");
    match err {
        HostAskError::Failed { reason, detail } => {
            assert_eq!(reason, protocol::a2s::HostFailure::NotFound);
            assert!(detail.contains("置き場所がありません"), "{detail}");
        }
        other => panic!("Failed であること: {other:?}"),
    }
}

#[tokio::test]
async fn ローカルモードで宛先を指名されたら断る() {
    // 黙って無視すると `/api/hosts/<でたらめ>/logs` が手元のログを返すことになり、
    // **口の意味が構成によって変わる**（`hostfs` と同じ判断）
    let sandbox = Sandbox::new("target");
    sandbox.place(
        "dashboard-1.2026-08-08.jsonl",
        &format!(
            "{}\n",
            record("2026-08-08T00:00:00.000Z", "見えてはいけない")
        ),
    );

    let asked = HostAskRequest {
        target: Some(protocol::AgentId::new()),
        ..ask()
    };
    let err = host(&sandbox)
        .read_log(asked, &query())
        .await
        .expect_err("断ること");
    // 知らない PC と同じ言葉。綴りを変えて探る余地を残さない
    assert_eq!(err, HostAskError::UnknownHost);
}
